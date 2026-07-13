export type DroidRef = string | { serialNumber?: string; droidId?: string; alias?: string };

export type DroidIdentity = {
  id: string;
  serialNumber: string;
  model: string;
  displayName: string | null;
  organizationId: string;
  status: "online" | "offline" | "degraded" | "unknown";
  enrollmentState: "manufactured" | "unclaimed" | "claiming" | "enrolled" | "transferring" | "suspended" | "retired";
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

export type CameraIntrinsics = {
  model?: string;
  matrix?: number[][];
  distortion?: number[];
  rectifiedMatrix?: number[][];
  imageSize?: [number, number];
  focalLengthMm?: number;
  horizontalApertureMm?: number;
  verticalApertureMm?: number;
  fovDeg?: number;
  fps?: number;
  clipNearM?: number;
  clipFarM?: number;
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
  matrix?: number[][];
  raw: Record<string, unknown>;
};

export type CameraCalibration = {
  camera: string;
  calibrated: boolean;
  appliesToFeed: boolean;
  calibrationPath?: string;
  intrinsics?: CameraIntrinsics;
  extrinsics?: CameraExtrinsics;
  raw: {
    camera?: Record<string, unknown>;
    calibration?: Record<string, unknown>;
    description?: Record<string, unknown>;
  };
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
  expiresAt: string;
};

export type JointTarget = {
  jointName: string;
  displayDeg: number;
  durationS?: number;
  maxVelocityDegS?: number;
  maxAccelerationDegS2?: number;
};

export type JointTargetCommand = {
  schema: "vitrus.control.joint_targets.v1";
  droidId: string;
  leaseId: string;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  source: "vitrus-sdk";
  mode: "position_deg";
  targets: JointTarget[];
  safety: { requireBrokerLimits: true; rawCan: false };
};

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
  timeoutMs?: number;
};

function cleanUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.flat(Infinity);
  return numbers.every((item) => typeof item === "number" && Number.isFinite(item)) ? numbers as number[] : undefined;
}

function parseNumberMatrix(value: unknown): number[][] | undefined {
  if (!Array.isArray(value) || !value.every((row) => Array.isArray(row))) return undefined;
  const matrix = value as unknown[][];
  return matrix.every((row) => row.every((item) => typeof item === "number" && Number.isFinite(item)))
    ? matrix as number[][]
    : undefined;
}

function parseFixedVector<T extends 2 | 3 | 4>(value: unknown, length: T): number[] | undefined {
  const numbers = parseNumberArray(value);
  return numbers?.length === length ? numbers : undefined;
}

function parseImageSize(value: unknown): [number, number] | undefined {
  return parseFixedVector(value, 2) as [number, number] | undefined;
}

function cameraNameAliases(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const withoutCamera = normalized.replace(/^camera_/, "").replace(/_camera$/, "");
  return normalized === withoutCamera ? [normalized] : [normalized, withoutCamera];
}

function cameraRecordAliases(camera: Record<string, unknown>): Set<string> {
  const aliases = new Set<string>();
  for (const key of ["name", "safe_name", "display_name", "configured_name", "stable_id", "camera_id"]) {
    for (const alias of cameraNameAliases(camera[key])) aliases.add(alias);
  }
  return aliases;
}

function cameraDescriptionRecords(description: DroidDescription): Record<string, unknown>[] {
  const manifest = parseJsonRecord(description.manifest);
  const robot = parseJsonRecord(description.robot);
  const candidates = [description.cameras, manifest.cameras, robot.cameras];
  for (const value of candidates) {
    if (!Array.isArray(value)) continue;
    const records = value.map(parseJsonRecord).filter((item) => Object.keys(item).length > 0);
    if (records.length > 0) return records;
  }
  return [];
}

function findCameraRecord(records: Record<string, unknown>[], camera: string): Record<string, unknown> | undefined {
  const requested = new Set(cameraNameAliases(camera));
  return records.find((record) => [...cameraRecordAliases(record)].some((alias) => requested.has(alias)));
}

function firstRecord(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    const record = parseJsonRecord(value);
    if (Object.keys(record).length > 0) return record;
  }
  return {};
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

