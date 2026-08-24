export const VITRUS_CONTRACT_VERSION = "0.1.0";
export const CONTROL_JOINT_TARGETS_SCHEMA = "vitrus.control.joint_targets";
export const DEFAULT_CONTROL_TTL_MS = 250;

export type ControlJointTarget = {
  joint_name: string;
  position_deg?: number;
  position_rad?: number;
  percent?: number;
  velocity_deg_s?: number;
  velocity_rad_s?: number;
  torque_nm?: number;
  kp?: number;
  kd?: number;
};

export type ControlJointTargetsMessage = {
  schema: typeof CONTROL_JOINT_TARGETS_SCHEMA;
  schema_version: typeof VITRUS_CONTRACT_VERSION;
  source: string;
  mode: "read_write";
  sequence: number;
  sent_at_ms: number;
  ttl_ms: number;
  deadline_ms: number;
  lease_id: string;
  robot_id: string;
  edge_keepalive_ms?: number;
  operation_id?: string;
  flush: true;
  safety: {
    requires_calibration: true;
    respect_limits: true;
  };
  targets: ControlJointTarget[];
};

export function createJointTargetsMessage(options: {
  robotId: string;
  leaseId: string;
  sequence: number;
  source?: string;
  ttlMs?: number;
  sentAtMs?: number;
  edgeKeepaliveMs?: number;
  operationId?: string;
  targets: ControlJointTarget[];
}): ControlJointTargetsMessage {
  if (!options.robotId.trim()) throw new Error("joint targets require robotId");
  if (!options.leaseId.trim()) throw new Error("joint targets require leaseId");
  if (!Number.isSafeInteger(options.sequence) || options.sequence < 1) {
    throw new Error("joint targets require a positive integer sequence");
  }
  if (!options.targets.length) throw new Error("joint targets require at least one target");
  for (const target of options.targets) {
    if (!target.joint_name.trim()) throw new Error("joint targets require joint_name");
  }
  if (options.edgeKeepaliveMs != null && (
    !Number.isSafeInteger(options.edgeKeepaliveMs)
    || options.edgeKeepaliveMs < 1
    || options.edgeKeepaliveMs > 15_000
  )) {
    throw new Error("edgeKeepaliveMs must be an integer in [1, 15000]");
  }
  const operationId = options.operationId?.trim();
  if (options.operationId != null && (!operationId || operationId.length > 128)) {
    throw new Error("operationId must be a non-empty string up to 128 characters");
  }

  const sentAtMs = Math.trunc(options.sentAtMs ?? Date.now());
  const ttlMs = Math.max(1, Math.trunc(options.ttlMs ?? DEFAULT_CONTROL_TTL_MS));
  return {
    schema: CONTROL_JOINT_TARGETS_SCHEMA,
    schema_version: VITRUS_CONTRACT_VERSION,
    source: options.source?.trim() || "vitrus-sdk",
    mode: "read_write",
    sequence: options.sequence,
    sent_at_ms: sentAtMs,
    ttl_ms: ttlMs,
    deadline_ms: sentAtMs + ttlMs,
    lease_id: options.leaseId,
    robot_id: options.robotId,
    ...(options.edgeKeepaliveMs == null ? {} : { edge_keepalive_ms: options.edgeKeepaliveMs }),
    ...(operationId == null ? {} : { operation_id: operationId }),
    flush: true,
    safety: {
      requires_calibration: true,
      respect_limits: true,
    },
    targets: options.targets,
  };
}
