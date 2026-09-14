import { createJointTargetsMessage, type ControlJointTargetsMessage } from "./contracts.js";
import { GoldenEdgeClient } from "./golden-edge.js";
import { ZenohEdgeClient, type ZenohEdgeSession } from "./zenoh-edge.js";

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
};

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
  /** Last known desired/applied/measured correlation from VitrusOS. */
  control?: DroidControlState;
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
};

export type JointTargetCommand = ControlJointTargetsMessage;

export type ControlStage = "desired_state_accepted" | "applied" | "measured" | "rejected" | "unknown";

/** A desired state is the newest target for one control key, never a promise
 * that every browser drag event will be physically executed. */
export type DesiredControlState = {
  stage: "desired_state_accepted";
  sequence: number;
  leaseId: string;
  key: string;
  acceptedAtMs?: number;
  /** Old edge wording, retained so logs and existing integrations stay legible. */
  legacyDelivery?: string;
};

export type AppliedControlState = {
  stage: "applied" | "rejected" | "unknown";
  sequence?: number;
  commandId?: string;
  appliedAtMs?: number;
  error?: string;
};

export type MeasuredControlState = {
  stage: "measured" | "unknown";
  sequence?: number;
  measuredAtMs?: number;
  ageMs?: number;
};

/**
 * One correlation object for UI loops. Desired is local/edge admission,
 * applied is native broker execution, and measured comes from telemetry.
 */
export type DroidControlState = {
  leaseId?: string;
  desired?: DesiredControlState;
  applied?: AppliedControlState;
  measured?: MeasuredControlState;
};

export type DroidCommandResult = {
  requestId: string;
  /** Legacy transport-level status. Use `control.desired/applied/measured` for execution truth. */
  status: "queued" | "sent" | "acknowledged" | "timeout" | "failed" | "not_reachable";
  route: "relay" | "local";
  control?: DroidControlState;
  result?: Record<string, unknown>;
  error?: string;
};

export type MotionOperationState = "submitting" | "acknowledged" | "failed" | "cancelled";

export type MotionOperationStatus = {
  id: string;
  state: MotionOperationState;
  error?: string;
};

export type MotionOperation = {
  readonly id: string;
  status: () => MotionOperationStatus;
  result: () => Promise<DroidCommandResult>;
  cancel: () => Promise<void>;
};

export type MotionTargetOptions = {
  leaseId: string;
  /**
   * @deprecated No longer defines command lifetime. Authority ends only when
   * the lease is released, expires, or an explicit stop/fault occurs. Retained
   * as a source-compatible option for callers that still pass it.
   */
  timeoutMs?: number;
  /** A stable newest-state lane, for example `neck`, `left_arm`, or `right_gripper`. */
  desiredStateKey?: string;
};

export type MotionSubmitOptions = MotionTargetOptions & {
  holdMs: number;
  operationId?: string;
};

export type DroidConnectionOptions = {
  apiKey: string;
  relayUrl?: string;
  endpoint?: string;
  edgeEndpoint?: string;
  motionTransport?: "bridge" | "edge" | "zenoh";
  zenohEndpoint?: string;
  zenohTopic?: string;
  zenohSessionFactory?: () => Promise<ZenohEdgeSession>;
  timeoutMs?: number;
  clientId?: string;
  webSocketFactory?: (url: string) => WebSocket;
};

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

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function numberValue(...values: unknown[]): number | undefined {
  return values.map(finiteNumber).find((value): value is number => value !== undefined);
}

/** Normalize both old `latest_only_public_mailbox` receipts and the compact
 * desired-state receipt returned by the current edge. */
