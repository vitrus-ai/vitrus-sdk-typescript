import { createJointTargetsMessage, type ControlJointTarget, type ControlJointTargetsMessage } from "./contracts.js";
import {
  EFFECTOR_COMMANDS_SCHEMA,
  createEffectorCommand,
  effectorsFromManifest,
  resolveEffectorCommand,
  type EffectorCommand,
  type EffectorCommandEnvelope,
  type EffectorInstance,
} from "./effectors.js";
import { GoldenEdgeClient } from "./golden-edge.js";
import type { ZenohEdgePublishResult, ZenohEdgeSession } from "./zenoh-edge.js";
import { normalizeDeviceStatus, type DeviceStatus } from "./device-status.js";

export type DroidRef = string | { serialNumber?: string; droidId?: string; alias?: string };

export type DroidIdentity = {
  id: string;
  serialNumber: string;
  model: string;
  displayName: string | null;
  organizationId: string;
  status: "online" | "offline" | "degraded" | "unknown";
  enrollmentState: "manufactured" | "unclaimed" | "claiming" | "enrolled" | "transferring" | "suspended" | "retired";
  transports?: Record<string, unknown>;
};

export type DroidDescription = {
  schema: "vitrus.droid.description.v1";
  revisionId: string;
  source: "clay";
  publishedBy: "vitrus-os";
  publishedAt: string;
  manifest?: Record<string, unknown>;
  robot?: Record<string, unknown>;
  cameras?: Array<Record<string, unknown>>;
  calibration?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  presetDefinitions?: DroidPresetDefinition[];
  presets?: DroidPresetInstance[];
};

export type DroidPresetVariable = {
  type: "number" | "boolean" | "enum";
  default: number | boolean | string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
};

export type DroidPresetActuatorKind = "bldc" | "servo";
export type DroidPresetCommandMode = "position" | "velocity" | "torque";
export type DroidPresetFeedbackField = "position" | "velocity" | "torque" | "temperature" | "fault";

export type DroidPresetActuatorSlot = {
  id: string;
  label: string;
  kind: DroidPresetActuatorKind;
  commandModes: DroidPresetCommandMode[];
  feedback: DroidPresetFeedbackField[];
};

export type DroidPresetOutput = {
  id: string;
  label: string;
  type: "number" | "boolean" | "enum";
  unit?: string;
  options?: string[];
};

export type DroidPresetDefinition = {
  definitionId: string;
  version: string;
  label: string;
  description?: string;
  targetType?: "gripper" | "arm" | "mobile_base" | "custom";
  artifactHash: string;
  actuatorSlots: DroidPresetActuatorSlot[];
  inputs: Record<string, DroidPresetVariable>;
  outputs: DroidPresetOutput[];
};

export type DroidPresetInstance = {
  presetId: string;
  instanceId: string;
  definitionId?: string;
  definitionVersion?: string;
  artifactHash?: string;
  label?: string;
  description?: string;
  color?: string;
  gripperGroup: string;
  targetType?: "gripper" | "arm" | "mobile_base" | "custom";
  targetId?: string;
  controllerSide?: "left" | "right";
  variables: Record<string, DroidPresetVariable>;
  channels: Array<{ id: string; label?: string; input?: string; ratePctPerSecond?: number }>;
  actuatorBindings?: Record<string, string>;
  available?: boolean;
  unavailableReason?: string;
  inputBindings?: Array<{ input: string; variableId: string; mode: "rate" | "absolute"; deadzone?: number; invert?: boolean }>;
};

export type DroidPresetRun = {
  runId: string;
  instanceId: string;
  definitionId: string;
  definitionVersion: string;
  artifactHash: string;
  status: "starting" | "running" | "stopping" | "completed" | "failed" | "stopped";
  leaseId?: string;
  startedAt?: string;
  stoppedAt?: string;
  fault?: string;
};

export type DroidPresetState = DroidPresetRun & {
  sequence: number;
  inputs: Record<string, number | boolean | string>;
  outputs: Record<string, number | boolean | string>;
  actuators: Record<string, {
    actuatorId: string;
    position?: number;
    velocity?: number;
    torque?: number;
    temperature?: number;
    fault?: string | null;
  }>;
};

export type DroidPresetStartOptions = {
  inputs?: Record<string, number | boolean | string>;
  leaseId?: string;
};

export type DroidPresetInputOptions = {
  sequence?: number;
  leaseId?: string;
};

export function presetDefinitionsFromDescription(description: DroidDescription): DroidPresetDefinition[] {
  if (Array.isArray(description.presetDefinitions)) return description.presetDefinitions;
  const manifest = parseJsonRecord(description.manifest);
  const candidates = Array.isArray(manifest.preset_motion_definitions)
    ? manifest.preset_motion_definitions
    : Array.isArray(manifest.presetDefinitions)
      ? manifest.presetDefinitions
      : [];
  return candidates.flatMap((candidate) => {
    const raw = parseJsonRecord(candidate);
    if (typeof raw.definition_id !== "string" || typeof raw.version !== "string" || typeof raw.artifact_hash !== "string") return [];
    const slots = Array.isArray(raw.actuator_slots)
      ? raw.actuator_slots.flatMap((slot) => {
          const value = parseJsonRecord(slot);
          if (typeof value.id !== "string" || typeof value.label !== "string") return [];
          const kind: DroidPresetActuatorKind | null = value.kind === "bldc" || value.kind === "servo" ? value.kind : null;
          if (!kind) return [];
          const commandModes = Array.isArray(value.command_modes)
            ? value.command_modes.filter((mode): mode is DroidPresetCommandMode => mode === "position" || mode === "velocity" || mode === "torque")
            : [];
          const feedback = Array.isArray(value.feedback)
            ? value.feedback.filter((field): field is DroidPresetFeedbackField => ["position", "velocity", "torque", "temperature", "fault"].includes(field as string))
            : [];
          return [{ id: value.id, label: value.label, kind, commandModes, feedback }];
        })
      : [];
    const inputs = parseJsonRecord(raw.inputs) as Record<string, DroidPresetVariable>;
    const outputs = Array.isArray(raw.outputs)
      ? raw.outputs.flatMap((output) => {
          const value = parseJsonRecord(output);
          if (typeof value.id !== "string" || typeof value.label !== "string") return [];
          if (value.type !== "number" && value.type !== "boolean" && value.type !== "enum") return [];
          return [{
            id: value.id,
            label: value.label,
            type: value.type,
            ...(typeof value.unit === "string" ? { unit: value.unit } : {}),
            ...(Array.isArray(value.options) ? { options: value.options.filter((option): option is string => typeof option === "string") } : {}),
          } satisfies DroidPresetOutput];
        })
      : [];
    return [{
      definitionId: raw.definition_id,
      version: raw.version,
      label: typeof raw.label === "string" ? raw.label : raw.definition_id,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.target_type === "string" ? { targetType: raw.target_type as DroidPresetDefinition["targetType"] } : {}),
      artifactHash: raw.artifact_hash,
      actuatorSlots: slots,
      inputs,
      outputs,
    } satisfies DroidPresetDefinition];
  });
}

