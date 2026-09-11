/**
 * Device-local engineering configuration client.
 *
 * This API is deliberately separate from motion/control.  It can inspect the
 * active device revision and submit an optimistic, semantic patch, but it
 * cannot acquire a motor lease or bypass Edge-local activation gates.
 */

export const DEVICE_CONFIGURATION_SCHEMA = "vitrus.device.v1" as const;
export const DEVICE_CONFIGURATION_PATCH_SCHEMA = "vitrus.device.patch.v1" as const;

export type SafeLimitsRad = { lower: number; upper: number };
export type MotorControlDefaults = {
  control_mode?: "mit_position" | "position_velocity" | "servo_position";
  duration_s?: number;
  servo_speed_deg_s?: number;
  max_torque_nm?: number;
  target_velocity_deg_s?: number;
  max_velocity_deg_s?: number;
  max_accel_deg_s2?: number;
  max_jerk_deg_s3?: number;
  tracker_smoothing_s?: number;
  kp?: number;
  kd?: number;
  tau_ff_nm?: number;
  kp_start?: number;
  kp_duration_s?: number;
  timing_mode?: "speed" | "duration";
};
export type GlobalMotionProfile = {
  enabled: boolean;
  preset: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  speed_deg_s: number;
  min_duration_s: number;
  max_duration_s: number;
  apply_to: Array<"bldc" | "servo">;
};
/**
 * Device-local conversion from raw encoder coordinates to the coordinates used
 * by the effective URDF, FK/IK, collision checks, and target commands.
 * This is calibration metadata, never a second kinematic model.
 */
export type EncoderToModel = {
  schema: "vitrus.encoder_to_model.v1";
  raw_reference_rad: number;
  model_reference_rad: number;
  /** Raw radians per one model radian; must be positive. */
  ratio_raw_per_model: number;
  direction_sign: 1 | -1;
  raw_wrap_period_rad: number;
};
export type DeviceJointConfiguration = {
  assigned?: boolean;
  kind?: "bldc" | "servo";
  channel?: string;
  motor_id?: number;
  master_id?: number;
  motor_model?: string;
  motor_unit?: "rad" | "ticks";
  motor_min?: number;
  motor_max?: number;
  control_min_deg?: number;
  control_max_deg?: number;
  encoder?: Record<string, unknown>;
  encoder_to_model?: EncoderToModel;
  measured_stops?: Record<string, unknown>;
  safe_limits_rad?: SafeLimitsRad;
  control_defaults?: MotorControlDefaults;
  motion_profile?: Record<string, unknown>;
  joint_stop_profile_id?: string;
  notes?: string;
  [key: string]: unknown;
};

