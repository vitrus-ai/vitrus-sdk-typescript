/** Encoder-qualified IK completion. This module only reads; it never renews authority. */
import type { MotionJobClient } from "./motion-job.js";

export type DeviceIkExecutionStatus = {
  ok?: boolean;
  tracking?: boolean;
  last_error?: string | null;
  stream?: { active?: boolean };
  last_output?: {
    job_id?: string;
    input_sequence?: number;
    command_id?: number;
    solver_status?: string;
    execution?: {
      schema?: string;
      state?: string;
      measured_goal_reached?: boolean;
      feedback_fresh?: boolean;
      plan_applied?: boolean;
      feedback_age_ms?: number | null;
      stalled?: boolean;
      stalled_chains?: string[];
    };
  } | null;
};

export type DeviceIkObservation = {
  status: DeviceIkExecutionStatus;
  /** Local monotonic time; do not compare it with the robot's monotonic clock. */
  receivedAtMs: number;
  roundTripMs: number;
};

export type ExpectedDeviceIkExecution = { jobId: string; inputSequence: number; commandId?: number };
export type DeviceIkExecutionReader = Pick<MotionJobClient, "request">;

export type MeasuredIkGoalWaitOptions = {
  /** Entire local observation budget, including each read and poll wait. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
};

export type MeasuredIkGoalOutcome = {
  outcome: "reached" | "stalled" | "native_error" | "inactive_or_identity_mismatch" | "observation_timeout" | "aborted";
  observation?: DeviceIkObservation;
  error?: unknown;
};

/** Keep the job heartbeat running independently while inspecting execution. */
export async function readDeviceIkExecution(client: DeviceIkExecutionReader): Promise<DeviceIkObservation> {
  const started = performance.now();
  const status = await client.request<DeviceIkExecutionStatus>("/api/dora/ik/status", undefined, "GET", 500);
  const receivedAtMs = performance.now();
  return { status, receivedAtMs, roundTripMs: receivedAtMs - started };
}

function validExpectedIdentity(expected: ExpectedDeviceIkExecution): boolean {
  return Boolean(expected.jobId
    && Number.isSafeInteger(expected.inputSequence) && expected.inputSequence > 0
    && (expected.commandId === undefined || (Number.isSafeInteger(expected.commandId) && expected.commandId > 0)));
}

function exactIdentity(observation: DeviceIkObservation, expected: ExpectedDeviceIkExecution): boolean {
  const output = observation.status?.last_output;
  return Boolean(validExpectedIdentity(expected)
    && output?.job_id === expected.jobId && output.input_sequence === expected.inputSequence
    && (expected.commandId === undefined || output.command_id === expected.commandId));
}

function qualifiedPhysicalEvidence(observation: DeviceIkObservation, expected: ExpectedDeviceIkExecution): boolean {
  const status = observation.status;
  const proof = status?.last_output?.execution;
  const clientAge = performance.now() - observation.receivedAtMs;
  const sourceAge = proof?.feedback_age_ms;
  // Adding the whole round trip conservatively covers network transit without
  // assuming synchronized workstation and robot clocks. A retained observation
  // also ages locally, so an old result cannot be reused forever.
  const ageBound = typeof sourceAge === "number" ? sourceAge + observation.roundTripMs + clientAge : Infinity;
  return Boolean(
    exactIdentity(observation, expected)
    && status?.ok === true && status.tracking === true && !status.last_error && status.stream?.active === true
    && proof?.schema === "vitrus.ik.execution.v1" && proof.feedback_fresh === true && proof.plan_applied === true
    && Number.isFinite(sourceAge) && (sourceAge as number) >= 0
    && Number.isFinite(observation.roundTripMs) && observation.roundTripMs >= 0
    && Number.isFinite(clientAge) && clientAge >= 0 && ageBound <= 300,
  );
}

/** A solver's "converged" result alone never establishes physical completion. */
export function measuredIkGoalReached(observation: DeviceIkObservation, expected: ExpectedDeviceIkExecution): boolean {
  const proof = observation.status?.last_output?.execution;
  return Boolean(qualifiedPhysicalEvidence(observation, expected)
    && proof?.state === "settled" && proof.measured_goal_reached === true);
}

/** Requires the native monitor's qualified, exact-identity no-progress result. */
export function measuredIkGoalStalled(observation: DeviceIkObservation, expected: ExpectedDeviceIkExecution): boolean {
  const proof = observation.status?.last_output?.execution;
  return Boolean(qualifiedPhysicalEvidence(observation, expected)
    && proof?.state === "stalled" && proof.stalled === true);
}

function validDuration(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(`${label} must be a finite positive number`);
  return resolved;
}

function cancellableDelay(delayMs: number, signal?: AbortSignal): { promise: Promise<"elapsed" | "aborted">; cancel(): void } {
  let finish: ((result: "elapsed" | "aborted") => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => finish?.("aborted");
  const promise = new Promise<"elapsed" | "aborted">(resolve => {
    const settle = (result: "elapsed" | "aborted") => {
      if (!finish) return;
      finish = undefined;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    finish = settle;
    if (signal?.aborted) return settle("aborted");
    timer = setTimeout(() => settle("elapsed"), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, cancel: () => finish?.("elapsed") };
}

function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<"elapsed" | "aborted"> {
  return cancellableDelay(delayMs, signal).promise;
}

/**
 * Observe an already-admitted exact IK input until measured reach, qualified
 * native stall, a terminal status, abort, or local observation deadline.
 * This never sends a heartbeat, changes a lease, or performs any motion call.
 */
export async function waitForMeasuredIkGoal(
  client: DeviceIkExecutionReader,
  expected: ExpectedDeviceIkExecution,
  options: MeasuredIkGoalWaitOptions = {},
): Promise<MeasuredIkGoalOutcome> {
  if (!validExpectedIdentity(expected)) {
    throw new Error("expected jobId, positive inputSequence, and optional positive commandId are required");
  }
  const timeoutMs = validDuration(options.timeoutMs, 3_000, "timeoutMs");
  const pollIntervalMs = validDuration(options.pollIntervalMs, 100, "pollIntervalMs");
  const deadline = performance.now() + timeoutMs;
  let lastObservation: DeviceIkObservation | undefined;
  let lastError: unknown;

  while (true) {
    if (options.signal?.aborted) return { outcome: "aborted", observation: lastObservation, error: lastError };
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { outcome: "observation_timeout", observation: lastObservation, error: lastError };

    // Handle rejection before racing so a read that completes after the whole
    // deadline is never an unhandled promise rejection or followed by a read.
    const read = readDeviceIkExecution(client).then(
      observation => ({ kind: "observation" as const, observation }),
      error => ({ kind: "error" as const, error }),
    );
    const deadlineBranch = cancellableDelay(remaining, options.signal);
    let bounded: Awaited<typeof read> | { readonly kind: "elapsed" | "aborted" };
    try {
      bounded = await Promise.race([
        read,
        deadlineBranch.promise.then(result => ({ kind: result } as const)),
      ]);
    } finally {
      // A successful or failed read must release this race's timer/listener;
      // cancellation never touches the caller-owned AbortSignal itself.
      deadlineBranch.cancel();
    }
    if (bounded.kind === "aborted") return { outcome: "aborted", observation: lastObservation, error: lastError };
    if (bounded.kind === "elapsed") return { outcome: "observation_timeout", observation: lastObservation, error: lastError };
    if (bounded.kind === "error") {
      lastError = bounded.error;
    } else if (bounded.kind === "observation") {
      const observation = bounded.observation;
      lastObservation = observation;
      const status = observation.status;
      if (!exactIdentity(observation, expected)
          || status?.ok !== true || status.tracking !== true || status.stream?.active !== true) {
        return { outcome: "inactive_or_identity_mismatch", observation };
      }
      // An unrelated predecessor's fault must not be attributed to this exact
      // job/input. Identity and active-stream checks deliberately precede it.
      if (status.last_error) return { outcome: "native_error", observation };
      if (measuredIkGoalReached(observation, expected)) return { outcome: "reached", observation };
      if (measuredIkGoalStalled(observation, expected)) return { outcome: "stalled", observation };
    }

    const pause = Math.min(pollIntervalMs, Math.max(0, deadline - performance.now()));
    if (pause <= 0) return { outcome: "observation_timeout", observation: lastObservation, error: lastError };
    if (await waitForDelay(pause, options.signal) === "aborted") {
      return { outcome: "aborted", observation: lastObservation, error: lastError };
    }
  }
}