export function normalizeControlState(
  value: unknown,
  fallback: { leaseId?: string; sequence?: number; desiredStateKey?: string; acceptedAtMs?: number } = {},
): DroidControlState {
  const raw = parseJsonRecord(value);
  const nested = firstRecord(raw.control, raw.control_state, raw.execution, raw.receipt);
  const desiredRaw = firstRecord(nested.desired, raw.desired, raw.desired_state);
  const appliedRaw = firstRecord(nested.applied, raw.applied, raw.broker, raw.native);
  const measuredRaw = firstRecord(nested.measured, raw.measured, raw.feedback);
  const delivery = stringValue(raw.delivery, nested.delivery, desiredRaw.delivery);
  const legacyDelivery = stringValue(raw.legacy_delivery, nested.legacy_delivery, desiredRaw.legacy_delivery);
  const leaseId = stringValue(raw.lease_id, raw.leaseId, nested.lease_id, nested.leaseId, fallback.leaseId);
  const sequence = numberValue(raw.sequence, raw.input_sequence, nested.sequence, nested.input_sequence, desiredRaw.sequence, fallback.sequence);
  const key = stringValue(raw.desired_state_key, raw.coalesce_key, nested.key, desiredRaw.key, fallback.desiredStateKey);
  const acceptedAtMs = numberValue(raw.accepted_at_ms, raw.received_at_ms, nested.accepted_at_ms, desiredRaw.accepted_at_ms, fallback.acceptedAtMs);
  const commandId = stringValue(appliedRaw.command_id, appliedRaw.commandId, raw.command_id, raw.commandId);
  const appliedSequence = numberValue(appliedRaw.sequence, appliedRaw.input_sequence, raw.applied_sequence, raw.broker_sequence);
  const appliedError = stringValue(appliedRaw.error, raw.error);
  const appliedAtMs = numberValue(appliedRaw.applied_at_ms, appliedRaw.accepted_at_ms, raw.applied_at_ms);
  const measuredAtMs = numberValue(measuredRaw.measured_at_ms, measuredRaw.timestamp_ms, raw.measured_at_ms);
  const measuredSequence = numberValue(measuredRaw.sequence, measuredRaw.input_sequence, raw.measured_sequence);
  const measuredAgeMs = numberValue(measuredRaw.age_ms, raw.measurement_age_ms);
  const desired = sequence != null && leaseId && key ? {
    stage: "desired_state_accepted" as const,
    sequence,
    leaseId,
    key,
    ...(acceptedAtMs == null ? {} : { acceptedAtMs }),
    ...(legacyDelivery ? { legacyDelivery } : delivery && delivery !== "desired_state_accepted" ? { legacyDelivery: delivery } : {}),
  } : undefined;
  const applied = commandId || appliedSequence != null || appliedError ? {
    stage: appliedError ? "rejected" as const : commandId || appliedSequence != null ? "applied" as const : "unknown" as const,
    ...(appliedSequence == null ? {} : { sequence: appliedSequence }),
    ...(commandId == null ? {} : { commandId }),
    ...(appliedAtMs == null ? {} : { appliedAtMs }),
    ...(appliedError == null ? {} : { error: appliedError }),
  } : undefined;
  const measured = measuredAtMs != null || measuredSequence != null || measuredAgeMs != null ? {
    stage: measuredAtMs != null || measuredSequence != null ? "measured" as const : "unknown" as const,
    ...(measuredSequence == null ? {} : { sequence: measuredSequence }),
    ...(measuredAtMs == null ? {} : { measuredAtMs }),
    ...(measuredAgeMs == null ? {} : { ageMs: measuredAgeMs }),
  } : undefined;
  return {
    ...(leaseId == null ? {} : { leaseId }),
    ...(desired == null ? {} : { desired }),
    ...(applied == null ? {} : { applied }),
    ...(measured == null ? {} : { measured }),
  };
}

/** Correlate the acknowledged desired state with the newest telemetry state.
 * A UI can call this on every telemetry update without inventing execution. */
export function correlateControlState(command: DroidCommandResult, telemetry: DroidTelemetry): DroidControlState {
  const commandState = command.control ?? {};
  const telemetryState = telemetry.control ?? normalizeControlState(telemetry.raw);
  return {
    leaseId: telemetryState.leaseId ?? commandState.leaseId,
    desired: commandState.desired,
    applied: telemetryState.applied ?? commandState.applied,
    measured: telemetryState.measured ?? commandState.measured,
  };
}

export class Droid {
  static async connect(ref: DroidRef, options: DroidConnectionOptions): Promise<Droid> {
    const droid = new Droid(ref, options);
    await droid.identity.get();
    return droid;
  }

  readonly identity: { get: () => Promise<DroidIdentity> };
  readonly description: { get: () => Promise<DroidDescription> };
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
  readonly events: {
    subscribe: (listener: (event: DroidRealtimeEvent) => void, options?: { onStateChange?: (state: DroidRealtimeState, error?: Error) => void }) => Promise<DroidRealtimeSubscription>;
  };
  readonly control: {
    acquire: (options?: { durationMs?: number; owner?: string; jointNames?: string[] | "all_controllable" }) => Promise<ControlLease>;
    renew: (leaseId: string, options?: { durationMs?: number }) => Promise<ControlLease>;
    release: (leaseId: string) => Promise<void>;
  };
  readonly motion: {
    sendTargets: (targets: JointTarget[], options: MotionTargetOptions) => Promise<DroidCommandResult>;
    submitTargets: (targets: JointTarget[], options: MotionSubmitOptions) => MotionOperation;
  };
  readonly safety: { emergencyStop: (reason?: string) => Promise<DroidCommandResult> };

