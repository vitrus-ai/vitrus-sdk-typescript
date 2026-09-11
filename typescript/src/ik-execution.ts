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
    };
  } | null;
};

export type DeviceIkObservation = {
  status: DeviceIkExecutionStatus;
  /** Local monotonic time; do not compare it with the robot's monotonic clock. */
  receivedAtMs: number;
  roundTripMs: number;
};

/** Keep the job heartbeat running independently while inspecting execution. */
export async function readDeviceIkExecution(client: MotionJobClient): Promise<DeviceIkObservation> {
  const started = performance.now();
  const status = await client.request<DeviceIkExecutionStatus>("/api/dora/ik/status", undefined, "GET", 500);
  const receivedAtMs = performance.now();
  return { status, receivedAtMs, roundTripMs: receivedAtMs - started };
}

/** A solver's "converged" result alone never establishes physical completion. */
export function measuredIkGoalReached(
  observation: DeviceIkObservation,
  expected: { jobId: string; inputSequence: number; commandId?: number },
): boolean {
  const status = observation.status;
  const output = status?.last_output;
  const proof = output?.execution;
  const clientAge = performance.now() - observation.receivedAtMs;
  const sourceAge = proof?.feedback_age_ms;
  // Adding the whole round trip conservatively covers network transit without
  // assuming synchronized workstation and robot clocks. A retained observation
  // also ages locally, so an old successful result cannot be reused forever.
  const ageBound = typeof sourceAge === "number" ? sourceAge + observation.roundTripMs + clientAge : Infinity;
  return Boolean(
    expected.jobId && Number.isSafeInteger(expected.inputSequence) && expected.inputSequence > 0
    && status?.ok === true && status.tracking === true && !status.last_error && status.stream?.active === true
    && output?.job_id === expected.jobId && output.input_sequence === expected.inputSequence
    && (expected.commandId === undefined || output.command_id === expected.commandId)
    && proof?.schema === "vitrus.ik.execution.v1" && proof.state === "settled"
    && proof.measured_goal_reached === true && proof.feedback_fresh === true && proof.plan_applied === true
    && Number.isFinite(sourceAge) && (sourceAge as number) >= 0
    && Number.isFinite(observation.roundTripMs) && observation.roundTripMs >= 0
    && Number.isFinite(clientAge) && clientAge >= 0 && ageBound <= 300
  );
}
