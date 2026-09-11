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
  transport: "dora";
  stream: "joint_targets";
  sequence?: number;
  dropped?: string;
  error?: string;
  broker?: Record<string, unknown>;
};

export type GoldenEdgeReleaseResult = {
  ok: boolean;
  transport: "dora";
  released: boolean;
  superseded?: boolean;
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

export type GoldenEdgeControlScopeResult = {
  ok: boolean;
  transport: "dora";
  scope: "all_controllable";
  joint_names: string[];
  count: number;
  excluded: Array<{ joint_name: string; reason: string }>;
};

export type GoldenEdgeClientOptions = {
  endpoint: string;
  robotId: string;
  leaseId: string;
  source?: string;
  /** Binding attached to all targets emitted by this client. */
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
  private readonly fetchImpl: (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => ReturnType<typeof globalThis.fetch>;

  constructor(private readonly options: GoldenEdgeClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.leaseId = options.leaseId.trim();
    // WebKit's native Window.fetch is brand-checked: extracting it into a
    // class field and calling it later loses the Window receiver and throws
    // "Can only call Window.fetch on instances of Window". Keep injected
    // transports untouched, but invoke the ambient fetch through globalThis.
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
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

  async publish(command: ControlJointTargetsMessage): Promise<GoldenEdgePublishResult> {
    const result = await this.request<GoldenEdgePublishResult>("/api/dora/joint-targets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    if (!result.ok || result.dropped) {
      throw new Error(result.error || result.dropped || "Golden Edge rejected joint targets");
    }
    // HTTP 200 only proves that the gateway returned JSON. When the gateway
    // includes broker evidence, it must also prove that the robot-local plan
    // is live. Accepting a response with an active deadman or inactive plan is
    // a false ACK: the command never reached mechanical authority.
    const broker = result.broker;
    if (broker) {
      const deadman = broker.deadman && typeof broker.deadman === "object" && !Array.isArray(broker.deadman)
        ? broker.deadman as Record<string, unknown>
        : {};
      const plan = broker.plan && typeof broker.plan === "object" && !Array.isArray(broker.plan)
        ? broker.plan as Record<string, unknown>
        : {};
      const rejected = Array.isArray(broker.rejected) ? broker.rejected : [];
      if (rejected.length) throw new Error(`Golden Edge broker rejected joint targets: ${JSON.stringify(rejected)}`);
      if (deadman.active === true) throw new Error("Golden Edge broker admission failed: deadman is active");
      if (Object.keys(plan).length && plan.active !== true) throw new Error("Golden Edge broker admission failed: control plan is inactive");
      if (typeof broker.access_mode === "string" && broker.access_mode !== "read_write") {
        throw new Error(`Golden Edge broker admission failed: access_mode=${broker.access_mode}`);
      }
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
    // A controller that was superseded no longer owns anything to release.
    // Treat that broker-confirmed no-op as successful, and never stop the
    // newer controller from a late cleanup callback.
    if (!result.ok || (!result.released && !result.superseded)) throw new Error("Golden Edge did not confirm release");
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
