/**
 * V2 Edge motion jobs.
 *
 * The client never receives the broker lease. It only holds a job id and
 * epoch; the Edge-local Motion Supervisor owns realtime authority, renewal,
 * deadlines and release. Device IK and client-side IK joint trajectories use
 * the same job/safety boundary.
 */

import type { ControlJointTarget } from "./contracts.js";

export type MotionMode = "device_ik" | "joint_trajectory" | "direct_joint";
export type MotionJobState = "stopped" | "preflight" | "primed" | "armed" | "running" | "holding" | "stopping" | "fault_latched";

export type MotionJob = {
  job_id: string;
  epoch: number;
  mode: MotionMode;
  state: MotionJobState;
  joint_names: string[];
  configuration_revision: string;
  effective_urdf_sha256?: string | null;
  model_epoch?: number | null;
  last_sequence: number;
  terminal_reason?: string | null;
};

export type MotionErrorPayload = {
  ok: false;
  error: string;
  code: string;
  domain: string;
  retryable: boolean;
  trace_id?: string;
  cause?: string;
};

export class MotionControlError extends Error {
  constructor(
    readonly payload: MotionErrorPayload,
    readonly status: number,
  ) {
    super(`${payload.code}: ${payload.error}`);
    this.name = "MotionControlError";
  }
}

export type MotionJobStartOptions = {
  mode: MotionMode;
  owner: string;
  jointNames: string[];
  jobId?: string;
  configurationRevision?: string;
  clientLivenessMs?: number;
};

export type DeviceIkPoint = {
  position_m: [number, number, number];
  orientation_xyzw: [number, number, number, number];
  time_from_start_ms?: number;
};