export function presetInstancesFromDescription(description: DroidDescription): DroidPresetInstance[] {
  if (Array.isArray(description.presets)) return description.presets;
  const manifest = parseJsonRecord(description.manifest);
  const mechanisms = Array.isArray(manifest.mechanisms) ? manifest.mechanisms : [];
  return mechanisms.flatMap((candidate) => {
    const mechanism = parseJsonRecord(candidate);
    if (mechanism.type !== "multi_axis_effector") return [];
    const preset = parseJsonRecord(mechanism.preset);
    if (typeof preset.preset_id !== "string" || typeof preset.instance_id !== "string") return [];
    const variables = parseJsonRecord(preset.variables) as Record<string, DroidPresetVariable>;
    const channels = Array.isArray(mechanism.channels)
      ? mechanism.channels.map((channel) => {
          const value = parseJsonRecord(channel);
          return {
            id: typeof value.id === "string" ? value.id : "",
            ...(typeof value.label === "string" ? { label: value.label } : {}),
            ...(typeof value.input === "string" ? { input: value.input } : {}),
            ...(typeof value.rate_pct_per_second === "number" ? { ratePctPerSecond: value.rate_pct_per_second } : {}),
          };
        }).filter((channel) => channel.id)
      : [];
    const inputBindings = Array.isArray(preset.input_bindings)
      ? preset.input_bindings.flatMap((binding) => {
          const value = parseJsonRecord(binding);
          if (typeof value.input !== "string" || typeof value.variable_id !== "string") return [];
          return [{
            input: value.input,
            variableId: value.variable_id,
            mode: value.mode === "absolute" ? "absolute" as const : "rate" as const,
            ...(typeof value.deadzone === "number" ? { deadzone: value.deadzone } : {}),
            ...(typeof value.invert === "boolean" ? { invert: value.invert } : {}),
          }];
        })
      : [];
    return [{
      presetId: preset.preset_id,
      instanceId: preset.instance_id,
      ...(typeof preset.definition_id === "string" ? { definitionId: preset.definition_id } : {}),
      ...(typeof preset.definition_version === "string" ? { definitionVersion: preset.definition_version } : {}),
      ...(typeof preset.artifact_hash === "string" ? { artifactHash: preset.artifact_hash } : {}),
      ...(typeof preset.label === "string" ? { label: preset.label } : {}),
      ...(typeof preset.description === "string" ? { description: preset.description } : {}),
      ...(typeof preset.color === "string" ? { color: preset.color } : {}),
      gripperGroup: typeof mechanism.gripper_group === "string" ? mechanism.gripper_group : "",
      ...(typeof preset.target_type === "string" ? { targetType: preset.target_type as DroidPresetInstance["targetType"] } : {}),
      ...(typeof preset.target_id === "string" ? { targetId: preset.target_id } : {}),
      ...(mechanism.controller_side === "left" || mechanism.controller_side === "right" ? { controllerSide: mechanism.controller_side } : {}),
      variables,
      channels,
      ...(Object.keys(parseJsonRecord(preset.actuator_bindings)).length
        ? { actuatorBindings: parseJsonRecord(preset.actuator_bindings) as Record<string, string> }
        : {}),
      ...(typeof preset.available === "boolean" ? { available: preset.available } : {}),
      ...(typeof preset.unavailable_reason === "string" ? { unavailableReason: preset.unavailable_reason } : {}),
      ...(inputBindings.length ? { inputBindings } : {}),
    } satisfies DroidPresetInstance];
  });
}

export type CameraFrame = {
  camera: string;
  frameId: string;
  mimeType: string;
  capturedAt: string;
  imageUrl?: string;
  dataBase64?: string;
  width?: number;
  height?: number;
};

export type DroidCamera = Record<string, unknown> & {
  name: string;
  ready?: boolean;
  fps?: number;
  stream_url?: string;
  snapshot_url?: string;
};

export type CameraIntrinsics = {
  model?: string;
  matrix?: number[][];
  distortion?: number[];
  rectifiedMatrix?: number[][];
  imageSize?: [number, number];
  focalLengthMm?: number;
  rmsReprojectionError?: number;
  checkerboard?: [number, number];
  squareSizeM?: number;
  raw: Record<string, unknown>;
};

export type CameraExtrinsics = {
  parentFrame?: string;
  cameraFrame?: string;
  translationM?: [number, number, number];
  rotationQuaternionXyzw?: [number, number, number, number];
  direction?: [number, number, number];
  raw: Record<string, unknown>;
};

export type CameraCalibration = {
  camera: string;
  calibrated: boolean;
  appliesToFeed: boolean;
  calibrationPath?: string;
  intrinsics?: CameraIntrinsics;
  extrinsics?: CameraExtrinsics;
  raw: { camera?: Record<string, unknown>; calibration?: Record<string, unknown>; description?: Record<string, unknown> };
};

export type CameraMediaTransport = "webrtc" | "moq" | "mjpeg" | "snapshot";

export type CameraMediaSession = {
  id: string;
  droidId: string;
  camera: string;
  expiresAt: string;
  transport: CameraMediaTransport;
  route: "direct" | "vpn" | "relay";
  offerUrl?: string;
  streamUrl?: string;
  snapshotUrl?: string;
  iceServers?: RTCIceServer[];
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: string;
  requiresAuthorization?: boolean;
};

export type DroidTelemetry = {
  schema: string;
  timestamp: string;
  joints?: Record<string, unknown>;
  cameras?: Array<Record<string, unknown>>;
  motorBridge?: Record<string, unknown>;
  raw: Record<string, unknown>;
};

