export const VITRUS_CONTRACT_VERSION = "0.1.0";
export const CONTROL_JOINT_TARGETS_SCHEMA = "vitrus.control.joint_targets";
/**
 * Kept only for callers talking to a pre desired-state edge.  New control
 * messages deliberately have no source-expiry deadline: a lease owns the
 * authority lifetime and the newest desired state replaces the older one.
 */
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
  /** Legacy source-age fields. Omitted for desired-state control. */
  ttl_ms?: number;
  deadline_ms?: number;
  lease_id: string;
  robot_id: string;
  edge_keepalive_ms?: number;
  operation_id?: string;
  /**
   * The edge keeps one newest complete state for this key. This is intent,
   * rather than a request to execute every intermediate browser event.
   */
  delivery: {
    kind: "desired_state";
    key: string;
    replace_pending: true;
  };
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
  /** @deprecated Kept for source compatibility and intentionally not sent. */
  ttlMs?: number;
  /** Stable key for a separately controllable chain, such as `neck` or
   * `right_gripper`. If omitted, the target joint set is used. */
  desiredStateKey?: string;
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
  const desiredStateKey = options.desiredStateKey?.trim()
    || options.targets.map((target) => target.joint_name).sort().join(",");
  if (!desiredStateKey || desiredStateKey.length > 256) {
    throw new Error("desiredStateKey must be a non-empty string up to 256 characters");
  }
  // A source timestamp is useful for traces; a source deadline is not. A
  // delayed target must either be superseded at the Edge or converge after it
  // arrives, while the lease remains the sole authority lifetime.
  void options.ttlMs;
  return {
    schema: CONTROL_JOINT_TARGETS_SCHEMA,
    schema_version: VITRUS_CONTRACT_VERSION,
    source: options.source?.trim() || "vitrus-sdk",
    mode: "read_write",
    sequence: options.sequence,
    sent_at_ms: sentAtMs,
    lease_id: options.leaseId,
    robot_id: options.robotId,
    ...(options.edgeKeepaliveMs == null ? {} : { edge_keepalive_ms: options.edgeKeepaliveMs }),
    ...(operationId == null ? {} : { operation_id: operationId }),
    delivery: {
      kind: "desired_state",
      key: desiredStateKey,
      replace_pending: true,
    },
    flush: true,
    safety: {
      requires_calibration: true,
      respect_limits: true,
    },
    targets: options.targets,
  };
}
