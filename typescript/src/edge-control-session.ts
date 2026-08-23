import {
  GoldenEdgeClient,
  type GoldenEdgePublishResult,
} from "./golden-edge.js";
import type { ControlJointTarget } from "./contracts.js";

export type EdgeControlSessionOptions = {
  endpoint: string;
  robotId: string;
  /** Exact joints, or all currently fresh/calibrated/controllable motors. */
  jointNames: string[] | "all";
  owner?: string;
  leaseId?: string;
  source?: string;
  durationMs?: number;
  requestTimeoutMs?: number;
  refreshMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
};

export type EdgeHoldOptions = {
  durationMs: number;
  ttlMs?: number;
  edgeKeepaliveMs?: number;
  refreshMs?: number;
  signal?: AbortSignal;
  onAdmission?: (result: GoldenEdgePublishResult) => void | Promise<void>;
};

/**
 * One renewable, explicitly scoped Edge authority session.
 *
 * The Edge owns interpolation and the 100 Hz physical command loop. This
 * client only refreshes the latest semantic joint target and renews authority;
 * it never attempts to emulate a motor loop over the network.
 */
export class EdgeControlSession {
  readonly leaseId: string;
  readonly jointNames: readonly string[];
  private readonly client: GoldenEdgeClient;
  private readonly now: () => number;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private readonly durationMs: number;
  private readonly defaultRefreshMs: number;
  private renewAtMs = 0;
  private released = false;

  private constructor(options: Omit<EdgeControlSessionOptions, "jointNames"> & { jointNames: string[] }, leaseId: string) {
    this.leaseId = leaseId;
    this.jointNames = [...options.jointNames];
    this.durationMs = options.durationMs ?? 30_000;
    this.defaultRefreshMs = options.refreshMs ?? 500;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((durationMs) => new Promise(resolve => setTimeout(resolve, durationMs)));
    this.client = new GoldenEdgeClient({
      endpoint: options.endpoint,
      robotId: options.robotId,
      leaseId,
      source: options.source ?? "vitrus-sdk-edge-session",
      requestTimeoutMs: options.requestTimeoutMs,
      fetch: options.fetch,
    });
  }

  static async acquire(options: EdgeControlSessionOptions): Promise<EdgeControlSession> {
    const leaseId = options.leaseId?.trim() || `sdk-edge-${createSessionId()}`;
    let requestedNames: string[];
    if (options.jointNames === "all") {
      const resolver = new GoldenEdgeClient({
        endpoint: options.endpoint,
        robotId: options.robotId,
        leaseId,
        source: options.source ?? "vitrus-sdk-edge-session",
        requestTimeoutMs: options.requestTimeoutMs,
        fetch: options.fetch,
      });
      requestedNames = (await resolver.controlScope()).joint_names;
    } else {
      requestedNames = options.jointNames;
    }
    const names = requestedNames.map(name => name.trim()).filter(Boolean);
    if (!names.length || new Set(names).size !== names.length) {
      throw new Error("Edge control session requires a unique non-empty joint scope");
    }
    const durationMs = options.durationMs ?? 30_000;
    if (!Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 30_000) {
      throw new Error("Edge control session durationMs must be in [1000, 30000]");
    }
    const refreshMs = options.refreshMs ?? 500;
    if (!Number.isSafeInteger(refreshMs) || refreshMs < 50 || refreshMs > 1_000) {
      throw new Error("Edge control session refreshMs must be in [50, 1000]");
    }
    const session = new EdgeControlSession({ ...options, jointNames: names }, leaseId);
    await session.client.acquire(leaseId, {
      owner: options.owner?.trim() || "vitrus-sdk",
      durationMs,
      jointNames: names,
    });
    session.scheduleRenewal();
    return session;
  }

  async send(targets: ControlJointTarget[], options: { ttlMs?: number; edgeKeepaliveMs?: number } = {}): Promise<GoldenEdgePublishResult> {
    this.requireActive();
    this.validateTargets(targets);
    await this.renewIfNeeded();
    return this.client.sendJointTargets(targets, {
      ttlMs: options.ttlMs ?? 400,
      edgeKeepaliveMs: options.edgeKeepaliveMs ?? 1_500,
    });
  }

  async hold(targets: ControlJointTarget[], options: EdgeHoldOptions): Promise<GoldenEdgePublishResult[]> {
    this.requireActive();
    this.validateTargets(targets);
    if (!Number.isFinite(options.durationMs) || options.durationMs < 0 || options.durationMs > 120_000) {
      throw new Error("Edge hold durationMs must be in [0, 120000]");
    }
    const refreshMs = options.refreshMs ?? this.defaultRefreshMs;
    if (!Number.isSafeInteger(refreshMs) || refreshMs < 50 || refreshMs > 1_000) {
      throw new Error("Edge hold refreshMs must be in [50, 1000]");
    }
    const deadline = this.now() + options.durationMs;
    const admissions: GoldenEdgePublishResult[] = [];
    let consecutiveFailures = 0;
    do {
      if (options.signal?.aborted) throw new DOMException("Edge hold aborted", "AbortError");
      try {
        const result = await this.send(targets, options);
        admissions.push(result);
        consecutiveFailures = 0;
        await options.onAdmission?.(result);
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) throw error;
      }
      const remaining = deadline - this.now();
      if (remaining > 0) await this.sleep(Math.min(refreshMs, remaining));
    } while (this.now() < deadline);
    return admissions;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.client.release(this.leaseId);
  }

  private validateTargets(targets: ControlJointTarget[]): void {
    if (!targets.length) throw new Error("Edge control session requires at least one target");
    const scope = new Set(this.jointNames);
    const seen = new Set<string>();
    for (const target of targets) {
      if (!scope.has(target.joint_name)) throw new Error(`${target.joint_name}: target is outside the acquired Edge scope`);
      if (seen.has(target.joint_name)) throw new Error(`${target.joint_name}: duplicate target`);
      seen.add(target.joint_name);
    }
  }

  private requireActive(): void {
    if (this.released) throw new Error("Edge control session is already released");
  }

  private scheduleRenewal(): void {
    this.renewAtMs = this.now() + Math.max(1_000, Math.floor(this.durationMs * 0.5));
  }

  private async renewIfNeeded(): Promise<void> {
    if (this.now() < this.renewAtMs) return;
    await this.client.renew(this.leaseId, this.durationMs);
    this.scheduleRenewal();
  }
}

function createSessionId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}