export type MotionJobClientOptions = {
  endpoint: string;
  robotId: string;
  requestTimeoutMs?: number;
  /** Bounded separately because acquire + complete measured-pose prime runs once. */
  startTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

type FetchRequest = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => Promise<Response>;

type StartResponse = { ok: true; job: MotionJob; trace_id?: string };
type UpdateResponse = { ok: true; job: MotionJob; result: Record<string, unknown>; trace_id?: string };
type HeartbeatResponse = { ok: true; job: MotionJob; trace_id?: string };
type StopResponse = { ok: true; stopped: boolean; superseded?: boolean; job?: MotionJob; trace_id?: string };

export class MotionJobClient {
  private readonly endpoint: string;
  private readonly fetchImpl: FetchRequest;

  constructor(private readonly options: MotionJobClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    if (!this.endpoint) throw new Error("MotionJobClient requires endpoint");
    if (!options.robotId.trim()) throw new Error("MotionJobClient requires robotId");
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async startJob(options: MotionJobStartOptions): Promise<MotionJobSession> {
    const names = normalizeScope(options.jointNames);
    const result = await this.request<StartResponse>("/api/v2/motion/start", {
      robot_id: this.options.robotId,
      mode: options.mode,
      owner: requiredText(options.owner, "owner"),
      joint_names: names,
      ...(options.jobId ? { job_id: requiredText(options.jobId, "jobId") } : {}),
      ...(options.configurationRevision ? { configuration_revision: options.configurationRevision } : {}),
      ...(options.clientLivenessMs == null ? {} : { client_liveness_ms: options.clientLivenessMs }),
    }, "POST", this.options.startTimeoutMs ?? 20_000);
    return new MotionJobSession(this, result.job);
  }

  async status(): Promise<{ ok: true; service: string; job: MotionJob | null; events: Array<Record<string, unknown>> }> {
    return this.request("/api/v2/motion/status", undefined, "GET");
  }

  async safetyStop(reason = "operator_stop"): Promise<Record<string, unknown>> {
    return this.request("/api/v2/safety/stop", { reason: requiredText(reason, "reason") });
  }

  async request<T>(path: string, body?: Record<string, unknown>, method: "GET" | "POST" = "POST", timeoutMs = this.options.requestTimeoutMs ?? 5_000): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const traceId = createTraceId();
    try {
      const response = await this.fetchImpl(`${this.endpoint}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-vitrus-trace-id": traceId },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as MotionErrorPayload | T | null;
      if (!response.ok) {
        const error = isMotionErrorPayload(payload)
          ? payload
          : { ok: false as const, error: response.statusText || "motion request failed", code: "MOTION_TRANSPORT_ERROR", domain: "transport", retryable: response.status >= 500, trace_id: traceId };
        throw new MotionControlError(error, response.status);
      }
      if (!payload || typeof payload !== "object") {
        throw new MotionControlError({ ok: false, error: "motion service returned invalid JSON", code: "MOTION_INVALID_RESPONSE", domain: "transport", retryable: true, trace_id: traceId }, 502);
      }
      return payload as T;
    } catch (error) {
      if (error instanceof MotionControlError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new MotionControlError({ ok: false, error: `motion request timed out after ${timeoutMs} ms`, code: "MOTION_REQUEST_TIMEOUT", domain: "transport", retryable: true, trace_id: traceId }, 504);
      }
      throw new MotionControlError({ ok: false, error: error instanceof Error ? error.message : String(error), code: "MOTION_TRANSPORT_ERROR", domain: "transport", retryable: true, trace_id: traceId }, 503);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class MotionJobSession {
  private sequence: number;
  private stopped = false;

  constructor(private readonly client: MotionJobClient, private job: MotionJob) {
    this.sequence = job.last_sequence;
  }

  get id(): string { return this.job.job_id; }
  get epoch(): number { return this.job.epoch; }
  get state(): MotionJobState { return this.job.state; }
  get configurationRevision(): string { return this.job.configuration_revision; }
  get jointNames(): readonly string[] { return this.job.joint_names; }

  async updateJointTargets(targets: ControlJointTarget[], options: { ttlMs?: number } = {}): Promise<Record<string, unknown>> {
    this.requireActive();
    if (this.job.mode === "device_ik") throw new Error("device_ik jobs require updateDeviceIk");
    validateFullScope(targets, this.job.joint_names);
    const result = await this.client.request<UpdateResponse>("/api/v2/motion/update", {
      job_id: this.job.job_id,
      epoch: this.job.epoch,
      sequence: ++this.sequence,
      targets,
      ...(options.ttlMs == null ? {} : { ttl_ms: options.ttlMs }),
    });
    this.job = result.job;
    return result.result;
  }

  async updateDeviceIk(input: {
    chain: string;
    points: DeviceIkPoint[];
    ttlMs?: number;
    taskMode?: string;
    /** All chains covered by this immutable device-IK job. */
    controlledChains?: string[];
    /** Explicit Edge alignment profile selector, when provisioned. */
    alignmentProfile?: string;
  }): Promise<Record<string, unknown>> {
    this.requireActive();
    if (this.job.mode !== "device_ik") throw new Error("joint trajectory jobs require updateJointTargets");
    if (!input.points.length) throw new Error("device IK update requires points");
    const result = await this.client.request<UpdateResponse>("/api/v2/motion/update", {
      job_id: this.job.job_id,
      epoch: this.job.epoch,
      sequence: ++this.sequence,
      chain: requiredText(input.chain, "chain"),
      points: input.points,
      ...(input.ttlMs == null ? {} : { ttl_ms: input.ttlMs }),
      ...(input.taskMode == null ? {} : { task_mode: input.taskMode }),
      ...(input.controlledChains == null ? {} : { controlled_chains: normalizeScope(input.controlledChains) }),
      ...(input.alignmentProfile == null ? {} : { alignment_profile: requiredText(input.alignmentProfile, "alignmentProfile") }),
    });
    this.job = result.job;
    return result.result;
  }

  async heartbeat(): Promise<void> {
    this.requireActive();
    const result = await this.client.request<HeartbeatResponse>("/api/v2/motion/heartbeat", { job_id: this.job.job_id, epoch: this.job.epoch });
    this.job = result.job;
  }

  async stop(reason = "client_stop"): Promise<void> {
    if (this.stopped) return;
    try {
      const result = await this.client.request<StopResponse>("/api/v2/motion/stop", { job_id: this.job.job_id, epoch: this.job.epoch, reason });
      if (result.job) this.job = result.job;
      this.stopped = true;
    } catch (error) {
      // A confirmed terminal state is idempotent success. Transport failures
      // remain retryable so callers can still request the safety boundary.
      if (error instanceof MotionControlError && error.payload.code === "SESSION_ENDED") {
        this.stopped = true;
        return;
      }
      throw error;
    }
  }

  private requireActive(): void {
    if (this.stopped) throw new Error("motion job session is already stopped");
  }
}

function requiredText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function normalizeScope(names: string[]): string[] {
  const scope = names.map(name => requiredText(name, "jointNames[]"));
  if (!scope.length || new Set(scope).size !== scope.length) throw new Error("jointNames must be a unique non-empty scope");
  return scope;
}

function validateFullScope(targets: ControlJointTarget[], scope: readonly string[]): void {
  if (!targets.length) throw new Error("joint targets are required");
  const names = targets.map(target => requiredText(target.joint_name, "target.joint_name"));
  if (new Set(names).size !== names.length) throw new Error("joint targets must be unique");
  if (names.length !== scope.length || names.some(name => !scope.includes(name))) {
    throw new Error("joint targets must cover the immutable job scope exactly");
  }
}

function isMotionErrorPayload(value: unknown): value is MotionErrorPayload {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).ok === false && typeof (value as Record<string, unknown>).code === "string" && typeof (value as Record<string, unknown>).error === "string");
}

function createTraceId(): string {
  const random = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  return random ? random() : `motion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