export type ControlLease = {
  id: string;
  droidId: string;
  owner: string;
  expiresAt: string;
};

export type DroidRealtimeState = "connecting" | "connected" | "reconnecting" | "closed" | "error";

export type DroidRealtimeEvent =
  | { type: "droid.updated"; droid: DroidIdentity }
  | { type: "droid.status"; droid: Pick<DroidIdentity, "id" | "serialNumber">; status: Record<string, unknown> }
  | { type: "droid.telemetry"; droid: Pick<DroidIdentity, "id" | "serialNumber">; telemetry: Record<string, unknown> }
  | { type: "droid.cameras.updated"; droid: Pick<DroidIdentity, "id" | "serialNumber">; cameras: DroidCamera[] }
  | { type: "droid.description.updated"; droid: Pick<DroidIdentity, "id" | "serialNumber">; description: DroidDescription };

export type DroidRealtimeSubscription = {
  readonly state: DroidRealtimeState;
  close: () => void;
};

export type JointTarget = {
  jointName: string;
  displayDeg: number;
  durationS?: number;
  maxVelocityDegS?: number;
  maxAccelerationDegS2?: number;
  /** Per-joint measured-load stop, enforced by VitrusOS. */
  maxTorqueNm?: number;
};

export type DroidTargetOptions = {
  leaseId: string;
  /** End-to-end command lifetime; this is not the HTTP request timeout. */
  ttlMs?: number;
  /**
   * Maximum time the Edge may locally refresh an admitted positional target.
   * The Edge still validates ttlMs before starting and cuts to read_only when
   * this bounded keepalive expires without a newer target.
   */
  edgeKeepaliveMs?: number;
  /**
   * Versioned anatomy-specific intent. VitrusOS re-resolves this envelope
   * against its active robot-local model before applying any effector target.
   */
  effectorCommands?: EffectorCommand[];
  /** @deprecated Use ttlMs. Kept for source compatibility with SDK 0.2.x. */
  timeoutMs?: number;
};

export type DroidEffectorCommandOptions = DroidTargetOptions & { maxTorqueNm?: number };

export type DroidPrimeAndWaitReadyOptions = DroidTargetOptions & {
  /** End-to-end wait for the Edge broker to accept the aligned hold. */
  readinessTimeoutMs?: number;
  /** Telemetry polling interval while the queued Dataplane commands apply. */
  pollIntervalMs?: number;
};

export type DroidMotionReady = {
  admission: DroidCommandResult;
  telemetry: DroidTelemetry;
  motorBridge: Record<string, unknown>;
  phase: "ready_for_realtime";
  leaseId: string;
  acceptedTargetCount: number;
  appliedTargetCount: number;
  originSequence: number;
};

export type JointTargetCommand = ControlJointTargetsMessage;

export type DroidCommandResult = {
  requestId: string;
  status: "queued" | "sent" | "acknowledged" | "timeout" | "failed" | "not_reachable";
  route: "relay" | "local";
  result?: Record<string, unknown>;
  error?: string;
};

export type DroidConnectionOptions = {
  apiKey: string;
  relayUrl?: string;
  endpoint?: string;
  edgeEndpoint?: string;
  /** Full URL for an Edge-local telemetry snapshot compatible with DroidTelemetry. */
  edgeTelemetryUrl?: string;
  /** Full URL for the canonical Edge-local vitrus.device.status.v1 snapshot. */
  edgeStatusUrl?: string;
  /** Lease lifecycle route. Edge keeps acquire/renew/release robot-local. */
  controlTransport?: "bridge" | "edge";
  motionTransport?: "bridge" | "edge" | "zenoh";
  zenohEndpoint?: string;
  zenohTopic?: string;
  zenohSessionFactory?: () => Promise<ZenohEdgeSession>;
  /** Timeout for identity, leases, telemetry, and other control-plane HTTP. */
  controlPlaneTimeoutMs?: number;
  /** Timeout for local Edge admission of one motion frame. */
  motionAdmissionTimeoutMs?: number;
  /** @deprecated Use controlPlaneTimeoutMs. */
  timeoutMs?: number;
  clientId?: string;
  webSocketFactory?: (url: string) => WebSocket;
};

export class DroidRequestTimeoutError extends Error {
  readonly code = "VITRUS_REQUEST_TIMEOUT";

  constructor(
    readonly operation: string,
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`Vitrus ${operation} timed out after ${timeoutMs} ms (${path})`);
    this.name = "DroidRequestTimeoutError";
  }
}

const DEFAULT_ZENOH_WS_ENDPOINT = "ws://127.0.0.1:7448";

function cleanUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteNumbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const flattened = value.flat(Infinity);
  return flattened.every((item) => finiteNumber(item) !== undefined) ? flattened as number[] : undefined;
}

function finiteMatrix(value: unknown): number[][] | undefined {
  if (!Array.isArray(value) || !value.every(Array.isArray)) return undefined;
  return value.every((row) => (row as unknown[]).every((item) => finiteNumber(item) !== undefined)) ? value as number[][] : undefined;
}

function fixedVector(value: unknown, length: number): number[] | undefined {
  const numbers = finiteNumbers(value);
  return numbers?.length === length ? numbers : undefined;
}

function cameraAliases(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const short = normalized.replace(/^camera_/, "").replace(/_camera$/, "");
  return normalized === short ? [normalized] : [normalized, short];
}

function findCamera(records: unknown, requested: string): Record<string, unknown> | undefined {
  if (!Array.isArray(records)) return undefined;
  const aliases = new Set(cameraAliases(requested));
  return records.map(parseJsonRecord).find((record) =>
    ["name", "safe_name", "display_name", "configured_name", "stable_id", "camera_id"]
      .flatMap((key) => cameraAliases(record[key]))
      .some((alias) => aliases.has(alias)),
  );
}

function firstRecord(...values: unknown[]): Record<string, unknown> {
  return values.map(parseJsonRecord).find((value) => Object.keys(value).length > 0) ?? {};
}

function looksLikeMotorBridge(value: Record<string, unknown>): boolean {
  return typeof value.access_mode === "string" && typeof value.control_phase === "string";
}

