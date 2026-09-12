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
export type MotionIntentMode = "continuous_setpoint" | "execute_goal";
/** `active` and `hold` are native direct-session states; older Edge jobs use running/holding. */
export type MotionJobState = "stopped" | "preflight" | "primed" | "armed" | "running" | "holding" | "active" | "hold" | "stopping" | "fault_latched";

export type MotionJob = {
  job_id: string;
  epoch: number;
  mode: MotionMode;
  state: MotionJobState;
  joint_names: string[];
  /** Immutable servo-only subset controlled alongside native Cartesian IK. */
  auxiliary_joint_names?: string[];
  configuration_revision: string;
  effective_urdf_sha256?: string | null;
  model_epoch?: number | null;
  last_sequence: number;
  last_dispatched_sequence?: number;
  /** Correlates an async intent sequence with the device IK command. */
  last_dispatched_command_id?: number | null;
  intent_mode?: MotionIntentMode;
  target_liveness_ms?: number;
  target_pending?: boolean;
  /** The device IK owner has positively confirmed a live stream. */
  ik_stream_confirmed?: boolean;
  coalesced_target_count?: number;
  target_hold_active?: boolean;
  last_ik_error?: string | null;
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
  /** Optional servo-only subset of jointNames. Available for device_ik jobs. */
  auxiliaryJointNames?: string[];
  jobId?: string;
  configurationRevision?: string;
  clientLivenessMs?: number;
  /** Teleoperation source behavior after target updates become stale. */
  intentMode?: MotionIntentMode;
  /** Independent freshness budget for device-IK setpoints. */
  targetLivenessMs?: number;
};

export type DeviceIkPoint = {
  position_m: [number, number, number];
  /** Omit for a translation-only target, as the TCP UI does for arrows/sliders. */
  orientation_xyzw?: [number, number, number, number];
  time_from_start_ms?: number;
};

export type DeviceIkUpdateOptions = {
  chain: string;
  points: DeviceIkPoint[];
  ttlMs?: number;
  /** Continuous teleoperation freezes at the last safe Edge target when stale. */
  intentMode?: MotionIntentMode;
  targetLivenessMs?: number;
  taskMode?: string;
  /** All chains covered by this immutable device-IK job. */
  controlledChains?: string[];
  /** Explicit Edge alignment profile selector, when provisioned. */
  alignmentProfile?: string;
  /** Complete declared auxiliary scope; omission retains its latest hold. */
  auxiliaryJointTargets?: AuxiliaryJointTarget[];
};

export type AuxiliaryJointTarget = {
  joint_name: string;
  /** Calibrated model degrees, checked against canonical limits on Edge. */
  position_deg: number;
  /** Positive estimate-based load cap, at most 0.35 Nm; defaults to 0.35. */
  max_torque_nm?: number;
  /** Positive speed limit, at most 5 degrees/s; defaults to 5. */
  velocity_deg_s?: number;
};

/** One device-IK frame: no arm is lost by alternating single-chain edits. */
export type DeviceIkFrameOptions = Omit<DeviceIkUpdateOptions, "chain" | "points" | "taskMode"> & {
  controlledChains: string[];
  targets: Array<{ chain: string; points: DeviceIkPoint[]; taskMode?: "position_only" | "pose" }>;
  /**
   * Original application ingress time for a continuous Cartesian frame.
   * When supplied, the authenticated Edge uses it to reject a delayed frame
   * before it can replace its native pending target. Legacy callers may omit it.
   */
  clientCreatedAtMs?: number;
  /** Force one full-frame correlated Edge receipt without changing telemetry setup. */
  delivery?: "confirmed" | "latest";
};

export type JointParkOptions = {
  /** Complete immutable job scope, in calibrated model degrees. */
  targets: Array<{ joint_name: string; position_deg: number }>;
  /** Quintic trajectory peak velocity; positive and no more than 5 deg/s. */
  maxVelocityDegS?: number;
  /** Measured completion tolerance, positive and no more than 2 degrees. */
  toleranceDeg?: number;
};