function parseCameraIntrinsics(
  cameraRecord: Record<string, unknown>,
  calibrationRecord: Record<string, unknown>,
  descriptionRecord: Record<string, unknown>,
): CameraIntrinsics | undefined {
  const fisheye = parseJsonRecord(cameraRecord.fisheye);
  const calibratedIntrinsics = firstRecord(calibrationRecord.intrinsics, fisheye.intrinsics);
  const describedIntrinsics = parseJsonRecord(descriptionRecord.intrinsics);
  const raw = {
    ...(Object.keys(describedIntrinsics).length > 0 ? { description: describedIntrinsics } : {}),
    ...(Object.keys(fisheye).length > 0 ? { fisheye } : {}),
    ...(Object.keys(calibratedIntrinsics).length > 0 ? { calibration: calibratedIntrinsics } : {}),
  };
  const matrix = firstDefined(
    parseNumberMatrix(calibratedIntrinsics.matrix),
    parseNumberMatrix(calibratedIntrinsics.K),
    parseNumberMatrix(calibrationRecord.K),
    parseNumberMatrix(fisheye.K),
    parseNumberMatrix(describedIntrinsics.matrix),
    parseNumberMatrix(describedIntrinsics.K),
  );
  const distortion = firstDefined(
    parseNumberArray(calibratedIntrinsics.distortion),
    parseNumberArray(calibratedIntrinsics.D),
    parseNumberArray(calibrationRecord.D),
    parseNumberArray(fisheye.D),
    parseNumberArray(describedIntrinsics.distortion),
  );
  const rectifiedMatrix = firstDefined(
    parseNumberMatrix(calibratedIntrinsics.rectified_matrix),
    parseNumberMatrix(calibratedIntrinsics.new_K),
    parseNumberMatrix(calibrationRecord.new_K),
    parseNumberMatrix(fisheye.new_K),
  );
  const imageSize = firstDefined(
    parseImageSize(calibratedIntrinsics.image_size),
    parseImageSize(calibrationRecord.image_size),
    parseImageSize(fisheye.image_size),
    parseImageSize(describedIntrinsics.resolution),
  );
  const checkerboard = firstDefined(
    parseImageSize(calibratedIntrinsics.checkerboard),
    parseImageSize(calibrationRecord.checkerboard),
    parseImageSize(fisheye.checkerboard),
  );
  const intrinsics: CameraIntrinsics = {
    model: firstDefined(
      typeof calibratedIntrinsics.model === "string" ? calibratedIntrinsics.model : undefined,
      typeof describedIntrinsics.projection === "string" ? describedIntrinsics.projection : undefined,
      Object.keys(fisheye).length > 0 ? "fisheye" : undefined,
    ),
    matrix,
    distortion,
    rectifiedMatrix,
    imageSize,
    focalLengthMm: parseNumber(describedIntrinsics.focal_length_mm),
    horizontalApertureMm: parseNumber(describedIntrinsics.horizontal_aperture_mm),
    verticalApertureMm: parseNumber(describedIntrinsics.vertical_aperture_mm),
    fovDeg: parseNumber(describedIntrinsics.fov_deg),
    fps: parseNumber(describedIntrinsics.fps),
    clipNearM: parseNumber(describedIntrinsics.clip_near_m),
    clipFarM: parseNumber(describedIntrinsics.clip_far_m),
    rmsReprojectionError: firstDefined(
      parseNumber(calibratedIntrinsics.rms),
      parseNumber(calibrationRecord.rms),
      parseNumber(fisheye.rms),
    ),
    checkerboard,
    squareSizeM: firstDefined(
      parseNumber(calibratedIntrinsics.square_size),
      parseNumber(calibrationRecord.square_size),
      parseNumber(fisheye.square_size),
    ),
    raw,
  };
  return Object.keys(raw).length > 0 ? intrinsics : undefined;
}

