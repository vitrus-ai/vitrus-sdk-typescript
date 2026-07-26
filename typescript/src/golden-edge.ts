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

export type GoldenEdgeClientOptions = {
  endpoint: string;
  robotId: string;
  leaseId: string;
  source?: string;
  fetch?: typeof globalThis.fetch;
};

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

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.endpoint}${path}`, init);
    const payload = await response.json().catch(() => null) as T | { error?: unknown } | null;
    if (!response.ok) {
      const detail = payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : response.statusText;
      throw new Error(`Golden Edge request failed (${response.status}): ${detail}`);
    }
    if (!payload || typeof payload !== "object") throw new Error("Golden Edge returned invalid JSON");
    return payload as T;
  }
}