export type MotionJobClientOptions = {
  endpoint: string;
  robotId: string;
  requestTimeoutMs?: number;
  /** Bounded separately because acquire + complete measured-pose prime runs once. */
  startTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

export type MotionHeartbeatOptions = {
  /**
   * A browser/session watchdog should fail a single renewal quickly enough to
   * retry before the Edge-side fallback liveness window expires. This does
   * not alter the broker's independent physical deadman.
   */
  timeoutMs?: number;
};

/** Narrow client boundary consumed by the shared session implementation. */
export type MotionJobTransport = {
  request<T>(path: string, body?: Record<string, unknown>, method?: "GET" | "POST", timeoutMs?: number): Promise<T>;
  /** Request a correlated update even when this transport also offers latest-only publication. */
  requestConfirmed?<T>(path: string, body?: Record<string, unknown>, method?: "GET" | "POST", timeoutMs?: number): Promise<T>;
  status(): Promise<{ ok: true; job: MotionJob | null; service?: string; events?: Array<Record<string, unknown>> }>;
  /** Optional nonblocking, authenticated latest-only frame admission. */
  publishLatestUpdate?(body: Record<string, unknown>, timeoutMs?: number): Record<string, unknown>;
  supportsLatestUpdates?: boolean;
  /** Ensure no asynchronous latest frame remains before a lifecycle command. */
  drainLatestUpdates?(): Promise<void>;
  /** Drop a locally unsent latest frame before a terminal lifecycle command. */
  discardLatestUpdates?(): void;
};

type FetchRequest = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => Promise<Response>;

type StartResponse = { ok: true; job: MotionJob; trace_id?: string };
type EdgeTiming = { edge_received_at_ms?: number; edge_handler_ms?: number };
type UpdateResponse = { ok: true; job: MotionJob; result: Record<string, unknown>; trace_id?: string; timing?: EdgeTiming };
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
    const auxiliaryNames = options.auxiliaryJointNames === undefined ? undefined : normalizeScope(options.auxiliaryJointNames);
    if (auxiliaryNames !== undefined && (options.mode !== "device_ik" || auxiliaryNames.some(name => !names.includes(name)))) {
      throw new Error("auxiliaryJointNames requires a device_ik job and must be a subset of jointNames");
    }
    const result = await this.request<StartResponse>("/api/v2/motion/start", {
      robot_id: this.options.robotId,
      mode: options.mode,
      owner: requiredText(options.owner, "owner"),
      joint_names: names,
      ...(auxiliaryNames === undefined ? {} : { auxiliary_joint_names: auxiliaryNames }),
      ...(options.jobId ? { job_id: requiredText(options.jobId, "jobId") } : {}),
      ...(options.configurationRevision ? { configuration_revision: options.configurationRevision } : {}),
      ...(options.clientLivenessMs == null ? {} : { client_liveness_ms: options.clientLivenessMs }),
      ...(options.intentMode == null ? {} : { intent_mode: options.intentMode }),
      ...(options.targetLivenessMs == null ? {} : { target_liveness_ms: options.targetLivenessMs }),
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
        throw new MotionControlError({ ok: false, error: `${method} ${path}: motion request timed out after ${timeoutMs} ms (trace ${traceId})`, code: "MOTION_REQUEST_TIMEOUT", domain: "transport", retryable: true, trace_id: traceId }, 504);
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

  constructor(private readonly client: MotionJobTransport, private job: MotionJob) {
    this.sequence = job.last_sequence;
  }

  get id(): string { return this.job.job_id; }
  get epoch(): number { return this.job.epoch; }
  get state(): MotionJobState { return this.job.state; }
  get configurationRevision(): string { return this.job.configuration_revision; }
  get jointNames(): readonly string[] { return this.job.joint_names; }
  get auxiliaryJointNames(): readonly string[] { return this.job.auxiliary_joint_names ?? []; }

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

  async updateDeviceIk(input: DeviceIkUpdateOptions): Promise<Record<string, unknown>> {
    this.requireActive();
    if (this.job.mode !== "device_ik") throw new Error("joint trajectory jobs require updateJointTargets");
    if (!input.points.length) throw new Error("device IK update requires points");
    const auxiliaryTargets = input.auxiliaryJointTargets === undefined
      ? undefined
      : validateAuxiliaryTargets(input.auxiliaryJointTargets, this.job.auxiliary_joint_names ?? []);
    const result = await this.client.request<UpdateResponse>("/api/v2/motion/update", {
      job_id: this.job.job_id,
      epoch: this.job.epoch,
      sequence: ++this.sequence,
      chain: requiredText(input.chain, "chain"),
      // The native solver selects full-pose IK when a quaternion is present.
      // Honor explicit translation intent even if a caller passes a complete
      // pose copied from telemetry or a 3D transform.
      points: input.taskMode === "position_only"
        ? input.points.map(({ orientation_xyzw: _orientation, ...point }) => point)
        : input.points,
      ...(input.ttlMs == null ? {} : { ttl_ms: input.ttlMs }),
      ...(input.intentMode == null ? {} : { intent_mode: input.intentMode }),
      ...(input.targetLivenessMs == null ? {} : { target_liveness_ms: input.targetLivenessMs }),
      ...(input.taskMode == null ? {} : { task_mode: input.taskMode }),
      ...(input.controlledChains == null ? {} : { controlled_chains: normalizeScope(input.controlledChains) }),
      ...(input.alignmentProfile == null ? {} : { alignment_profile: requiredText(input.alignmentProfile, "alignmentProfile") }),
      ...(auxiliaryTargets === undefined ? {} : { auxiliary_joint_targets: auxiliaryTargets }),
    });
    this.job = result.job;
    // Keep the accepted command contract intact while exposing the Edge
    // ingress timestamp to application telemetry for end-to-end correlation.
    return {
      ...result.result,
      ...(result.trace_id ? { trace_id: result.trace_id } : {}),
      ...(result.timing ? { edge_timing: result.timing } : {}),
    };
  }

  async updateDeviceIkFrame(input: DeviceIkFrameOptions): Promise<Record<string, unknown>> {
    this.requireActive();
    if (this.job.mode !== "device_ik") throw new Error("device IK frames require a device_ik job");
    const scope = normalizeScope(input.controlledChains);
    if (!Array.isArray(input.targets) || (!input.targets.length && !input.auxiliaryJointTargets?.length) || input.targets.length > 8) throw new Error("frame requires up to 8 chain targets or explicit auxiliary targets");
    const seen = new Set<string>();
    const targets = input.targets.map(target => {
      const chain = requiredText(target.chain, "target.chain");
      if (!scope.includes(chain) || seen.has(chain)) throw new Error("frame target chains must be a unique subset of controlledChains");
      seen.add(chain);
      if (!Array.isArray(target.points) || !target.points.length) throw new Error("each frame chain requires points");
      return { chain, points: target.points.map(point => {
        if (!Array.isArray(point.position_m) || point.position_m.length !== 3 || !point.position_m.every(Number.isFinite)) throw new Error("frame positions must be finite XYZ");
        const orientation = target.taskMode === "position_only" ? undefined : point.orientation_xyzw;
        if (orientation !== undefined && (!Array.isArray(orientation) || orientation.length !== 4 || !orientation.every(Number.isFinite) || Math.hypot(...orientation) < 1e-9)) throw new Error("frame orientations must be finite nonzero XYZW");
        return { position_m: [...point.position_m], ...(orientation ? { orientation_xyzw: [...orientation] } : {}), ...(point.time_from_start_ms === undefined ? {} : { time_from_start_ms: point.time_from_start_ms }) };
      }) };
    });
    const auxiliary = input.auxiliaryJointTargets === undefined ? undefined : validateAuxiliaryTargets(input.auxiliaryJointTargets, this.auxiliaryJointNames);
    if (input.delivery !== undefined && input.delivery !== "confirmed" && input.delivery !== "latest") {
      throw new Error("frame delivery must be confirmed or latest");
    }
    const body = {
      job_id: this.id, epoch: this.job.epoch, sequence: ++this.sequence,
      chain_targets: targets, controlled_chains: scope,
      ...(input.ttlMs === undefined ? {} : { ttl_ms: input.ttlMs }),
      ...(input.intentMode === undefined ? {} : { intent_mode: input.intentMode }),
      ...(input.targetLivenessMs === undefined ? {} : { target_liveness_ms: input.targetLivenessMs }),
      ...(input.alignmentProfile === undefined ? {} : { alignment_profile: input.alignmentProfile }),
      ...(auxiliary === undefined ? {} : { auxiliary_joint_targets: auxiliary }),
      // This is authenticated public transport metadata, not a native IK
      // coordinate. Edge validates a supplied timestamp before accepting a
      // continuous frame into its pending mailbox. Omission preserves legacy
      // correlated update compatibility.
      ...(input.clientCreatedAtMs !== undefined
        ? { client_created_at_ms: validClientCreatedAtMs(input.clientCreatedAtMs) } : {}),
    };
    const result = this.client.supportsLatestUpdates && this.client.publishLatestUpdate && input.delivery !== "confirmed"
      ? { ok: true, job: this.job, result: this.client.publishLatestUpdate(body) } as UpdateResponse
      : input.delivery === "confirmed" && this.client.requestConfirmed
        ? await this.client.requestConfirmed<UpdateResponse>("/api/v2/motion/update", body)
        : await this.client.request<UpdateResponse>("/api/v2/motion/update", body);
    this.job = result.job;
    // This is the sequence serialized in this client request. It identifies the
    // submitted frame even when a public relay projects a native response that
    // omits result.input_sequence; it never asserts native execution.
    return { ...result.result, clientInputSequence: body.sequence, ...(result.trace_id ? { trace_id: result.trace_id } : {}), ...(result.timing ? { edge_timing: result.timing } : {}) };
  }

  /** Return through the existing native publisher; completion never stops torque. */
  async parkJointTargets(input: JointParkOptions): Promise<Record<string, unknown>> {
    this.requireActive();
    if (this.job.mode !== "device_ik") throw new Error("native joint park requires a device_ik job");
    validateFullScope(input.targets, this.job.joint_names);
    const velocity = input.maxVelocityDegS ?? 5, tolerance = input.toleranceDeg ?? 2;
    if (!Number.isFinite(velocity) || velocity <= 0 || velocity > 5 || !Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 2) throw new Error("park requires velocity <= 5 deg/s and tolerance <= 2 degrees");
    if (input.targets.some(target => !Number.isFinite(target.position_deg) || Object.keys(target).some(key => key !== "joint_name" && key !== "position_deg"))) throw new Error("park targets require only a joint name and finite model degrees");
    const result = await this.client.request<UpdateResponse>("/api/v2/motion/update", {
      job_id: this.id, epoch: this.job.epoch, sequence: ++this.sequence,
      operation: "joint_park", targets: input.targets,
      max_velocity_deg_s: velocity, tolerance_deg: tolerance,
    });
    this.job = result.job;
    return result.result;
  }

  /** Freeze the accepted nominal joint stream without releasing DRIVE authority. */
  async hold(): Promise<Record<string, unknown>> {
    this.requireActive();
    if (this.job.mode !== "device_ik") throw new Error("native hold requires a device_ik job");
    this.client.discardLatestUpdates?.();
    const result = await this.client.request<UpdateResponse>("/api/v2/motion/update", {
      job_id: this.id, epoch: this.job.epoch, sequence: ++this.sequence, operation: "hold",
    });
    this.job = result.job;
    return result.result;
  }

  async heartbeat(options: MotionHeartbeatOptions = {}): Promise<void> {
    this.requireActive();
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 50)) {
      throw new Error("motion heartbeat timeout must be a finite value of at least 50 ms");
    }
    const result = await this.client.request<HeartbeatResponse>(
      "/api/v2/motion/heartbeat",
      { job_id: this.job.job_id, epoch: this.job.epoch },
      "POST",
      timeoutMs,
    );
    this.job = result.job;
  }

  /**
   * Confirm this job reached STOPPED. An HTTP acknowledgement or a latched
   * fault alone cannot prove release; ambiguous results remain retryable.
   * Robot applications should additionally verify broker physical authority.
   */
  async stop(reason = "client_stop"): Promise<void> {
    if (this.stopped) return;
    this.client.discardLatestUpdates?.();
    const requested = { job_id: this.job.job_id, epoch: this.job.epoch };
    const confirmsStopped = (job: MotionJob | null | undefined): job is MotionJob =>
      !!job && job.job_id === requested.job_id && Number.isInteger(job.epoch)
      && job.epoch >= requested.epoch && job.state === "stopped";
    const unconfirmed = () => new MotionControlError({ ok: false,
      error: "stop did not confirm this motion job reached stopped",
      code: "MOTION_STOP_UNCONFIRMED", domain: "motion", retryable: true,
    }, 409);
    try {
      const result = await this.client.request<StopResponse>("/api/v2/motion/stop", { ...requested, reason });
      // A terminal same-job result is also idempotent success after a lost
      // acknowledgement advanced its epoch. A newer active epoch is not.
      let terminal = result.job;
      if (!terminal && result.stopped === true && result.superseded !== true) {
        terminal = (await this.client.status()).job ?? undefined;
      }
      if (result.ok !== true || !confirmsStopped(terminal)) throw unconfirmed();
      this.job = terminal;
      this.stopped = true;
    } catch (error) {
      if (error instanceof MotionControlError && error.payload.code === "SESSION_ENDED") {
        // SESSION_ENDED includes fault-latched jobs and is not release proof.
        const terminal = (await this.client.status()).job;
        if (!confirmsStopped(terminal)) throw unconfirmed();
        this.job = terminal;
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

function validClientCreatedAtMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("clientCreatedAtMs must be a non-negative safe integer");
  return value;
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

function validateAuxiliaryTargets(targets: AuxiliaryJointTarget[], scope: readonly string[]): AuxiliaryJointTarget[] {
  if (!scope.length) throw new Error("this job did not declare auxiliaryJointNames");
  if (!Array.isArray(targets) || !targets.length) throw new Error("auxiliaryJointTargets must cover the declared scope");
  const allowed = new Set(["joint_name", "position_deg", "max_torque_nm", "velocity_deg_s"]);
  const normalized = targets.map(target => {
    if (target === null || typeof target !== "object" || Object.keys(target).some(key => !allowed.has(key))) {
      throw new Error("auxiliaryJointTargets only supports joint_name, position_deg, max_torque_nm and velocity_deg_s");
    }
    const name = requiredText(target.joint_name, "auxiliary target.joint_name");
    const torque = target.max_torque_nm === undefined ? 0.35 : target.max_torque_nm;
    const velocity = target.velocity_deg_s === undefined ? 5 : target.velocity_deg_s;
    if (!Number.isFinite(target.position_deg) || !Number.isFinite(torque) || !Number.isFinite(velocity)
      || torque <= 0 || torque > 0.35 || velocity <= 0 || velocity > 30) {
      throw new Error("auxiliary targets require finite position_deg, 0 < max_torque_nm <= 0.35 and 0 < velocity_deg_s <= 30");
    }
    return { joint_name: name, position_deg: target.position_deg, max_torque_nm: torque, velocity_deg_s: velocity };
  });
  const names = normalized.map(target => target.joint_name);
  if (names.length !== scope.length || new Set(names).size !== names.length || names.some(name => !scope.includes(name))) {
    throw new Error("auxiliaryJointTargets must cover the declared scope exactly once");
  }
  return normalized;
}

function isMotionErrorPayload(value: unknown): value is MotionErrorPayload {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).ok === false && typeof (value as Record<string, unknown>).code === "string" && typeof (value as Record<string, unknown>).error === "string");
}

function createTraceId(): string {
  const random = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  return random ? random() : `motion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