export type DeviceConfiguration = {
  schema: typeof DEVICE_CONFIGURATION_SCHEMA;
  revision: string;
  description: { base_urdf: string; [key: string]: unknown };
  hardware: Record<string, unknown>;
  calibration: {
    joints: Record<string, DeviceJointConfiguration>;
    metadata?: { global_motion_profile?: GlobalMotionProfile; [key: string]: unknown };
    [key: string]: unknown;
  };
  alignment: {
    joint_origins: Record<string, DeviceFrameDelta>;
    tcp_frames: Record<string, DeviceFrameDelta>;
    camera_frames?: Record<string, DeviceFixedFrame>;
    fixed_frames?: Record<string, DeviceFixedFrame>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type DeviceFrameDelta = {
  translation_m?: [number, number, number];
  rotation_rpy_rad?: [number, number, number];
};

/** A named, non-actuated frame that Edge materializes into the active URDF. */
export type DeviceFixedFrame = DeviceFrameDelta & {
  parent_link: string;
};

export type DeviceConfigurationPatch = {
  schema: typeof DEVICE_CONFIGURATION_PATCH_SCHEMA;
  base_revision: string;
  source?: { client?: string; [key: string]: unknown };
  calibration?: {
    joints?: Record<string, Partial<Pick<DeviceJointConfiguration,
    "encoder" | "encoder_to_model" | "measured_stops" | "safe_limits_rad" | "control_defaults" | "motion_profile" | "joint_stop_profile_id" | "notes"
    >>>;
    metadata?: { global_motion_profile: GlobalMotionProfile };
  };
  alignment?: Partial<{
    joint_origins: Record<string, DeviceFrameDelta>;
    tcp_frames: Record<string, DeviceFrameDelta>;
  }>;
};

export type DeviceConfigurationLineage = {
  schema: "vitrus.device.description-lineage.v1";
  device_revision: string;
  base_urdf_sha256: string;
  effective_urdf_sha256: string;
  compiler_version: string;
  /** SHA-256 of the authored URDF captured with this immutable revision. */
  authored_urdf_sha256?: string;
  /** SHA-256 of transform inputs compiled into the active URDF. */
  alignment_transforms_sha256?: string;
  [key: string]: unknown;
};

export type DeviceConfigurationSnapshot = {
  document: DeviceConfiguration;
  lineage?: DeviceConfigurationLineage;
  /** Atomically installed Edge revision; absent only on the legacy reader. */
  active?: {
    schema: "vitrus.device.active.v1";
    revision: string;
    previous_revision?: string | null;
    model_epoch: number;
    effective_urdf_sha256: string;
    legacy?: boolean;
  };
  effective_urdf?: { path: string; sha256?: string | null };
  authored_urdf?: { path: string | null; sha256?: string | null };
  /** Read-only mesh manifest paired with the authored URDF for Studio rebases. */
  authored_manifest?: { path: string | null; sha256?: string | null };
  broker?: { access_mode?: string; lease?: unknown; [key: string]: unknown };
};

/** Exact model identity that must travel with an executable control intent. */
export type DeviceModelBinding = {
  configurationRevision: string;
  effectiveUrdfSha256: string;
  modelEpoch: number;
};

export type DeviceConfigurationPreview = {
  document: DeviceConfiguration;
  lineage?: DeviceConfigurationLineage;
  effective_urdf_sha256?: string;
  diff: Array<{ path: string; before: unknown; after: unknown }>;
};

export function modelBindingFromSnapshot(snapshot: DeviceConfigurationSnapshot): DeviceModelBinding {
  const revision = snapshot.active?.revision ?? snapshot.document.revision;
  const effectiveUrdfSha256 = snapshot.active?.effective_urdf_sha256
    ?? snapshot.effective_urdf?.sha256
    ?? snapshot.lineage?.effective_urdf_sha256;
  const modelEpoch = snapshot.active?.model_epoch;
  if (!/^[a-f0-9]{64}$/.test(revision)) {
    throw new Error("Device model snapshot has no valid configuration revision");
  }
  if (!effectiveUrdfSha256 || !/^[a-f0-9]{64}$/.test(effectiveUrdfSha256)) {
    throw new Error("Device model snapshot has no valid effective URDF SHA-256");
  }
  if (typeof modelEpoch !== "number" || !Number.isSafeInteger(modelEpoch) || modelEpoch < 1) {
    throw new Error("Device model snapshot has no active model epoch; activate a revision on Edge first");
  }
  return { configurationRevision: revision, effectiveUrdfSha256, modelEpoch };
}

export class DeviceConfigurationConflictError extends Error {
  readonly code = "VITRUS_DEVICE_CONFIGURATION_REVISION_CONFLICT";
  constructor(readonly current?: DeviceConfigurationSnapshot) {
    super("Device configuration changed on Edge; re-read and rebase the patch");
  }
}

export type DeviceConfigurationClientOptions = {
  endpoint: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
};

export class DeviceConfigurationClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: DeviceConfigurationClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.requestTimeoutMs ?? 4_000;
    if (!this.endpoint) throw new Error("Device configuration endpoint is required");
  }
  private readonly timeoutMs: number;

  async get(): Promise<DeviceConfigurationSnapshot> {
    return this.request<DeviceConfigurationSnapshot>("/api/device/configuration", { method: "GET" });
  }

  /** Read the exact active revision used by Edge, including its model epoch. */
  async getModel(): Promise<DeviceConfigurationSnapshot> {
    return this.request<DeviceConfigurationSnapshot>("/api/device/model", { method: "GET" });
  }

  /** Validate a semantic patch without acquiring a lock or writing to the device. */
  async preview(patch: DeviceConfigurationPatch): Promise<DeviceConfigurationPreview> {
    if (patch.schema !== DEVICE_CONFIGURATION_PATCH_SCHEMA) throw new Error("Invalid device configuration patch schema");
    if (!/^[a-f0-9]{64}$/.test(patch.base_revision)) throw new Error("Device configuration patch requires a SHA-256 base_revision");
    return this.request<DeviceConfigurationPreview>("/api/device/configuration/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  /** Fetch the effective, already-materialized URDF rather than a local source copy. */
  async getEffectiveUrdf(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint}/api/device/description/robot.urdf`, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Effective URDF request failed (${response.status}): ${response.statusText}`);
      return response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch the immutable authored source attached to the active revision.
   * It is for inspection and explicit Studio rebases only; control/FK/IK must
   * use getEffectiveUrdf(), the one active aligned robot description.
   */
  async getAuthoredUrdf(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint}/api/device/description/base.urdf`, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Authored URDF request failed (${response.status}): ${response.statusText}`);
      return response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch the read-only mesh manifest paired with getAuthoredUrdf().
   * It is authoring input only; the effective URDF remains the sole model used
   * for live FK, IK, collision checks, and control.
   */
  async getAuthoredManifest(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint}/api/device/description/manifest`, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Authored manifest request failed (${response.status}): ${response.statusText}`);
      return response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Submit only declared paths. Edge validates, materializes, and activates. */
  async patch(patch: DeviceConfigurationPatch): Promise<DeviceConfigurationSnapshot> {
    if (patch.schema !== DEVICE_CONFIGURATION_PATCH_SCHEMA) throw new Error("Invalid device configuration patch schema");
    if (!/^[a-f0-9]{64}$/.test(patch.base_revision)) throw new Error("Device configuration patch requires a SHA-256 base_revision");
    return this.request<DeviceConfigurationSnapshot>("/api/device/configuration", {
      method: "PATCH",
      headers: { "content-type": "application/json", "if-match": patch.base_revision },
      body: JSON.stringify(patch),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint}${path}`, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => null) as T | DeviceConfigurationSnapshot | { error?: string } | null;
      if (response.status === 409) throw new DeviceConfigurationConflictError(
        payload && typeof payload === "object" && "document" in payload ? payload as DeviceConfigurationSnapshot : undefined,
      );
      if (!response.ok) {
        const detail = payload && typeof payload === "object" && "error" in payload ? payload.error : response.statusText;
        throw new Error(`Device configuration request failed (${response.status}): ${String(detail)}`);
      }
      if (!payload || typeof payload !== "object") throw new Error("Device configuration returned invalid JSON");
      return payload as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Pins a client to one Edge-installed model revision.  A caller refreshes it
 * at a safe command boundary; its binding then makes stale control fail closed
 * once Edge enables model-binding enforcement.
 */
export class DeviceModelSession {
  private constructor(
    readonly client: DeviceConfigurationClient,
    private _snapshot: DeviceConfigurationSnapshot,
  ) {}

  static async open(client: DeviceConfigurationClient): Promise<DeviceModelSession> {
    return new DeviceModelSession(client, await client.getModel());
  }

  get snapshot(): DeviceConfigurationSnapshot {
    return this._snapshot;
  }

  get binding(): DeviceModelBinding {
    return modelBindingFromSnapshot(this._snapshot);
  }

  async refresh(): Promise<DeviceConfigurationSnapshot> {
    this._snapshot = await this.client.getModel();
    return this._snapshot;
  }
}
