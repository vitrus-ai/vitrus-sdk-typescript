import type { ControlJointTarget, ControlJointTargetsMessage } from "./contracts.js";

export type ZenohEdgeSession = {
  put(topic: string, payload: string, options?: { express?: boolean }): Promise<void>;
  close(): Promise<void>;
};

export type ZenohEdgeClientOptions = {
  endpoint: string;
  topic?: string;
  sessionFactory?: () => Promise<ZenohEdgeSession>;
};

export type ZenohEdgePublishResult = {
  ok: true;
  transport: "zenoh";
  stream: "joint_targets";
  sequence: number;
  published: number;
};

const DEFAULT_TOPIC = "vitrus/servo/targets";

export class ZenohEdgeClient {
  private session: ZenohEdgeSession | null = null;
  private leaseId: string;

  constructor(private readonly options: ZenohEdgeClientOptions & { robotId: string; leaseId: string; source?: string }) {
    if (!options.endpoint.trim()) throw new Error("Zenoh edge client requires endpoint");
    if (!options.robotId.trim()) throw new Error("Zenoh edge client requires robotId");
    this.leaseId = options.leaseId.trim();
    if (!this.leaseId) throw new Error("Zenoh edge client requires leaseId");
  }

  setLease(leaseId: string): void {
    const nextLeaseId = leaseId.trim();
    if (!nextLeaseId) throw new Error("Zenoh edge client requires leaseId");
    this.leaseId = nextLeaseId;
  }

  async publish(command: ControlJointTargetsMessage): Promise<ZenohEdgePublishResult> {
    const session = await this.getSession();
    const topic = this.options.topic?.trim() || DEFAULT_TOPIC;
    for (const target of command.targets) {
      const payload = JSON.stringify({
        schema: command.schema,
        schema_version: command.schema_version,
        source: command.source,
        lease_id: this.leaseId,
        seq: command.sequence,
        issued_at_ms: command.sent_at_ms,
        deadline_ms: command.deadline_ms,
        target: targetToEdgeTarget(target),
      });
      await session.put(topic, payload, { express: true });
    }
    return { ok: true, transport: "zenoh", stream: "joint_targets", sequence: command.sequence, published: command.targets.length };
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session) await session.close();
  }

  private async getSession(): Promise<ZenohEdgeSession> {
    if (this.session) return this.session;
    this.session = this.options.sessionFactory
      ? await this.options.sessionFactory()
      : await this.openDefaultSession();
    return this.session;
  }

  private async openDefaultSession(): Promise<ZenohEdgeSession> {
    const { Config, Session } = await import("@eclipse-zenoh/zenoh-ts");
    return Session.open(new Config(this.options.endpoint));
  }
}

function targetToEdgeTarget(target: ControlJointTarget): Record<string, unknown> {
  const edgeTarget: Record<string, unknown> = { joint_name: target.joint_name };
  if (target.position_deg !== undefined) edgeTarget.display_deg = target.position_deg;
  if (target.position_rad !== undefined) edgeTarget.position_rad = target.position_rad;
  if (target.percent !== undefined) edgeTarget.percent = target.percent;
  if (target.velocity_deg_s !== undefined) edgeTarget.speed_deg_s = target.velocity_deg_s;
  if (target.velocity_rad_s !== undefined) edgeTarget.velocity_rad_s = target.velocity_rad_s;
  if (target.torque_nm !== undefined) edgeTarget.torque_nm = target.torque_nm;
  if (target.kp !== undefined) edgeTarget.kp = target.kp;
  if (target.kd !== undefined) edgeTarget.kd = target.kd;
  return edgeTarget;
}