function parseCameraExtrinsics(
  cameraRecord: Record<string, unknown>,
  calibrationRecord: Record<string, unknown>,
  descriptionRecord: Record<string, unknown>,
): CameraExtrinsics | undefined {
  const extrinsics = firstRecord(calibrationRecord.extrinsics, cameraRecord.extrinsics, descriptionRecord.extrinsics);
  const translation = firstDefined(
    parseFixedVector(extrinsics.translation_m, 3),
    parseFixedVector(extrinsics.translation, 3),
    parseFixedVector(descriptionRecord.local_origin, 3),
  ) as [number, number, number] | undefined;
  const quaternion = firstDefined(
    parseFixedVector(extrinsics.rotation_quaternion_xyzw, 4),
    parseFixedVector(extrinsics.quaternion_xyzw, 4),
    parseFixedVector(descriptionRecord.local_quaternion_xyzw, 4),
  ) as [number, number, number, number] | undefined;
  const direction = parseFixedVector(descriptionRecord.direction, 3) as [number, number, number] | undefined;
  const matrix = firstDefined(parseNumberMatrix(extrinsics.matrix), parseNumberMatrix(extrinsics.transform));
  const parentFrame = firstDefined(
    typeof extrinsics.parent_frame === "string" ? extrinsics.parent_frame : undefined,
    typeof descriptionRecord.parent_link === "string" ? descriptionRecord.parent_link : undefined,
  );
  const cameraFrame = firstDefined(
    typeof extrinsics.camera_frame === "string" ? extrinsics.camera_frame : undefined,
    typeof descriptionRecord.name === "string" ? descriptionRecord.name : undefined,
  );
  if (!translation && !quaternion && !direction && !matrix && !parentFrame && !cameraFrame) return undefined;
  return {
    parentFrame,
    cameraFrame,
    translationM: translation,
    rotationQuaternionXyzw: quaternion,
    direction,
    matrix,
    raw: {
      ...(Object.keys(extrinsics).length > 0 ? { calibration: extrinsics } : {}),
      ...(Object.keys(descriptionRecord).length > 0 ? { description: descriptionRecord } : {}),
    },
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
    list: () => Promise<Array<Record<string, unknown>>>;
    getFrame: (camera: string) => Promise<CameraFrame>;
    getCalibration: (camera: string) => Promise<CameraCalibration | null>;
  };
  readonly telemetry: { snapshot: () => Promise<DroidTelemetry> };
  readonly control: { acquire: (options?: { durationMs?: number }) => Promise<ControlLease> };
  readonly motion: {
    sendTargets: (targets: JointTarget[], options: { leaseId: string; timeoutMs?: number }) => Promise<DroidCommandResult>;
  };
  readonly safety: { emergencyStop: (reason?: string) => Promise<DroidCommandResult> };

  private sequence = 0;

  private constructor(private readonly ref: DroidRef, private readonly options: DroidConnectionOptions) {
    this.identity = { get: () => this.get<DroidIdentity>("/v1/droids/resolve") };
    this.description = { get: () => this.get<DroidDescription>("/v1/droids/description") };
    this.camera = {
      list: () => this.get<Array<Record<string, unknown>>>("/v1/droids/cameras"),
      getFrame: (camera) => this.get<CameraFrame>("/v1/droids/cameras/frame", { camera }),
      getCalibration: (camera) => this.getCameraCalibration(camera),
    };
    this.telemetry = { snapshot: () => this.get<DroidTelemetry>("/v1/droids/telemetry") };
    this.control = {
      acquire: (request = {}) => this.post<ControlLease>("/v1/droids/control/leases", request),
    };
    this.motion = {
      sendTargets: (targets, request) => this.sendTargets(targets, request),
    };
    this.safety = {
      emergencyStop: (reason = "operator_requested") => this.post<DroidCommandResult>("/v1/droids/safety/emergency-stop", { reason }),
    };
  }

  private async getCameraCalibration(camera: string): Promise<CameraCalibration | null> {
    const [cameraRecords, description] = await Promise.all([
      this.camera.list(),
      this.description.get(),
    ]);
    const cameraRecord = findCameraRecord(cameraRecords, camera) ?? {};
    const descriptionRecord = findCameraRecord(cameraDescriptionRecords(description), camera) ?? {};
    const fisheye = parseJsonRecord(cameraRecord.fisheye);
    const calibrationRecord = firstRecord(cameraRecord.calibration, fisheye);
    const intrinsics = parseCameraIntrinsics(cameraRecord, calibrationRecord, descriptionRecord);
    const extrinsics = parseCameraExtrinsics(cameraRecord, calibrationRecord, descriptionRecord);
    if (!intrinsics && !extrinsics && Object.keys(calibrationRecord).length === 0) return null;
    return {
      camera,
      calibrated: calibrationRecord.calibrated === true || cameraRecord.calibrated === true,
      appliesToFeed: calibrationRecord.applies_to_feed === true || cameraRecord.applies_to_feed === true,
      calibrationPath: firstDefined(
        typeof calibrationRecord.calibration_path === "string" ? calibrationRecord.calibration_path : undefined,
        typeof cameraRecord.calibration_path === "string" ? cameraRecord.calibration_path : undefined,
      ),
      intrinsics,
      extrinsics,
      raw: {
        ...(Object.keys(cameraRecord).length > 0 ? { camera: cameraRecord } : {}),
        ...(Object.keys(calibrationRecord).length > 0 ? { calibration: calibrationRecord } : {}),
        ...(Object.keys(descriptionRecord).length > 0 ? { description: descriptionRecord } : {}),
      },
    };
  }

  private async sendTargets(targets: JointTarget[], request: { leaseId: string; timeoutMs?: number }): Promise<DroidCommandResult> {
    const identity = await this.identity.get();
    const now = Date.now();
    const timeoutMs = request.timeoutMs ?? 300;
    const command: JointTargetCommand = {
      schema: "vitrus.control.joint_targets.v1",
      droidId: identity.id,
      leaseId: request.leaseId,
      sequence: ++this.sequence,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + timeoutMs).toISOString(),
      source: "vitrus-sdk",
      mode: "position_deg",
      targets,
      safety: { requireBrokerLimits: true, rawCan: false },
    };
    return this.post<DroidCommandResult>("/v1/droids/control/joint-targets", command);
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

  private baseUrl(): string {
    const configured = this.options.endpoint || this.options.relayUrl || "https://relay.vitrus.ai";
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
