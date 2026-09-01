import {
  createJointTargetsMessage,
  type ControlJointTarget,
  type ControlJointTargetsMessage,
  type ControlModelBinding,
} from "./contracts.js";

export type GoldenEdgeHealth = {
  ok: boolean;
  transport: "dora";
  stream: "joint_targets";
};

export type GoldenEdgePublishResult = {
  ok: boolean;
  transport: "dora" | "broker-direct";
  stream: "joint_targets";
  sequence?: number;
  dropped?: string;
  error?: string;
  broker?: {
    lease_id?: string;
    seq?: number;
    accepted?: number;
    rejected?: unknown[];
    access_mode?: string;
    control_phase?: string;
    deadman?: { active?: boolean; latched?: boolean };
    feedback?: unknown[];
  };
};

export type GoldenEdgeCartesianPoint = {
  positionM: [number, number, number];
  quaternionXyzw?: [number, number, number, number];
  timeMs?: number;
};

export type GoldenEdgeIkTrajectoryResult = {
  ok: boolean;
  accepted: boolean;
  command_id: number;
  mode: "ik";
  chain: string;
  job_id: string;
  input_sequence: number;
  point_count: number;
  ttl_ms: number;
  alignment_profile: { id: string; frame_corrections_applied?: number };
};

/** Device-local execution evidence for the latest Cartesian target. */
export type GoldenEdgeIkStatus = {
  ok: boolean;
  mode: "ready" | "ik";
  tracking: boolean;
  last_error: string | null;
  last_error_command_id?: number | null;
  /** Numerical no-progress while Edge continues holding the last safe target. */
  last_warning?: string | null;
  last_output: {
    command_id: number;
    chain: string;
    lease_id: string;
    writer_source: string;
    status: string;
    solver_status?: string;
    broker_accepted?: number;
    broker_rejected?: unknown[];
  } | null;
};

export type GoldenEdgeCartesianPose = {
  ok: boolean;
  chain: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  joint_names: string[];
  alignment_profile: { id: string; frame_corrections_applied?: number };
};

export type GoldenEdgeJointState = {
  joint_name: string;
  connected?: boolean;
  stale?: boolean;
  fault?: unknown;
  display_pos_deg?: number;
  velocity_deg_s?: number;
  torque_nm?: number;
  feedback_age_ms?: number;
  accepted_origin_sequence?: number;
  applied_origin_sequence?: number;
};

export type GoldenEdgeControlState = {
  ok: boolean;
  transport: "broker-direct";
  cycle_seq?: number;
  complete?: boolean;
  missing_joints?: string[];
  access_mode?: string;
  control_phase?: string;
  exclusive_lease_id?: string | null;
  global_control?: string;
  deadman?: { active?: boolean; latched?: boolean; trip_count?: number };
  motors?: GoldenEdgeJointState[];
};

export type GoldenEdgeReleaseResult = {
  ok: boolean;
  transport: "dora";
  released: boolean;
  lease_id: string;
  broker?: Record<string, unknown>;
};

export type GoldenEdgeAcquireResult = {
  ok: boolean;
  transport: "dora";
  acquired: boolean;
  lease_id: string;
  broker?: Record<string, unknown>;
};

export type GoldenEdgeRenewResult = {
  ok: boolean;
  transport: "dora";
  renewed: boolean;
  lease_id: string;
  duration_ms: number;
  broker?: Record<string, unknown>;
};

/** Confirmation that Edge continues holding the last broker-accepted target. */
export type GoldenEdgeControlHeartbeatResult = {
  ok: boolean;
  transport: "dora" | "broker-direct";
  lease_id?: string;
  hold_active: boolean;
};

export type GoldenEdgeControlScopeResult = {
  ok: boolean;
  transport: "dora";
  scope: "all_controllable";
  joint_names: string[];
  count: number;
  excluded: Array<{ joint_name: string; reason: string }>;
};

/** Self-described module product. Unknown fields remain available in `raw`. */
export type GoldenEdgeModuleDataProduct = {
  id: string;
  schema?: string;
  mimeType?: string;
  url?: string;
  width?: number;
  height?: number;
  raw: Record<string, unknown>;
};

/** Device-declared visualization and configuration metadata. */
export type GoldenEdgeModule = {
  id: string;
  type: string;
  category?: string;
  displayName: string;
  state: string;
  statusText?: string;
  capabilities: string[];
  dataProducts: GoldenEdgeModuleDataProduct[];
  settings: Record<string, unknown>;
  settingsSchema?: Record<string, unknown>;
  visualization?: Record<string, unknown>;
  metrics: Record<string, unknown>;
  raw: Record<string, unknown>;
};