  private sequence = 0;
  private identityCache: DroidIdentity | null = null;
  private edgeClient: GoldenEdgeClient | null = null;
  private edgeLeaseId: string | null = null;
  private zenohClient: ZenohEdgeClient | null = null;
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
    this.camera = {
      list: () => this.get<DroidCamera[]>("/v1/droids/cameras"),
      getFrame: (camera) => this.get<CameraFrame>("/v1/droids/cameras/frame", { camera }),
      getCalibration: (camera) => this.getCameraCalibration(camera),
      openSession: (camera, request = {}) => this.post<CameraMediaSession>("/v1/droids/cameras/sessions", { camera, preferredTransport: request.preferredTransport ?? "auto" }),
      closeSession: async (sessionId) => { await this.delete(`/v1/droids/cameras/sessions/${encodeURIComponent(sessionId)}`); },
    };
    this.telemetry = {
      snapshot: async () => {
        const raw = await this.get<Record<string, unknown>>("/v1/droids/telemetry");
        return {
          schema: typeof raw.schema === "string" ? raw.schema : "vitrus.telemetry.state.v1",
          timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
          joints: parseJsonRecord(raw.joints),
          cameras: Array.isArray(raw.cameras) ? raw.cameras.map(parseJsonRecord) : undefined,
          motorBridge: parseJsonRecord(raw.motor_bridge ?? raw.motorBridge),
          control: normalizeControlState(raw),
          raw,
        };
      },
      subscribe: (listener, request) => this.subscribeEvents((event) => {
        if (event.type !== "droid.telemetry") return;
        const raw = event.telemetry;
        listener({
          schema: typeof raw.schema === "string" ? raw.schema : "vitrus.telemetry.state.v1",
          timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
          joints: parseJsonRecord(raw.joints),
          cameras: Array.isArray(raw.cameras) ? raw.cameras.map(parseJsonRecord) : undefined,
          motorBridge: parseJsonRecord(raw.motor_bridge ?? raw.motorBridge),
          control: normalizeControlState(raw),
          raw,
        });
      }, request),
    };
    this.events = { subscribe: (listener, request) => this.subscribeEvents(listener, request) };
    this.control = {
      acquire: (request = {}) => this.acquireControl(request),
      renew: (leaseId, request = {}) => this.renewControl(leaseId, request),
      release: (leaseId) => this.releaseControl(leaseId),
    };
    this.motion = {
      sendTargets: (targets, request) => this.sendTargets(targets, request),
      submitTargets: (targets, request) => this.submitTargets(targets, request),
    };
    this.safety = {
      emergencyStop: (reason = "operator_requested") => this.post<DroidCommandResult>("/v1/droids/safety/emergency-stop", { reason }),
    };
  }

  private randomId(prefix: string): string {
    return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  }

  private async edge(): Promise<GoldenEdgeClient> {
    if (!this.options.edgeEndpoint) throw new Error("Droid edge transport requires edgeEndpoint");
    if (!this.edgeClient) {
      const identity = await this.identity.get();
      this.edgeClient = new GoldenEdgeClient({
        endpoint: this.options.edgeEndpoint,
        robotId: identity.id,
        source: "vitrus-sdk",
      });
    }
    return this.edgeClient;
  }

  private async acquireControl(request: { durationMs?: number; owner?: string; jointNames?: string[] | "all_controllable" }): Promise<ControlLease> {
    if ((this.options.motionTransport ?? "bridge") !== "edge") {
      return this.post<ControlLease>("/v1/droids/control/leases", {
        durationMs: request.durationMs,
        owner: request.owner?.trim() || this.clientId,
      });
    }
    const client = await this.edge();
    const identity = await this.identity.get();
    const durationMs = request.durationMs ?? 10_000;
    const owner = request.owner?.trim() || this.clientId;
    const requestedNames = request.jointNames;
    const jointNames = Array.isArray(requestedNames)
      ? requestedNames
      : (await client.controlScope()).joint_names;
    if (!jointNames.length || jointNames.some((name) => !name.trim())) {
      throw new Error("Edge control acquire requires at least one valid joint name");
    }
    const leaseId = this.randomId("edge-lease");
    await client.acquire({ leaseId, owner, jointNames, durationMs });
    this.edgeLeaseId = leaseId;
    return {
      id: leaseId,
      droidId: identity.id,
      owner,
      expiresAt: new Date(Date.now() + durationMs).toISOString(),
    };
  }

  private async renewControl(leaseId: string, request: { durationMs?: number }): Promise<ControlLease> {
    if ((this.options.motionTransport ?? "bridge") !== "edge") {
      return this.post<ControlLease>(`/v1/droids/control/leases/${encodeURIComponent(leaseId)}/renew`, request);
    }
    const durationMs = request.durationMs ?? 10_000;
    await (await this.edge()).renew(leaseId, durationMs);
    const identity = await this.identity.get();
    return {
      id: leaseId,
      droidId: identity.id,
      owner: this.clientId,
      expiresAt: new Date(Date.now() + durationMs).toISOString(),
    };
  }

  private async releaseControl(leaseId: string): Promise<void> {
    if ((this.options.motionTransport ?? "bridge") !== "edge") {
      await this.delete(`/v1/droids/control/leases/${encodeURIComponent(leaseId)}`);
      return;
    }
    await (await this.edge()).release(leaseId);
    if (this.edgeLeaseId === leaseId) this.edgeLeaseId = null;
  }

  private submitTargets(targets: JointTarget[], request: MotionSubmitOptions): MotionOperation {
    if ((this.options.motionTransport ?? "bridge") !== "edge") {
      throw new Error("bounded motion operations require motionTransport: edge");
    }
    const id = request.operationId?.trim() || this.randomId("motion");
    let state: MotionOperationState = "submitting";
    let error: string | undefined;
    const resultPromise = this.sendTargets(targets, {
      leaseId: request.leaseId,
      timeoutMs: request.timeoutMs,
      holdMs: request.holdMs,
      operationId: id,
    }).then((result) => {
      if (state !== "cancelled") state = "acknowledged";
      return {
        ...result,
        result: { ...(result.result ?? {}), operation_id: id },
      };
    }).catch((cause) => {
      error = cause instanceof Error ? cause.message : String(cause);
      if (state !== "cancelled") state = "failed";
      throw cause;
    });
    return {
      id,
      status: () => ({ id, state, ...(error ? { error } : {}) }),
      result: () => resultPromise,
      cancel: async () => {
        await this.releaseControl(request.leaseId);
        state = "cancelled";
      },
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

  private async sendTargets(targets: JointTarget[], request: MotionTargetOptions & { holdMs?: number; operationId?: string }): Promise<DroidCommandResult> {
    const identity = await this.identity.get();
    const motionTransport = this.options.motionTransport ?? "bridge";
    if (request.holdMs != null && motionTransport !== "edge") {
      throw new Error("holdMs is supported only by the Edge motion transport");
    }
    const command = createJointTargetsMessage({
      robotId: identity.id,
      leaseId: request.leaseId,
      sequence: ++this.sequence,
      // `timeoutMs` used to become a physical source-age deadline. A slow
      // network then killed valid desired state while its lease was healthy.
      // Keep the option in the public type for old callers, but do not put it
      // on the wire as a command-expiry gate.
      desiredStateKey: request.desiredStateKey,
      edgeKeepaliveMs: request.holdMs,
      operationId: request.operationId,
      targets: targets.map((target) => ({
        joint_name: target.jointName,
        position_deg: target.displayDeg,
        ...(target.maxVelocityDegS == null ? {} : { velocity_deg_s: target.maxVelocityDegS }),
      })),
    });
    if (motionTransport === "edge") {
      if (!this.options.edgeEndpoint) {
        throw new Error("Droid edge motion transport requires edgeEndpoint");
      }
      const client = await this.edge();
      if (this.edgeLeaseId !== request.leaseId) {
        client.setLease(request.leaseId);
        this.edgeLeaseId = request.leaseId;
      }
      const result = await client.publish(command);
      return {
        requestId: String(result.sequence ?? command.sequence),
        status: "acknowledged",
        route: "local",
        control: normalizeControlState(result, {
          leaseId: request.leaseId,
          sequence: command.sequence,
          desiredStateKey: command.delivery.key,
          acceptedAtMs: Date.now(),
        }),
        result: result as unknown as Record<string, unknown>,
      };
    }
    if (motionTransport === "zenoh") {
      const zenohEndpoint = this.options.zenohEndpoint
        ?? zenohTransportEndpoint(identity.transports)
        ?? DEFAULT_ZENOH_WS_ENDPOINT;
      if (!this.zenohClient) {
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
      const result = await this.zenohClient.publish(command);
      return {
        requestId: String(result.sequence),
        status: "acknowledged",
        route: "local",
        control: normalizeControlState(result, {
          leaseId: request.leaseId,
          sequence: command.sequence,
          desiredStateKey: command.delivery.key,
          acceptedAtMs: Date.now(),
        }),
        result,
      };
    }
    const result = await this.post<DroidCommandResult>("/v1/droids/control/joint-targets", command);
    return {
      ...result,
      control: normalizeControlState(result.result ?? result, {
        leaseId: request.leaseId,
        sequence: command.sequence,
        desiredStateKey: command.delivery.key,
        acceptedAtMs: Date.now(),
      }),
    };
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl()}${path}`);
    this.appendRef(url.searchParams);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return this.request<T>(url.toString(), { method: "GET" });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(`${this.baseUrl()}${path}`);
    this.appendRef(url.searchParams);
    return this.request<T>(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
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

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
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
