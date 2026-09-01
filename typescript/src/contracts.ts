import type { EffectorCommandEnvelope } from "./effectors.js";

export const VITRUS_CONTRACT_VERSION = "0.1.0";

export const CONTROL_JOINT_TARGETS_SCHEMA = "vitrus.control.joint_targets";
export const DEFAULT_CONTROL_TTL_MS = 250;

export type ControlModelBinding = {
  configuration_revision: string;
  effective_urdf_sha256: string;
  model_epoch: number;
};

export type ControlJointTarget = {
  joint_name: string;
  position_deg?: number;
  position_rad?: number;
  percent?: number;
  velocity_deg_s?: number;
  velocity_rad_s?: number;
  /** Edge-owned positional tracker velocity limit. */
  eased_max_velocity_deg_s?: number;
  /** Edge-owned positional tracker acceleration limit. */
  eased_max_accel_deg_s?: number;
  torque_nm?: number;
  /** Stop and hold this joint when measured load reaches the limit. */
  max_torque_nm?: number;
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
  /**
   * Bounded Edge-local positional-target keepalive after WAN admission.
   * This never extends the original WAN admission deadline.
   */
  edge_keepalive_ms?: number;
  lease_id: string;
  robot_id: string;
  configuration_revision?: string;
  effective_urdf_sha256?: string;
  model_epoch?: number;
  /** VitrusOS owns the only physical velocity/acceleration/jerk trajectory. */
  trajectory_owner: "edge";
  flush: true;
  safety: {
    requires_calibration: true;
    respect_limits: true;
  };
  /** Semantic intent re-resolved against the robot-local effector model. */
  semantic_effectors?: {
    schema: "vitrus.control.effectors.v1";
    description_revision_id: string;
    commands: Array<{
      effector_id: string;
      model_id: string;
      model_revision: string;
      command_type: string;
      values: Record<string, number | boolean | string>;
      limits?: { max_torque_nm?: number };
    }>;
  };
  targets: ControlJointTarget[];
};

export function createJointTargetsMessage(options: {
  robotId: string;
  leaseId: string;
  sequence: number;
  source?: string;
  ttlMs?: number;
  edgeKeepaliveMs?: number;
  modelBinding?: ControlModelBinding;
  semanticEffectors?: EffectorCommandEnvelope;
  sentAtMs?: number;
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
    if (target.max_torque_nm != null && (!Number.isFinite(target.max_torque_nm) || target.max_torque_nm <= 0)) {
      throw new Error("joint target max_torque_nm must be a positive finite number");
    }
  }

  if (
    options.edgeKeepaliveMs != null
    && (
      !Number.isSafeInteger(options.edgeKeepaliveMs)
      || options.edgeKeepaliveMs < 1
      || options.edgeKeepaliveMs > 15_000
    )
  ) {
    throw new Error("edgeKeepaliveMs must be an integer between 1 and 15000 ms");
  }
  if (options.modelBinding) {
    const binding = options.modelBinding;
    if (!/^[a-f0-9]{64}$/.test(binding.configuration_revision)
      || !/^[a-f0-9]{64}$/.test(binding.effective_urdf_sha256)
      || !Number.isSafeInteger(binding.model_epoch) || binding.model_epoch < 1) {
      throw new Error("modelBinding must contain a valid revision, effective URDF SHA-256, and positive epoch");
    }
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
    ...(options.edgeKeepaliveMs == null ? {} : {
      edge_keepalive_ms: options.edgeKeepaliveMs,
    }),
    lease_id: options.leaseId,
    robot_id: options.robotId,
    ...(options.modelBinding ?? {}),
    trajectory_owner: "edge",
    flush: true,
    safety: {
      requires_calibration: true,
      respect_limits: true,
    },
    ...(options.semanticEffectors ? {
      semantic_effectors: {
        schema: options.semanticEffectors.schema,
        description_revision_id: options.semanticEffectors.descriptionRevisionId,
        commands: options.semanticEffectors.commands.map((command) => ({
          effector_id: command.effectorId,
          model_id: command.modelId,
          model_revision: command.modelRevision,
          command_type: command.commandType,
          values: { ...command.values },
          ...(command.limits ? {
            limits: {
              ...(command.limits.maxTorqueNm == null ? {} : { max_torque_nm: command.limits.maxTorqueNm }),
            },
          } : {}),
        })),
      },
    } : {}),
    targets: options.targets,
  };
}