export function normalizeDroidTelemetry(value: unknown): DroidTelemetry {
  const raw = parseJsonRecord(value);
  const nestedRaw = parseJsonRecord(raw.raw);
  const explicitJoints = parseJsonRecord(raw.joints);
  const joints = Object.keys(explicitJoints).length
    ? explicitJoints
    : Array.isArray(raw.motors)
      ? Object.fromEntries(
        raw.motors
          .map(parseJsonRecord)
          .filter((motor) => typeof motor.joint_name === "string" && motor.joint_name)
          .map((motor) => [String(motor.joint_name), motor]),
      )
      : {};
  const motorBridgeCandidates = [
    parseJsonRecord(raw.motor_bridge),
    parseJsonRecord(raw.motorBridge),
    parseJsonRecord(nestedRaw.motor_bridge),
    parseJsonRecord(nestedRaw.motorBridge),
    raw,
    nestedRaw,
  ];
  const motorBridge = motorBridgeCandidates.find(looksLikeMotorBridge) ?? {};
  return {
    schema: typeof raw.schema === "string" ? raw.schema : "vitrus.telemetry.state.v1",
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
    joints,
    cameras: Array.isArray(raw.cameras) ? raw.cameras.map(parseJsonRecord) : undefined,
    motorBridge,
    raw,
  };
}

/** Validate the lease window accepted by the VitrusOS embodiment relay. */
export function validateDroidLeaseDurationMs(value: number | undefined): number | undefined {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || value < 1_000 || value > 30_000) {
    throw new RangeError("Vitrus control lease durationMs must be an integer in [1000, 30000]");
  }
  return value;
}

export class Droid {
  static async connect(ref: DroidRef, options: DroidConnectionOptions): Promise<Droid> {
    const droid = new Droid(ref, options);
    await droid.identity.get();
    return droid;
  }

  readonly identity: { get: () => Promise<DroidIdentity> };
  readonly description: { get: () => Promise<DroidDescription> };
  readonly presets: {
    list: () => Promise<DroidPresetInstance[]>;
    instances: () => Promise<DroidPresetInstance[]>;
    definitions: () => Promise<DroidPresetDefinition[]>;
    start: (instanceId: string, options?: DroidPresetStartOptions) => Promise<DroidPresetRun>;
    setInputs: (runId: string, inputs: Record<string, number | boolean | string>, options?: DroidPresetInputOptions) => Promise<DroidPresetState>;
    state: (runId: string) => Promise<DroidPresetState>;
    stop: (runId: string, options?: { leaseId?: string }) => Promise<DroidPresetRun>;
  };
  readonly effectors: {
    list: () => Promise<EffectorInstance[]>;
    command: (
      effectorId: string,
      values: Record<string, number | boolean | string>,
      options: DroidEffectorCommandOptions,
    ) => Promise<DroidCommandResult>;
    commandMany: (commands: EffectorCommand[], options: DroidTargetOptions) => Promise<DroidCommandResult>;
  };
  readonly camera: {
    list: () => Promise<DroidCamera[]>;
    getFrame: (camera: string) => Promise<CameraFrame>;
    getCalibration: (camera: string) => Promise<CameraCalibration | null>;
    openSession: (camera: string, options?: { preferredTransport?: CameraMediaTransport | "auto" }) => Promise<CameraMediaSession>;
    closeSession: (sessionId: string) => Promise<void>;
  };
  readonly telemetry: {
    snapshot: () => Promise<DroidTelemetry>;
    subscribe: (listener: (telemetry: DroidTelemetry) => void, options?: { onStateChange?: (state: DroidRealtimeState, error?: Error) => void }) => Promise<DroidRealtimeSubscription>;
  };
  readonly status: {
    snapshot: () => Promise<DeviceStatus>;
    subscribe: (listener: (status: DeviceStatus) => void, options?: { onStateChange?: (state: DroidRealtimeState, error?: Error) => void }) => Promise<DroidRealtimeSubscription>;
  };
  readonly events: {
    subscribe: (listener: (event: DroidRealtimeEvent) => void, options?: { onStateChange?: (state: DroidRealtimeState, error?: Error) => void }) => Promise<DroidRealtimeSubscription>;
  };
  readonly control: {
    acquire: (options?: { durationMs?: number; owner?: string; jointNames?: string[] }) => Promise<ControlLease>;
    renew: (leaseId: string, options?: { durationMs?: number }) => Promise<ControlLease>;
    release: (leaseId: string) => Promise<void>;
  };
  readonly motion: {
    sendTargets: (targets: JointTarget[], options: DroidTargetOptions) => Promise<DroidCommandResult>;
    primeAndWaitReady: (targets: JointTarget[], options: DroidPrimeAndWaitReadyOptions) => Promise<DroidMotionReady>;
  };
  readonly safety: { emergencyStop: (reason?: string) => Promise<DroidCommandResult> };

  private sequence = 0;
  private identityCache: DroidIdentity | null = null;
  private edgeClient: GoldenEdgeClient | null = null;
  private edgeLeaseId: string | null = null;
  private edgeControlOwner: string | null = null;
  private edgeControlJointNames: string[] = [];
  // Keep Zenoh optional for normal browser/Bridge clients. A static import here
  // pulls its WASM bindings into every dashboard bundle.
  private zenohClient: { setLease(leaseId: string): void; publish(command: ControlJointTargetsMessage): Promise<ZenohEdgePublishResult> } | null = null;
  private zenohLeaseId: string | null = null;
  private readonly clientId: string;

