import {
  createJointTargetsMessage,
  type ControlJointTarget,
  type ControlJointTargetsMessage,
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

export type GoldenEdgeClientOptions = {
  endpoint: string;
  robotId: string;
  leaseId: string;
  source?: string;
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
    options: { ttlMs?: number; sentAtMs?: number } = {},
  ): Promise<GoldenEdgePublishResult> {
    const command = createJointTargetsMessage({
      robotId: this.options.robotId,
      leaseId: this.leaseId,
      sequence: ++this.sequence,
      source: this.options.source,
      ttlMs: options.ttlMs,
      sentAtMs: options.sentAtMs,
      targets,
    });
    return this.publish(command);
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