export type GoldenEdgeModuleCatalog = {
  schema: string;
  modules: GoldenEdgeModule[];
  moduleSettings: Record<string, Record<string, unknown>>;
};

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const optionalString = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const finiteNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

function normalizeModule(raw: unknown): GoldenEdgeModule | null {
  const module = asRecord(raw);
  const id = optionalString(module.id);
  const type = optionalString(module.type);
  if (!id || !type || !/^[a-zA-Z0-9._-]{1,128}$/.test(id)) return null;
  const products = Array.isArray(module.data_products) ? module.data_products.flatMap((value): GoldenEdgeModuleDataProduct[] => {
    const product = asRecord(value);
    const productId = optionalString(product.id);
    if (!productId || !/^[a-zA-Z0-9._-]{1,128}$/.test(productId)) return [];
    const url = optionalString(product.url);
    return [{ id: productId, schema: optionalString(product.schema), mimeType: optionalString(product.mime_type), url,
      width: finiteNumber(product.width), height: finiteNumber(product.height), raw: product }];
  }) : [];
  return {
    id, type, category: optionalString(module.category), displayName: optionalString(module.display_name) ?? id,
    state: optionalString(module.state) ?? "unknown", statusText: optionalString(module.status_text),
    capabilities: Array.isArray(module.capabilities) ? module.capabilities.filter((value): value is string => typeof value === "string") : [],
    dataProducts: products, settings: asRecord(module.settings), settingsSchema: Object.keys(asRecord(module.settings_schema)).length ? asRecord(module.settings_schema) : undefined,
    visualization: Object.keys(asRecord(module.visualization)).length ? asRecord(module.visualization) : undefined,
    metrics: asRecord(module.metrics), raw: module,
  };
}

function normalizeModuleCatalog(raw: unknown): GoldenEdgeModuleCatalog {
  const payload = asRecord(raw);
  if (payload.ok !== true || !Array.isArray(payload.modules)) throw new Error("Golden Edge returned an invalid module catalog");
  const moduleSettings = asRecord(asRecord(payload.module_settings).modules);
  return {
    schema: optionalString(payload.schema) ?? "vitrus.modules.v1",
    modules: payload.modules.flatMap((module) => {
      const normalized = normalizeModule(module);
      return normalized ? [normalized] : [];
    }),
    moduleSettings: Object.fromEntries(Object.entries(moduleSettings).map(([id, settings]) => [id, asRecord(settings)])),
  };
}