  private constructor(private readonly ref: DroidRef, private readonly options: DroidConnectionOptions) {
    this.clientId = options.clientId?.trim() || `vitrus-sdk-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    this.identity = { get: async () => {
      if (this.identityCache) return this.identityCache;
      const identity = await this.get<DroidIdentity>("/v1/droids/resolve");
      this.identityCache = identity;
      return identity;
    } };
    this.description = { get: () => this.get<DroidDescription>("/v1/droids/description") };
    this.presets = {
      list: async () => presetInstancesFromDescription(await this.description.get()),
      instances: async () => presetInstancesFromDescription(await this.description.get()),
      definitions: async () => presetDefinitionsFromDescription(await this.description.get()),
      start: (instanceId, request = {}) => this.post<DroidPresetRun>("/v1/droids/preset-motions/runs", {
        instanceId,
        inputs: request.inputs ?? {},
        ...(request.leaseId ? { leaseId: request.leaseId } : {}),
      }),
      setInputs: (runId, inputs, request = {}) => this.post<DroidPresetState>(`/v1/droids/preset-motions/runs/${encodeURIComponent(runId)}/inputs`, {
        inputs,
        ...(request.sequence == null ? {} : { sequence: request.sequence }),
        ...(request.leaseId ? { leaseId: request.leaseId } : {}),
      }),
      state: (runId) => this.get<DroidPresetState>(`/v1/droids/preset-motions/runs/${encodeURIComponent(runId)}`),
      stop: (runId, request = {}) => this.post<DroidPresetRun>(`/v1/droids/preset-motions/runs/${encodeURIComponent(runId)}/stop`, request),
    };
    this.effectors = {
      list: async () => effectorsFromManifest((await this.description.get()).manifest),
      command: async (effectorId, values, request) => {
        const instances = await this.effectors.list();
        const instance = instances.find((candidate) => candidate.id === effectorId);
        if (!instance) throw new Error(`UNKNOWN_EFFECTOR: ${effectorId}`);
        const { maxTorqueNm, ...targetRequest } = request;
        return this.sendTargets([], {
          ...targetRequest,
          effectorCommands: [createEffectorCommand(instance, values, { maxTorqueNm })],
        });
      },
      commandMany: (commands, request) => this.sendTargets([], {
        ...request,
        effectorCommands: commands,
      }),
    };
    this.camera = {
      list: () => this.get<DroidCamera[]>("/v1/droids/cameras"),
      getFrame: (camera) => this.get<CameraFrame>("/v1/droids/cameras/frame", { camera }),
      getCalibration: (camera) => this.getCameraCalibration(camera),
      openSession: (camera, request = {}) => this.post<CameraMediaSession>("/v1/droids/cameras/sessions", { camera, preferredTransport: request.preferredTransport ?? "auto" }),
      closeSession: async (sessionId) => { await this.delete(`/v1/droids/cameras/sessions/${encodeURIComponent(sessionId)}`); },
    };
    this.telemetry = {
      snapshot: async () => normalizeDroidTelemetry(
        this.options.edgeTelemetryUrl
          ? await this.request<unknown>(
            this.options.edgeTelemetryUrl,
            { method: "GET" },
            "GET edge telemetry",
          )
          : await this.get<unknown>("/v1/droids/telemetry"),
      ),
      subscribe: (listener, request) => this.subscribeEvents((event) => {
        if (event.type !== "droid.telemetry") return;
        listener(normalizeDroidTelemetry(event.telemetry));
      }, request),
    };
    this.status = {
      snapshot: async () => normalizeDeviceStatus(
        this.options.edgeStatusUrl
          ? await this.request<unknown>(this.options.edgeStatusUrl, { method: "GET" }, "GET edge status")
          : await this.get<unknown>("/v1/droids/status"),
      ),
      subscribe: (listener, request) => this.subscribeEvents((event) => {
        if (event.type !== "droid.status") return;
        listener(normalizeDeviceStatus(event.status));
      }, request),
    };
    this.events = { subscribe: (listener, request) => this.subscribeEvents(listener, request) };
    this.control = {
      acquire: async (request = {}) => {
        const durationMs = validateDroidLeaseDurationMs(request.durationMs) ?? 15_000;
        const owner = request.owner?.trim() || this.clientId;
        const directControl = this.options.controlTransport === "edge";
        const identity = await this.identity.get();
        const lease: ControlLease = directControl
          ? {
            id: globalThis.crypto?.randomUUID?.() ?? `edge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            droidId: identity.id,
            owner,
            expiresAt: new Date(Date.now() + durationMs).toISOString(),
          }
          : await this.post<ControlLease>("/v1/droids/control/leases", { durationMs, owner });
        if ((this.options.motionTransport ?? "bridge") === "edge") {
          if (!this.options.edgeEndpoint || !request.jointNames?.length) {
            if (!directControl) await this.delete(`/v1/droids/control/leases/${encodeURIComponent(lease.id)}`).catch(() => undefined);
            throw new Error("Droid edge acquire requires edgeEndpoint and explicit jointNames");
          }
          if (!this.edgeClient) {
            this.edgeClient = new GoldenEdgeClient({
              endpoint: this.options.edgeEndpoint,
              robotId: identity.id,
              leaseId: lease.id,
              source: "vitrus-sdk",
              requestTimeoutMs: this.options.motionAdmissionTimeoutMs ?? 1_000,
            });
          }
          try {
            await this.edgeClient.acquire(lease.id, { owner, durationMs, jointNames: request.jointNames });
            this.edgeLeaseId = lease.id;
            this.edgeControlOwner = owner;
            this.edgeControlJointNames = [...request.jointNames];
          } catch (error) {
            if (!directControl) await this.delete(`/v1/droids/control/leases/${encodeURIComponent(lease.id)}`).catch(() => undefined);
            throw error;
          }
        }
        return lease;
      },
      renew: async (leaseId, request = {}) => {
        const durationMs = validateDroidLeaseDurationMs(request.durationMs) ?? 15_000;
        if (this.options.controlTransport === "edge") {
          if (!this.edgeClient || leaseId !== this.edgeLeaseId || !this.edgeControlOwner || !this.edgeControlJointNames.length) {
            throw new Error("Cannot renew a non-active Edge lease");
          }
          await this.edgeClient.acquire(leaseId, {
            owner: this.edgeControlOwner,
            durationMs,
            jointNames: this.edgeControlJointNames,
          });
          return {
            id: leaseId,
            droidId: (await this.identity.get()).id,
            owner: this.edgeControlOwner,
            expiresAt: new Date(Date.now() + durationMs).toISOString(),
          };
        }
        return this.post<ControlLease>(`/v1/droids/control/leases/${encodeURIComponent(leaseId)}/renew`, { durationMs });
      },
      release: async (leaseId) => {
        let edgeError: unknown;
        // Edge motion must release through the same low-latency local path
        // that admitted its targets. The Bridge DELETE remains necessary to
        // revoke cloud authority, but enqueue success alone is not physical
        // torque-off acknowledgement.
        if ((this.options.motionTransport ?? "bridge") === "edge" && this.edgeClient) {
          try {
            await this.edgeClient.release(leaseId);
          } catch (error) {
            edgeError = error;
          }
        }
        if (this.options.controlTransport !== "edge") {
          await this.delete(`/v1/droids/control/leases/${encodeURIComponent(leaseId)}`);
        }
        this.edgeControlOwner = null;
        this.edgeControlJointNames = [];
        if (edgeError) throw edgeError;
      },
    };
    this.motion = {
      sendTargets: (targets, request) => this.sendTargets(targets, request),
      primeAndWaitReady: (targets, request) => this.primeAndWaitReady(targets, request),
    };
    this.safety = {
      emergencyStop: (reason = "operator_requested") => this.post<DroidCommandResult>("/v1/droids/safety/emergency-stop", { reason }),
    };
  }

  private async getCameraCalibration(camera: string): Promise<CameraCalibration | null> {
    const [cameras, description] = await Promise.all([this.camera.list(), this.description.get()]);
    const cameraRecord = findCamera(cameras, camera) ?? {};
    const manifest = parseJsonRecord(description.manifest);
    const robot = parseJsonRecord(description.robot);
    const descriptionRecord = findCamera(description.cameras, camera) ?? findCamera(manifest.cameras, camera) ?? findCamera(robot.cameras, camera) ?? {};
    const fisheye = parseJsonRecord(cameraRecord.fisheye);
    const calibration = firstRecord(cameraRecord.calibration, fisheye);
    const describedIntrinsics = parseJsonRecord(descriptionRecord.intrinsics);
    const calibratedIntrinsics = firstRecord(calibration.intrinsics, fisheye.intrinsics);
    const matrix = finiteMatrix(calibratedIntrinsics.matrix ?? calibratedIntrinsics.K ?? calibration.K ?? fisheye.K);
    const distortion = finiteNumbers(calibratedIntrinsics.distortion ?? calibratedIntrinsics.D ?? calibration.D ?? fisheye.D);
    const rectifiedMatrix = finiteMatrix(calibratedIntrinsics.rectified_matrix ?? calibratedIntrinsics.new_K ?? calibration.new_K ?? fisheye.new_K);
    const imageSize = fixedVector(calibratedIntrinsics.image_size ?? calibration.image_size ?? fisheye.image_size ?? describedIntrinsics.resolution, 2) as [number, number] | undefined;
    const checkerboard = fixedVector(calibratedIntrinsics.checkerboard ?? calibration.checkerboard ?? fisheye.checkerboard, 2) as [number, number] | undefined;
    const hasIntrinsics = !!(matrix || distortion || rectifiedMatrix || imageSize || Object.keys(describedIntrinsics).length);
    const extrinsics = firstRecord(calibration.extrinsics, cameraRecord.extrinsics, descriptionRecord.extrinsics);
    const translation = fixedVector(extrinsics.translation_m ?? extrinsics.translation ?? descriptionRecord.local_origin, 3) as [number, number, number] | undefined;
    const quaternion = fixedVector(extrinsics.rotation_quaternion_xyzw ?? extrinsics.quaternion_xyzw ?? descriptionRecord.local_quaternion_xyzw, 4) as [number, number, number, number] | undefined;
    const direction = fixedVector(descriptionRecord.direction, 3) as [number, number, number] | undefined;
    const parentFrame = typeof extrinsics.parent_frame === "string" ? extrinsics.parent_frame : typeof descriptionRecord.parent_link === "string" ? descriptionRecord.parent_link : undefined;
    const cameraFrame = typeof extrinsics.camera_frame === "string" ? extrinsics.camera_frame : typeof descriptionRecord.name === "string" ? descriptionRecord.name : undefined;
    const hasExtrinsics = !!(translation || quaternion || direction || parentFrame || cameraFrame);
    if (!hasIntrinsics && !hasExtrinsics && Object.keys(calibration).length === 0) return null;
    return {
      camera,
      calibrated: calibration.calibrated === true || cameraRecord.calibrated === true,
      appliesToFeed: calibration.applies_to_feed === true || cameraRecord.applies_to_feed === true,
      calibrationPath: typeof calibration.calibration_path === "string" ? calibration.calibration_path : typeof cameraRecord.calibration_path === "string" ? cameraRecord.calibration_path : undefined,
      intrinsics: hasIntrinsics ? {
        model: typeof describedIntrinsics.projection === "string" ? describedIntrinsics.projection : Object.keys(fisheye).length ? "fisheye" : undefined,
        matrix,
        distortion,
        rectifiedMatrix,
        imageSize,
        focalLengthMm: finiteNumber(describedIntrinsics.focal_length_mm),
        rmsReprojectionError: finiteNumber(calibratedIntrinsics.rms ?? calibration.rms ?? fisheye.rms),
        checkerboard,
        squareSizeM: finiteNumber(calibratedIntrinsics.square_size ?? calibration.square_size ?? fisheye.square_size),
        raw: { description: describedIntrinsics, calibration: calibratedIntrinsics, fisheye },
      } : undefined,
      extrinsics: hasExtrinsics ? { parentFrame, cameraFrame, translationM: translation, rotationQuaternionXyzw: quaternion, direction, raw: { calibration: extrinsics, description: descriptionRecord } } : undefined,
      raw: { camera: cameraRecord, calibration, description: descriptionRecord },
    };
  }

  private async subscribeEvents(listener: (event: DroidRealtimeEvent) => void, options: { onStateChange?: (state: DroidRealtimeState, error?: Error) => void } = {}): Promise<DroidRealtimeSubscription> {
    const identity = this.identityCache ?? await this.identity.get();
    let socket: WebSocket | null = null;
    let state: DroidRealtimeState = "connecting";
    let closed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const subscription: DroidRealtimeSubscription = {
      get state() { return state; },
      close: () => {
        closed = true;
        state = "closed";
        if (reconnectTimer) clearTimeout(reconnectTimer);
        socket?.close(1000, "client closed");
        options.onStateChange?.(state);
      },
    };
    const changeState = (next: DroidRealtimeState, error?: Error) => { state = next; options.onStateChange?.(next, error); };
    const scheduleReconnect = (error: Error) => {
      if (closed || reconnectTimer) return;
      changeState("reconnecting", error);
      const delay = Math.min(10_000, 250 * 2 ** Math.min(reconnectAttempt++, 6));
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    };
    const connect = () => {
      if (closed) return;
      changeState(reconnectAttempt ? "reconnecting" : "connecting");
      try {
        socket = (this.options.webSocketFactory ?? ((url) => new WebSocket(url)))(this.realtimeUrl());
      } catch (error) {
        scheduleReconnect(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      socket.addEventListener("open", () => { reconnectAttempt = 0; socket?.send(JSON.stringify({ type: "subscribe", topics: ["droids"] })); changeState("connected"); });
      socket.addEventListener("message", (message) => {
        try {
          const event = JSON.parse(String(message.data)) as DroidRealtimeEvent | { type: string };
          if (!("droid" in event) || !event.droid) return;
          const eventDroid = event.droid as Partial<DroidIdentity>;
          if (eventDroid.id !== identity.id && eventDroid.serialNumber !== identity.serialNumber) return;
          listener(event as DroidRealtimeEvent);
        } catch { /* ignore malformed or unrelated messages */ }
      });
      socket.addEventListener("close", () => { if (!closed) scheduleReconnect(new Error("Vitrus Bridge realtime connection closed")); });
      socket.addEventListener("error", () => { if (!closed) changeState("error", new Error("Vitrus Bridge realtime connection failed")); });
    };
    connect();
    return subscription;
  }

  private async sendTargets(targets: JointTarget[], request: DroidTargetOptions): Promise<DroidCommandResult> {
    const identity = await this.identity.get();
    let semanticEffectors: EffectorCommandEnvelope | undefined;
    const controlTargets: ControlJointTarget[] = targets.map((target) => ({
      joint_name: target.jointName,
      position_deg: target.displayDeg,
      ...(target.maxVelocityDegS == null ? {} : {
        // Keep the canonical field for older consumers and also name the
        // Edge positional-track limit explicitly. VitrusOS owns the actual
        // velocity trajectory when trajectory_owner is "edge".
        velocity_deg_s: target.maxVelocityDegS,
        eased_max_velocity_deg_s: target.maxVelocityDegS,
      }),
      ...(target.maxAccelerationDegS2 == null ? {} : {
        eased_max_accel_deg_s: target.maxAccelerationDegS2,
      }),
      ...(target.maxTorqueNm == null ? {} : {
        max_torque_nm: target.maxTorqueNm,
      }),
    }));
    if (request.effectorCommands?.length) {
      const description = await this.description.get();
      const instances = effectorsFromManifest(description.manifest);
      const byId = new Map(instances.map((instance) => [instance.id, instance]));
      const previewByJoint = new Map<string, { joint_name: string; percent: number }>();
      for (const semanticCommand of request.effectorCommands) {
        const instance = byId.get(semanticCommand.effectorId);
        if (!instance) throw new Error(`UNKNOWN_EFFECTOR: ${semanticCommand.effectorId}`);
        for (const target of resolveEffectorCommand(instance, semanticCommand)) {
          if (previewByJoint.has(target.jointName)) {
            throw new Error(`DUPLICATE_EFFECTOR_TARGET: ${target.jointName}`);
          }
          previewByJoint.set(target.jointName, {
            joint_name: target.jointName,
            percent: target.percent,
          });
        }
      }
      const rawTargetNames = new Set(controlTargets.map((target) => target.joint_name));
      for (const preview of previewByJoint.values()) {
        if (!rawTargetNames.has(preview.joint_name)) controlTargets.push(preview);
      }
      semanticEffectors = {
        schema: EFFECTOR_COMMANDS_SCHEMA,
        descriptionRevisionId: description.revisionId,
        commands: request.effectorCommands,
      };
    }
    const command = createJointTargetsMessage({
      robotId: identity.id,
      leaseId: request.leaseId,
      sequence: ++this.sequence,
      ttlMs: request.ttlMs ?? request.timeoutMs,
      edgeKeepaliveMs: request.edgeKeepaliveMs,
      semanticEffectors,
      targets: controlTargets,
    });
    const motionTransport = this.options.motionTransport ?? "bridge";
    if (motionTransport === "edge") {
      if (!this.options.edgeEndpoint) {
        throw new Error("Droid edge motion transport requires edgeEndpoint");
      }
      if (!this.edgeClient) {
        this.edgeClient = new GoldenEdgeClient({
          endpoint: this.options.edgeEndpoint,
          robotId: identity.id,
          leaseId: request.leaseId,
          source: command.source,
          requestTimeoutMs: this.options.motionAdmissionTimeoutMs ?? 1_000,
        });
        this.edgeLeaseId = request.leaseId;
      } else if (this.edgeLeaseId !== request.leaseId) {
        this.edgeClient.setLease(request.leaseId);
        this.edgeLeaseId = request.leaseId;
      }
      const result = await this.edgeClient.publish(command);
      return {
        requestId: String(result.sequence ?? command.sequence),
        status: "acknowledged",
        route: "local",
        result: result as unknown as Record<string, unknown>,
      };
    }
    if (motionTransport === "zenoh") {
      const zenohEndpoint = this.options.zenohEndpoint
        ?? zenohTransportEndpoint(identity.transports)
        ?? DEFAULT_ZENOH_WS_ENDPOINT;
      if (!this.zenohClient) {
        // Keep this indirection so browser bundlers do not attempt to compile the
        // optional Zenoh WASM transport for Bridge-only applications.
        const zenohModulePath = "./zenoh-edge.js";
        const { ZenohEdgeClient } = await import(/* @vite-ignore */ zenohModulePath);
        this.zenohClient = new ZenohEdgeClient({
          endpoint: zenohEndpoint,
          topic: this.options.zenohTopic,
          sessionFactory: this.options.zenohSessionFactory,
          robotId: identity.id,
          leaseId: request.leaseId,
          source: command.source,
        });
        this.zenohLeaseId = request.leaseId;
      } else if (this.zenohLeaseId !== request.leaseId) {
        this.zenohClient.setLease(request.leaseId);
        this.zenohLeaseId = request.leaseId;
      }
      const result = await this.zenohClient!.publish(command);
      return { requestId: String(result.sequence), status: "acknowledged", route: "local", result };
    }
    const admission = await this.post<DroidCommandResult>(
      "/v1/droids/control/joint-targets",
      command,
    );
    return {
      ...admission,
      result: { ...(admission.result ?? {}), sdkSequence: command.sequence },
    };
  }

  private async primeAndWaitReady(
    targets: JointTarget[],
    request: DroidPrimeAndWaitReadyOptions,
  ): Promise<DroidMotionReady> {
    if (!targets.length) throw new Error("primeAndWaitReady requires at least one aligned hold target");
    const admission = await this.sendTargets(targets, request);
    if (["failed", "timeout", "not_reachable"].includes(admission.status)) {
      throw new Error(admission.error || `Vitrus motion admission failed (${admission.status})`);
    }

    const originSequence = Number(
      admission.result?.sdkSequence ?? admission.result?.sequence,
    );
    if (!Number.isSafeInteger(originSequence) || originSequence < 1) {
      throw new Error("Vitrus motion admission did not preserve the SDK origin sequence");
    }
    const requestedNames = new Set(targets.map((target) => target.jointName));
    if (requestedNames.size !== targets.length) {
      throw new Error("primeAndWaitReady requires one unique target per joint");
    }
    const timeoutMs = Math.max(1, Math.trunc(request.readinessTimeoutMs ?? 15_000));
    const pollIntervalMs = Math.max(10, Math.trunc(request.pollIntervalMs ?? 100));
    const admissions = new Map<number, DroidCommandResult>([[originSequence, admission]]);
    const startedAt = Date.now();
    let lastPhase = "unknown";
    let lastLease: string | null = null;
    let lastAcceptedTargetCount = 0;
    let lastAppliedTargetCount = 0;
    while (Date.now() - startedAt < timeoutMs) {
      const telemetry = await this.telemetry.snapshot();
      const telemetryRecord = parseJsonRecord(telemetry);
      const raw = parseJsonRecord(telemetryRecord.raw);
      const motorBridge = firstRecord(
        telemetryRecord.motorBridge,
        telemetryRecord.motor_bridge,
        raw.motorBridge,
        raw.motor_bridge,
        looksLikeMotorBridge(telemetryRecord) ? telemetryRecord : {},
        looksLikeMotorBridge(raw) ? raw : {},
      );
      if (Object.keys(motorBridge).length) {
        lastPhase = typeof motorBridge.control_phase === "string"
          ? motorBridge.control_phase
          : "unknown";
        lastLease = typeof motorBridge.exclusive_lease_id === "string"
          ? motorBridge.exclusive_lease_id
          : null;
        const motors = Array.isArray(motorBridge.motors)
          ? motorBridge.motors.map(parseJsonRecord)
          : [];
        const requestedMotors = motors.filter((motor) =>
          requestedNames.has(String(motor.joint_name ?? "")),
        );
        lastAcceptedTargetCount = requestedMotors.filter((motor) =>
          admissions.has(Number(motor.accepted_origin_sequence)),
        ).length;
        lastAppliedTargetCount = requestedMotors.filter((motor) =>
          admissions.has(Number(motor.applied_origin_sequence)),
        ).length;
        if (
          motorBridge.access_mode === "read_write"
          && lastPhase === "ready_for_realtime"
          && lastLease === request.leaseId
          && lastAcceptedTargetCount === targets.length
          && lastAppliedTargetCount === targets.length
        ) {
          const appliedSequences = requestedMotors
            .map((motor) => Number(motor.applied_origin_sequence))
            .filter((sequence) => admissions.has(sequence));
          const matchedOriginSequence = Math.max(...appliedSequences);
          return {
            admission: admissions.get(matchedOriginSequence) ?? admission,
            telemetry,
            motorBridge,
            phase: "ready_for_realtime",
            leaseId: request.leaseId,
            acceptedTargetCount: lastAcceptedTargetCount,
            appliedTargetCount: lastAppliedTargetCount,
            originSequence: matchedOriginSequence,
          };
        }
        if (["error", "fault"].includes(lastPhase)) {
          throw new Error(
            `Vitrus motor bridge failed while priming (phase=${lastPhase}, lease=${lastLease ?? "none"})`,
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error(
      `Vitrus motor bridge did not accept the aligned hold in time `
      + `(phase=${lastPhase}, expected lease=${request.leaseId}, `
      + `broker lease=${lastLease ?? "none"}, `
      + `accepted=${lastAcceptedTargetCount}/${targets.length}, `
      + `applied=${lastAppliedTargetCount}/${targets.length}, `
      + `origin=${originSequence})`,
    );
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl()}${path}`);
    this.appendRef(url.searchParams);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return this.request<T>(url.toString(), { method: "GET" }, `GET ${path}`);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(`${this.baseUrl()}${path}`);
    this.appendRef(url.searchParams);
    return this.request<T>(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, `POST ${path}`);
  }

  private async delete(path: string): Promise<void> {
    const url = new URL(`${this.baseUrl()}${path}`);
    this.appendRef(url.searchParams);
    await this.request(url.toString(), { method: "DELETE" });
  }

  private realtimeUrl(): string {
    const url = new URL(this.baseUrl());
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime`;
    url.search = "";
    url.searchParams.set("api_key", this.options.apiKey);
    return url.toString();
  }

  private baseUrl(): string {
    const configured = this.options.endpoint || this.options.relayUrl || "https://vitrus-dataplane.onrender.com";
    return cleanUrl(configured);
  }

  private appendRef(params: URLSearchParams): void {
    if (typeof this.ref === "string") {
      params.set("ref", this.ref);
      return;
    }
    if (this.ref.serialNumber) params.set("serial_number", this.ref.serialNumber);
    if (this.ref.droidId) params.set("droid_id", this.ref.droidId);
    if (this.ref.alias) params.set("alias", this.ref.alias);
  }

  private async request<T>(url: string, init: RequestInit, operation = "request"): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = this.options.controlPlaneTimeoutMs ?? this.options.timeoutMs ?? 15_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          ...(init.headers ?? {}),
        },
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = parseJsonRecord(payload).detail;
        throw new Error(`Vitrus Droid request failed (${response.status}): ${typeof detail === "string" ? detail : response.statusText}`);
      }
      return payload as T;
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new DroidRequestTimeoutError(operation, new URL(url).pathname, timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function zenohTransportEndpoint(transports: Record<string, unknown> | undefined): string | undefined {
  if (!transports) return undefined;
  for (const key of ["zenohWs", "zenoh_ws", "zenohWebSocket", "zenoh_websocket"]) {
    const value = transports[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
