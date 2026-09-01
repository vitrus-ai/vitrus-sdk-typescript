export const DEVICE_STATUS_SCHEMA = "vitrus.device.status.v1" as const;
export const DEVICE_STATUS_VERSION = "1.0.0" as const;

export type DeviceOperationalState = "online" | "degraded" | "offline" | "starting" | "stopping" | "fault";
export type DeviceConnectionState = "connected" | "reconnecting" | "disconnected" | "misconfigured" | "not_configured";
export type DeviceSafetyState = "safe" | "warning" | "fault" | "estopped";
export type DeviceControlMode = "read_only" | "read_write";

export type DeviceStatusError = {
  code: string;
  message: string;
  component?: string;
  severity: "warning" | "error";
};

export type DeviceComponentStatus = {
  state: "ok" | "degraded" | "unavailable" | "fault";
  message?: string;
};

export type DeviceStatus = {
  schema: typeof DEVICE_STATUS_SCHEMA;
  schema_version: string;
  device_id: string;
  serial_number: string;
  model: string;
  timestamp: string;
  sequence: number;
  state: DeviceOperationalState;
  connection: {
    sdk_agent: DeviceConnectionState;
    bridge: DeviceConnectionState;
    edge_local: boolean;
    last_connected_at: string | null;
  };
  safety: {
    state: DeviceSafetyState;
    /** Software-reported E-stop latch; the mechanical E-stop remains hardware-local. */
    estop: boolean;
    deadman_active: boolean;
    deadman_latched: boolean;
    faults: DeviceStatusError[];
  };
  control: {
    mode: DeviceControlMode;
    phase: string;
    owner: string | null;
    lease_id: string | null;
    lease_expires_at: string | null;
  };
  robot: {
    description_revision: string | null;
    configuration_revision: string | null;
    calibration_revision: string | null;
    joint_count: number;
    available_joint_count: number;
  };
  telemetry: {
    schema: "vitrus.telemetry.state.v1";
    sequence: number | null;
    sampled_at: string | null;
    age_ms: number | null;
    complete: boolean;
    stale: boolean;
  };
  components: Record<string, DeviceComponentStatus>;
  errors: DeviceStatusError[];
  extensions: Record<string, unknown>;
};

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return string(value, field);
}

function nullableRevision(value: unknown, field: string): string | null {
  const result = nullableString(value, field);
  if (result !== null && !/^sha256:[0-9a-f]{64}$/.test(result)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 revision or null`);
  }
  return result;
}

function timestamp(value: unknown, field: string): string {
  const result = string(value, field);
  if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${field} must be an RFC3339 timestamp`);
  return result;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  return timestamp(value, field);
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, field);
}