export type GoldenEdgeClientOptions = {
  endpoint: string;
  robotId: string;
  leaseId: string;
  source?: string;
  modelBinding?: ControlModelBinding;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

export class GoldenEdgeRequestTimeoutError extends Error {
  readonly code = "VITRUS_EDGE_ADMISSION_TIMEOUT";

  constructor(readonly path: string, readonly timeoutMs: number) {
    super(`Golden Edge admission timed out after ${timeoutMs} ms (${path})`);
    this.name = "GoldenEdgeRequestTimeoutError";
  }
}

export class GoldenEdgeClient {
  private sequence = 0;
  private leaseId: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: GoldenEdgeClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.leaseId = options.leaseId.trim();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.endpoint) throw new Error("Golden Edge client requires endpoint");
    if (!options.robotId.trim()) throw new Error("Golden Edge client requires robotId");
    if (!this.leaseId) throw new Error("Golden Edge client requires leaseId");
    if (typeof this.fetchImpl !== "function") throw new Error("Golden Edge client requires fetch");
  }

  setLease(leaseId: string): void {
    const nextLeaseId = leaseId.trim();
    if (!nextLeaseId) throw new Error("Golden Edge client requires leaseId");
    this.leaseId = nextLeaseId;
    this.sequence = 0;
  }

  async health(): Promise<GoldenEdgeHealth> {
    return this.request<GoldenEdgeHealth>("/healthz", { method: "GET" });
  }

  async controlScope(): Promise<GoldenEdgeControlScopeResult> {
    const result = await this.request<GoldenEdgeControlScopeResult>("/api/dora/control-scope", { method: "GET" }, 4_000);
    if (!result.ok || !Array.isArray(result.joint_names) || !result.joint_names.length) {
      throw new Error("Golden Edge returned no controllable motors");
    }
    return result;
  }

  async controlState(): Promise<GoldenEdgeControlState> {
    // State is a broker read, not a control-frame admission.  Respect the
    // caller's configured diagnostic timeout so a transient Edge refresh
    // cannot make an otherwise healthy HIL preflight look like a command loss.
    return this.request<GoldenEdgeControlState>("/api/dora/control-state", { method: "GET" }, this.options.requestTimeoutMs ?? 1_000);
  }

  /** Discover module types, products, visualization profiles, and persisted settings. */
  async modules(): Promise<GoldenEdgeModuleCatalog> {
    return normalizeModuleCatalog(await this.request<unknown>("/api/modules", { method: "GET" }, 3_000));
  }

  /** Persist a module-specific settings patch through VitrusOS. */
  async configureModule(moduleId: string, settings: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = moduleId.trim();
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(id) || !settings || Array.isArray(settings)) {
      throw new Error("Golden Edge module configuration requires a safe module id and settings object");
    }
    const result = await this.request<unknown>("/api/modules/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ module_id: id, settings }),
    }, 3_000);
    const payload = asRecord(result);
    if (payload.ok !== true || payload.module_id !== id || !Object.keys(asRecord(payload.settings)).length) {
      throw new Error("Golden Edge did not confirm module configuration");
    }
    return asRecord(payload.settings);
  }

  async acquire(
    leaseId: string,
    options: { owner: string; durationMs: number; jointNames: string[] },
  ): Promise<GoldenEdgeAcquireResult> {
    const requested = leaseId.trim();
    if (!requested || !options.jointNames.length) {
      throw new Error("Golden Edge acquire requires a lease and explicit joint scope");
    }
    const result = await this.request<GoldenEdgeAcquireResult>("/api/dora/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lease_id: requested,
        owner: options.owner,
        duration_ms: options.durationMs,
        joint_names: options.jointNames,
      }),
    }, 10_000);
    if (!result.ok || !result.acquired || result.lease_id !== requested) {
      throw new Error("Golden Edge did not confirm acquire");
    }
    this.setLease(requested);
    return result;
  }

  async sendJointTargets(
    targets: ControlJointTarget[],
    options: { ttlMs?: number; sentAtMs?: number; edgeKeepaliveMs?: number; modelBinding?: ControlModelBinding } = {},
  ): Promise<GoldenEdgePublishResult> {
    const command = createJointTargetsMessage({
      robotId: this.options.robotId,
      leaseId: this.leaseId,
      sequence: ++this.sequence,
      source: this.options.source,
      ttlMs: options.ttlMs,
      sentAtMs: options.sentAtMs,
      edgeKeepaliveMs: options.edgeKeepaliveMs,
      modelBinding: options.modelBinding ?? this.options.modelBinding,
      targets,
    });
    return this.publish(command);
  }

  async renew(leaseId: string, durationMs = 30_000): Promise<GoldenEdgeRenewResult> {
    const requested = leaseId.trim();
    if (!requested || requested !== this.leaseId) {
      throw new Error("Golden Edge renew lease does not match active client lease");
    }
    if (!Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 30_000) {
      throw new Error("Golden Edge renew durationMs must be in [1000, 30000]");
    }
    const result = await this.request<GoldenEdgeRenewResult>("/api/dora/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lease_id: requested, duration_ms: durationMs }),
    }, 4_000);
    if (!result.ok || !result.renewed || result.lease_id !== requested) {
      throw new Error("Golden Edge did not confirm renew");
    }
    return result;
  }

  async controlHeartbeat(leaseId: string, holdMs = 2_500): Promise<GoldenEdgeControlHeartbeatResult> {
    const requested = leaseId.trim();
    if (!requested || requested !== this.leaseId) {
      throw new Error("Golden Edge control heartbeat lease does not match active client lease");
    }
    if (!Number.isSafeInteger(holdMs) || holdMs < 500 || holdMs > 5_000) {
      throw new Error("Golden Edge control heartbeat holdMs must be in [500, 5000]");
    }
    const result = await this.request<GoldenEdgeControlHeartbeatResult>("/api/dora/control-heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lease_id: requested, hold_ms: holdMs }),
    }, Math.min(this.options.requestTimeoutMs ?? 1_000, 1_500));
    if (!result.ok || result.hold_active !== true) {
      throw new Error("Golden Edge did not confirm active control hold");
    }
    return result;
  }

  async publish(command: ControlJointTargetsMessage): Promise<GoldenEdgePublishResult> {
    const result = await this.request<GoldenEdgePublishResult>("/api/dora/joint-targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    if (!result.ok || result.dropped) {
      throw new Error(result.error || result.dropped || "Golden Edge rejected joint targets");
    }
    return result;
  }

  async submitIkTrajectory(request: {
    /** Stable per-lease job identity. Edge owns the resulting trajectory. */
    jobId: string;
    /** Strictly increasing target revision within jobId. */
    inputSequence: number;
    chain: string;
    /** Immutable full Cartesian scope for the lease; omitted is single-chain. */
    controlledChains?: string[];
    points: GoldenEdgeCartesianPoint[];
    ttlMs: number;
    alignmentProfile?: string | Record<string, unknown>;
    modelBinding?: ControlModelBinding;
  }): Promise<GoldenEdgeIkTrajectoryResult> {
    const chain = request.chain.trim().toUpperCase();
    const jobId = request.jobId.trim();
    if (!jobId || jobId.length > 256 || !Number.isSafeInteger(request.inputSequence) || request.inputSequence < 1) {
      throw new Error("Golden Edge IK trajectory requires a bounded jobId and positive inputSequence");
    }
    if (!chain || !Array.isArray(request.points) || !request.points.length) {
      throw new Error("Golden Edge IK trajectory requires a chain and at least one point");
    }
    const controlledChains = request.controlledChains == null
      ? undefined
      : [...new Set(request.controlledChains.map((value) => value.trim().toUpperCase()))];
    if (controlledChains && (!controlledChains.length || controlledChains.some((value) => !value) || !controlledChains.includes(chain))) {
      throw new Error("Golden Edge IK controlledChains must be a non-empty unique set containing chain");
    }
    const result = await this.request<GoldenEdgeIkTrajectoryResult>("/api/dora/ik-targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lease_id: this.leaseId,
        session_id: this.leaseId,
        job_id: jobId,
        input_sequence: request.inputSequence,
        chain,
        ...(controlledChains ? { controlled_chains: controlledChains } : {}),
        ttl_ms: request.ttlMs,
        ...(request.modelBinding ?? this.options.modelBinding ?? {}),
        points: request.points.map((point) => ({
          position: point.positionM,
          ...(point.quaternionXyzw ? { quaternion: point.quaternionXyzw } : {}),
          ...(point.timeMs == null ? {} : { time_ms: point.timeMs }),
        })),
        ...(request.alignmentProfile == null ? {} : { alignment_profile: request.alignmentProfile }),
      }),
    }, 4_000);
    if (!result.ok || result.accepted !== true || result.mode !== "ik") {
      throw new Error("Golden Edge did not admit the IK trajectory");
    }
    return result;
  }

  async ikStatus(): Promise<GoldenEdgeIkStatus> {
    const result = await this.request<GoldenEdgeIkStatus>("/api/dora/ik/status", { method: "GET" }, 3_000);
    if (!result.ok || !["ready", "ik"].includes(result.mode)) {
      throw new Error("Golden Edge returned an invalid IK execution status");
    }
    return result;
  }

  async currentCartesianPose(chain: string, alignmentProfile?: string): Promise<GoldenEdgeCartesianPose> {
    const name = chain.trim().toUpperCase();
    if (!name) throw new Error("Golden Edge current Cartesian pose requires a chain");
    const query = new URLSearchParams({ chain: name });
    if (alignmentProfile) query.set("alignment_profile", alignmentProfile);
    const result = await this.request<GoldenEdgeCartesianPose>(`/api/dora/ik/current-pose?${query}`, { method: "GET" }, 3_000);
    if (!result.ok || result.chain !== name || result.position.length !== 3 || result.quaternion.length !== 4) {
      throw new Error("Golden Edge returned an invalid Cartesian pose");
    }
    return result;
  }

  async release(leaseId: string): Promise<GoldenEdgeReleaseResult> {
    const requested = leaseId.trim();
    if (!requested || requested !== this.leaseId) {
      throw new Error("Golden Edge release lease does not match active client lease");
    }
    const result = await this.request<GoldenEdgeReleaseResult>("/api/dora/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lease_id: requested }),
    }, 8_000);
    if (!result.ok || !result.released) throw new Error("Golden Edge did not confirm release");
    return result;
  }

  private async request<T>(path: string, init: RequestInit, timeoutOverrideMs?: number): Promise<T> {
    const timeoutMs = timeoutOverrideMs ?? this.options.requestTimeoutMs ?? 1_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint}${path}`, {
        ...init,
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null) as T | { error?: unknown } | null;
      if (!response.ok) {
        const detail = payload && typeof payload === "object" && "error" in payload
          ? String(payload.error)
          : response.statusText;
        throw new Error(`Golden Edge request failed (${response.status}): ${detail}`);
      }
      if (!payload || typeof payload !== "object") throw new Error("Golden Edge returned invalid JSON");
      return payload as T;
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new GoldenEdgeRequestTimeoutError(path, timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