function nullableFinite(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite number or null`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
  return value;
}

function oneOf<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new TypeError(`${field} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function statusError(value: unknown, field: string): DeviceStatusError {
  const raw = record(value, field);
  return {
    code: string(raw.code, `${field}.code`),
    message: string(raw.message, `${field}.message`),
    ...(raw.component == null ? {} : { component: string(raw.component, `${field}.component`) }),
    severity: oneOf(raw.severity, `${field}.severity`, ["warning", "error"] as const),
  };
}

function statusErrors(value: unknown, field: string): DeviceStatusError[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((item, index) => statusError(item, `${field}[${index}]`));
}

export function normalizeDeviceStatus(value: unknown): DeviceStatus {
  const raw = record(value, "status");
  if (raw.schema !== DEVICE_STATUS_SCHEMA) throw new TypeError(`status.schema must be ${DEVICE_STATUS_SCHEMA}`);
  const schemaVersion = string(raw.schema_version, "status.schema_version");
  if (schemaVersion.split(".", 1)[0] !== DEVICE_STATUS_VERSION.split(".", 1)[0]) {
    throw new TypeError(`unsupported status.schema_version ${schemaVersion}`);
  }

  const connection = record(raw.connection, "status.connection");
  const safety = record(raw.safety, "status.safety");
  const control = record(raw.control, "status.control");
  const robot = record(raw.robot, "status.robot");
  const telemetry = record(raw.telemetry, "status.telemetry");
  const components = record(raw.components, "status.components");
  const mode = oneOf(control.mode, "status.control.mode", ["read_only", "read_write"] as const);
  const owner = nullableString(control.owner, "status.control.owner");
  const leaseId = nullableString(control.lease_id, "status.control.lease_id");
  const leaseExpiresAt = nullableTimestamp(control.lease_expires_at, "status.control.lease_expires_at");
  if (mode === "read_write" && (!owner || !leaseId || !leaseExpiresAt)) {
    throw new TypeError("read_write status requires owner, lease_id and lease_expires_at");
  }
  if (mode === "read_only" && (owner || leaseId || leaseExpiresAt)) {
    throw new TypeError("read_only status cannot expose write authority");
  }

  const jointCount = integer(robot.joint_count, "status.robot.joint_count");
  const availableJointCount = integer(robot.available_joint_count, "status.robot.available_joint_count");
  if (availableJointCount > jointCount) throw new TypeError("available_joint_count cannot exceed joint_count");

  const componentStatuses = Object.fromEntries(Object.entries(components).map(([name, value]) => {
    const component = record(value, `status.components.${name}`);
    return [name, {
      state: oneOf(component.state, `status.components.${name}.state`, ["ok", "degraded", "unavailable", "fault"] as const),
      ...(component.message == null ? {} : { message: string(component.message, `status.components.${name}.message`) }),
    } satisfies DeviceComponentStatus];
  }));

  if (telemetry.schema !== "vitrus.telemetry.state.v1") {
    throw new TypeError("status.telemetry.schema must be vitrus.telemetry.state.v1");
  }

  return {
    schema: DEVICE_STATUS_SCHEMA,
    schema_version: schemaVersion,
    device_id: string(raw.device_id, "status.device_id"),
    serial_number: string(raw.serial_number, "status.serial_number"),
    model: string(raw.model, "status.model"),
    timestamp: timestamp(raw.timestamp, "status.timestamp"),
    sequence: integer(raw.sequence, "status.sequence"),
    state: oneOf(raw.state, "status.state", ["online", "degraded", "offline", "starting", "stopping", "fault"] as const),
    connection: {
      sdk_agent: oneOf(connection.sdk_agent, "status.connection.sdk_agent", ["connected", "reconnecting", "disconnected", "misconfigured", "not_configured"] as const),
      bridge: oneOf(connection.bridge, "status.connection.bridge", ["connected", "reconnecting", "disconnected", "misconfigured", "not_configured"] as const),
      edge_local: boolean(connection.edge_local, "status.connection.edge_local"),
      last_connected_at: nullableTimestamp(connection.last_connected_at, "status.connection.last_connected_at"),
    },
    safety: {
      state: oneOf(safety.state, "status.safety.state", ["safe", "warning", "fault", "estopped"] as const),
      estop: boolean(safety.estop, "status.safety.estop"),
      deadman_active: boolean(safety.deadman_active, "status.safety.deadman_active"),
      deadman_latched: boolean(safety.deadman_latched, "status.safety.deadman_latched"),
      faults: statusErrors(safety.faults, "status.safety.faults"),
    },
    control: {
      mode,
      phase: string(control.phase, "status.control.phase"),
      owner,
      lease_id: leaseId,
      lease_expires_at: leaseExpiresAt,
    },
    robot: {
      description_revision: nullableRevision(robot.description_revision, "status.robot.description_revision"),
      configuration_revision: nullableRevision(robot.configuration_revision, "status.robot.configuration_revision"),
      calibration_revision: nullableRevision(robot.calibration_revision, "status.robot.calibration_revision"),
      joint_count: jointCount,
      available_joint_count: availableJointCount,
    },
    telemetry: {
      schema: "vitrus.telemetry.state.v1",
      sequence: nullableInteger(telemetry.sequence, "status.telemetry.sequence"),
      sampled_at: nullableTimestamp(telemetry.sampled_at, "status.telemetry.sampled_at"),
      age_ms: nullableFinite(telemetry.age_ms, "status.telemetry.age_ms"),
      complete: boolean(telemetry.complete, "status.telemetry.complete"),
      stale: boolean(telemetry.stale, "status.telemetry.stale"),
    },
    components: componentStatuses,
    errors: statusErrors(raw.errors, "status.errors"),
    extensions: record(raw.extensions, "status.extensions"),
  };
}
