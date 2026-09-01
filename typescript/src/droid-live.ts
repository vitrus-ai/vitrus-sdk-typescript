import { Droid as BaseDroid, DroidRequestTimeoutError, normalizeDroidTelemetry, validateDroidLeaseDurationMs } from "./droid.js";
import { normalizeDeviceStatus, type DeviceStatus } from "./device-status.js";
export * from "./droid.js";
import type { CameraFrame, CameraFrameOptions, CameraStream, CameraStreamOptions, ControlLease as BaseControlLease, DroidCartesianTrajectoryOptions, DroidCommandResult, DroidConnectionOptions, DroidDescription, DroidIdentity, DroidMotionReady, DroidPrimeAndWaitReadyOptions, DroidRef, DroidTargetOptions, DroidTelemetry, JointTarget } from "./droid.js";
import type { GoldenEdgeModuleCatalog } from "./golden-edge.js";

export type DroidCamera = Record<string, unknown> & { name: string; ready?: boolean; fps?: number; stream_url?: string; snapshot_url?: string };
export type CameraMediaTransport = "webrtc" | "moq" | "mjpeg" | "snapshot";
export type CameraMediaSession = { id: string; droidId: string; camera: string; expiresAt: string; transport: CameraMediaTransport; route: "direct" | "vpn" | "relay"; offerUrl?: string; streamUrl?: string; snapshotUrl?: string; iceServers?: RTCIceServer[]; codec?: string; width?: number; height?: number; fps?: number; bitrate?: string; requiresAuthorization?: boolean };
export type ControlLease = BaseControlLease & { owner: string };
export type DroidRealtimeState = "connecting" | "connected" | "reconnecting" | "closed" | "error";
export type DroidRealtimeEvent =
  | { type: "droid.updated"; droid: DroidIdentity }
  | { type: "droid.status"; droid: Pick<DroidIdentity, "id" | "serialNumber">; status: Record<string, unknown> }
  | { type: "droid.telemetry"; droid: Pick<DroidIdentity, "id" | "serialNumber">; telemetry: Record<string, unknown> }
  | { type: "droid.cameras.updated"; droid: Pick<DroidIdentity, "id" | "serialNumber">; cameras: DroidCamera[] }
  | { type: "droid.description.updated"; droid: Pick<DroidIdentity, "id" | "serialNumber">; description: DroidDescription };
export type DroidRealtimeSubscription = { readonly state: DroidRealtimeState; close(): void };
export type CameraCalibration = { camera: string; calibrated: boolean; appliesToFeed: boolean; calibrationPath?: string; intrinsics?: { model?: string; matrix?: number[][]; distortion?: number[]; rectifiedMatrix?: number[][]; imageSize?: [number, number]; focalLengthMm?: number; rmsReprojectionError?: number; checkerboard?: [number, number]; squareSizeM?: number; raw: Record<string, unknown> }; extrinsics?: { parentFrame?: string; cameraFrame?: string; translationM?: [number, number, number]; rotationQuaternionXyzw?: [number, number, number, number]; direction?: [number, number, number]; raw: Record<string, unknown> }; raw: { camera?: Record<string, unknown>; calibration?: Record<string, unknown>; description?: Record<string, unknown> } };
export type LiveDroidConnectionOptions = DroidConnectionOptions & { clientId?: string; webSocketFactory?: (url: string) => WebSocket };

const DEFAULT_DATAPLANE_URL = "https://vitrus-dataplane.onrender.com";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const numbers = (value: unknown): number[] | undefined => { if (!Array.isArray(value)) return undefined; const flat = value.flat(Infinity); return flat.every((item) => typeof item === "number" && Number.isFinite(item)) ? flat as number[] : undefined; };
const matrix = (value: unknown): number[][] | undefined => Array.isArray(value) && value.every((row) => Array.isArray(row) && row.every((item) => typeof item === "number" && Number.isFinite(item))) ? value as number[][] : undefined;
const vector = (value: unknown, length: number): number[] | undefined => { const parsed = numbers(value); return parsed?.length === length ? parsed : undefined; };
const aliases = (value: unknown): string[] => { if (typeof value !== "string") return []; const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); const short = normalized.replace(/^camera_/, "").replace(/_camera$/, ""); return normalized === short ? [normalized] : [normalized, short]; };
const findCamera = (value: unknown, name: string): Record<string, unknown> | undefined => { if (!Array.isArray(value)) return undefined; const wanted = new Set(aliases(name)); return value.map(record).find((item) => ["name", "safe_name", "display_name", "configured_name", "stable_id", "camera_id"].flatMap((key) => aliases(item[key])).some((alias) => wanted.has(alias))); };

export class Droid {
  static async list(options: LiveDroidConnectionOptions): Promise<DroidIdentity[]> {
    const baseUrl = (options.endpoint || options.relayUrl || DEFAULT_DATAPLANE_URL).replace(/\/+$/, "");
    const headers = { authorization: `Bearer ${options.apiKey}` };
    const response = await controlPlaneFetch(`${baseUrl}/v1/droids`, { headers }, options, "GET /v1/droids");
    const payload = await response.json().catch(() => null) as unknown;
    if (response.ok) {
      if (!Array.isArray(payload)) throw new Error("Vitrus Bridge returned an invalid droid catalog");
      return payload as DroidIdentity[];
    }
    if (response.status !== 404 && response.status !== 405) {
      throw new Error(`Vitrus Droid request failed (${response.status}): ${String(record(payload).detail ?? response.statusText)}`);
    }

    // The deployed Render dataplane currently exposes registered runtime robots
    // through the established Bridge /devices contract. Keep this compatibility
    // path until /v1/droids is deployed there.
    const devicesResponse = await controlPlaneFetch(`${baseUrl}/devices`, { headers }, options, "GET /devices");
    const devicesPayload = await devicesResponse.json().catch(() => null) as unknown;
    if (!devicesResponse.ok) {
      throw new Error(`Vitrus Bridge request failed (${devicesResponse.status}): ${String(record(devicesPayload).detail ?? devicesResponse.statusText)}`);
    }
    const devices = record(devicesPayload).devices;
    if (!Array.isArray(devices)) throw new Error("Vitrus Bridge returned an invalid device catalog");
    return devices.map(record).filter((device) => {
      const metadata = record(device.metadata);
      const key = String(device.key ?? "");
      const kind = String(device.kind ?? "").toLowerCase();
      return /^VTRS-/i.test(key) || kind === "robot" || kind === "droid" || typeof metadata.serialNumber === "string" || typeof metadata.serial_number === "string";
    }).map((device) => {
      const metadata = record(device.metadata);
      const serialNumber = String(metadata.serialNumber ?? metadata.serial_number ?? device.key);
      const rawStatus = String(device.status ?? "unknown");
      const status: DroidIdentity["status"] = ["online", "offline", "degraded"].includes(rawStatus) ? rawStatus as DroidIdentity["status"] : "unknown";
      return {
        id: String(metadata.droidId ?? metadata.droid_id ?? device.id),
        serialNumber,
        model: String(metadata.model ?? device.kind ?? "robot"),
        displayName: typeof device.name === "string" ? device.name : null,
        organizationId: String(metadata.organizationId ?? metadata.organization_id ?? ""),
        status,
        enrollmentState: "enrolled" as const,
      };
    });
  }

  static async connect(ref: DroidRef, options: LiveDroidConnectionOptions): Promise<Droid> {
    const base = await BaseDroid.connect(ref, options);
    const droid = new Droid(base, ref, options);
    droid.identityCache = await base.identity.get();
    return droid;
  }

  readonly identity;
  readonly description;
  readonly presets;
  readonly effectors;
  readonly camera: { list(): Promise<DroidCamera[]>; getFrame(camera: string, options?: CameraFrameOptions): Promise<CameraFrame>; getCalibration(camera: string): Promise<CameraCalibration | null>; openStream(camera: string, options?: CameraStreamOptions): Promise<CameraStream>; openSession(camera: string, options?: { preferredTransport?: CameraMediaTransport | "auto" }): Promise<CameraMediaSession>; closeSession(sessionId: string): Promise<void> };
  readonly telemetry: { snapshot(): Promise<DroidTelemetry>; subscribe(listener: (value: DroidTelemetry) => void, options?: { onStateChange?: (state: DroidRealtimeState, error?: Error) => void }): Promise<DroidRealtimeSubscription> };
  readonly status: { snapshot(): Promise<DeviceStatus>; subscribe(listener: (value: DeviceStatus) => void, options?: { onStateChange?: (state: DroidRealtimeState, error?: Error) => void }): Promise<DroidRealtimeSubscription> };
  readonly events: { subscribe(listener: (event: DroidRealtimeEvent) => void, options?: { onStateChange?: (state: DroidRealtimeState, error?: Error) => void }): Promise<DroidRealtimeSubscription> };
  readonly modules: { list(): Promise<GoldenEdgeModuleCatalog>; configure(moduleId: string, settings: Record<string, unknown>): Promise<Record<string, unknown>> };
  readonly control: { acquire(options?: { durationMs?: number; owner?: string; jointNames?: string[] }): Promise<ControlLease>; renew(leaseId: string, options?: { durationMs?: number }): Promise<ControlLease>; release(leaseId: string): Promise<void> };
  readonly motion: {
    sendTargets(targets: JointTarget[], options: DroidTargetOptions): Promise<DroidCommandResult>;
    sendCartesianTrajectory(options: DroidCartesianTrajectoryOptions): Promise<DroidCommandResult>;
    primeAndWaitReady(targets: JointTarget[], options: DroidPrimeAndWaitReadyOptions): Promise<DroidMotionReady>;
  };
  readonly safety;
  private identityCache: DroidIdentity | null = null;
  private readonly clientId: string;

  private constructor(private readonly base: BaseDroid, private readonly ref: DroidRef, private readonly options: LiveDroidConnectionOptions) {
    this.clientId = options.clientId?.trim() || `vitrus-sdk-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    this.identity = base.identity;
    this.description = base.description;
    this.presets = base.presets;
    this.effectors = base.effectors;
    this.motion = base.motion;
    this.safety = base.safety;
    this.camera = {
      list: () => base.camera.list() as Promise<DroidCamera[]>,
      getFrame: (camera, request = {}) => base.camera.getFrame(camera, request),
      getCalibration: (camera) => this.calibration(camera),
      openStream: (camera, request = {}) => base.camera.openStream(camera, request),
      openSession: (camera, request = {}) => base.camera.openSession(camera, request),
      closeSession: (sessionId) => base.camera.closeSession(sessionId),
    };
    this.telemetry = {
      snapshot: () => base.telemetry.snapshot(),
      subscribe: (listener, request) => this.subscribe((event) => {
        if (event.type !== "droid.telemetry") return;
        listener(normalizeDroidTelemetry(event.telemetry));
      }, request),
    };
    this.status = {
      snapshot: () => base.status.snapshot(),
      subscribe: (listener, request) => this.subscribe((event) => {
        if (event.type !== "droid.status") return;
        listener(normalizeDeviceStatus(event.status));
      }, request),
    };
    this.events = { subscribe: (listener, request) => this.subscribe(listener, request) };
    this.modules = { list: () => base.modules.list(), configure: (moduleId, settings) => base.modules.configure(moduleId, settings) };
    this.control = {
      // BaseDroid owns the Edge transport client and performs the synchronous
      // local acquire after creating the authenticated control-plane lease.
      acquire: (request = {}) => base.control.acquire(request) as Promise<ControlLease>,
      // In Edge mode the local broker owns the lease. Delegating keeps the
      // public Droid wrapper on the same local renewal path as BaseDroid.
      renew: (leaseId, request = {}) => base.control.renew(leaseId, request) as Promise<ControlLease>,
      // BaseDroid owns the active Edge transport client. Delegate release so
      // local broker torque-off acknowledgement happens before cloud revoke.
      release: (leaseId) => base.control.release(leaseId),
    };
  }

  private async calibration(camera: string): Promise<CameraCalibration | null> {
    const [catalog, description] = await Promise.all([this.camera.list(), this.description.get()]);
    const cameraRecord = findCamera(catalog, camera) ?? {};
    const manifest = record(description.manifest);
    const robot = record(description.robot);
    const described = findCamera(description.cameras, camera) ?? findCamera(manifest.cameras, camera) ?? findCamera(robot.cameras, camera) ?? {};
    const fisheye = record(cameraRecord.fisheye);
    const calibration = Object.keys(record(cameraRecord.calibration)).length ? record(cameraRecord.calibration) : fisheye;
    const calibratedIntrinsics = Object.keys(record(calibration.intrinsics)).length ? record(calibration.intrinsics) : record(fisheye.intrinsics);
    const describedIntrinsics = record(described.intrinsics);
    const intrinsicsMatrix = matrix(calibratedIntrinsics.matrix ?? calibratedIntrinsics.K ?? calibration.K ?? fisheye.K);
    const distortion = numbers(calibratedIntrinsics.distortion ?? calibratedIntrinsics.D ?? calibration.D ?? fisheye.D);
    const rectifiedMatrix = matrix(calibratedIntrinsics.rectified_matrix ?? calibratedIntrinsics.new_K ?? calibration.new_K ?? fisheye.new_K);
    const imageSize = vector(calibratedIntrinsics.image_size ?? calibration.image_size ?? fisheye.image_size ?? describedIntrinsics.resolution, 2) as [number, number] | undefined;
    const calibrationExtrinsics = Object.keys(record(calibration.extrinsics)).length ? record(calibration.extrinsics) : record(cameraRecord.extrinsics);
    const translation = vector(calibrationExtrinsics.translation_m ?? calibrationExtrinsics.translation ?? described.local_origin, 3) as [number, number, number] | undefined;
    const quaternion = vector(calibrationExtrinsics.rotation_quaternion_xyzw ?? calibrationExtrinsics.quaternion_xyzw ?? described.local_quaternion_xyzw, 4) as [number, number, number, number] | undefined;
    const direction = vector(described.direction, 3) as [number, number, number] | undefined;
    const parentFrame = typeof calibrationExtrinsics.parent_frame === "string" ? calibrationExtrinsics.parent_frame : typeof described.parent_link === "string" ? described.parent_link : undefined;
    const cameraFrame = typeof calibrationExtrinsics.camera_frame === "string" ? calibrationExtrinsics.camera_frame : typeof described.name === "string" ? described.name : undefined;
    const hasIntrinsics = !!(intrinsicsMatrix || distortion || rectifiedMatrix || imageSize || Object.keys(describedIntrinsics).length);
    const hasExtrinsics = !!(translation || quaternion || direction || parentFrame || cameraFrame);
    if (!hasIntrinsics && !hasExtrinsics && !Object.keys(calibration).length) return null;
    return {
      camera,
      calibrated: calibration.calibrated === true || cameraRecord.calibrated === true,
      appliesToFeed: calibration.applies_to_feed === true || cameraRecord.applies_to_feed === true,
      calibrationPath: typeof calibration.calibration_path === "string" ? calibration.calibration_path : undefined,
      intrinsics: hasIntrinsics ? { model: typeof describedIntrinsics.projection === "string" ? describedIntrinsics.projection : Object.keys(fisheye).length ? "fisheye" : undefined, matrix: intrinsicsMatrix, distortion, rectifiedMatrix, imageSize, focalLengthMm: typeof describedIntrinsics.focal_length_mm === "number" ? describedIntrinsics.focal_length_mm : undefined, rmsReprojectionError: typeof calibration.rms === "number" ? calibration.rms : typeof fisheye.rms === "number" ? fisheye.rms : undefined, checkerboard: vector(calibration.checkerboard ?? fisheye.checkerboard, 2) as [number, number] | undefined, squareSizeM: typeof calibration.square_size === "number" ? calibration.square_size : typeof fisheye.square_size === "number" ? fisheye.square_size : undefined, raw: { calibration: calibratedIntrinsics, fisheye, description: describedIntrinsics } } : undefined,
      extrinsics: hasExtrinsics ? { parentFrame, cameraFrame, translationM: translation, rotationQuaternionXyzw: quaternion, direction, raw: { calibration: calibrationExtrinsics, description: described } } : undefined,
      raw: { camera: cameraRecord, calibration, description: described },
    };
  }

  private async subscribe(listener: (event: DroidRealtimeEvent) => void, options: { onStateChange?: (state: DroidRealtimeState, error?: Error) => void } = {}): Promise<DroidRealtimeSubscription> {
    const identity = this.identityCache ?? await this.identity.get();
    let socket: WebSocket | null = null;
    let state: DroidRealtimeState = "connecting";
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const change = (next: DroidRealtimeState, error?: Error) => { state = next; options.onStateChange?.(next, error); };
    const schedule = (error: Error) => { if (closed || timer) return; change("reconnecting", error); timer = setTimeout(() => { timer = null; connect(); }, Math.min(10_000, 250 * 2 ** Math.min(attempt++, 6))); };
    const connect = () => {
      if (closed) return;
      change(attempt ? "reconnecting" : "connecting");
      try { socket = (this.options.webSocketFactory ?? ((url) => new WebSocket(url)))(this.realtimeUrl()); }
      catch (error) { schedule(error instanceof Error ? error : new Error(String(error))); return; }
      socket.addEventListener("open", () => { attempt = 0; socket?.send(JSON.stringify({ type: "subscribe", topics: ["droids"] })); change("connected"); });
      socket.addEventListener("message", (message) => { try { const event = JSON.parse(String(message.data)) as DroidRealtimeEvent; const target = event.droid as Partial<DroidIdentity> | undefined; if (target && (target.id === identity.id || target.serialNumber === identity.serialNumber)) listener(event); } catch { /* malformed event */ } });
      socket.addEventListener("close", () => { if (!closed) schedule(new Error("Vitrus Bridge realtime connection closed")); });
      socket.addEventListener("error", () => { if (!closed) change("error", new Error("Vitrus Bridge realtime connection failed")); });
    };
    const subscription: DroidRealtimeSubscription = { get state() { return state; }, close: () => { closed = true; if (timer) clearTimeout(timer); socket?.close(1000, "client closed"); change("closed"); } };
    connect();
    return subscription;
  }

  private baseUrl(): string { return (this.options.endpoint || this.options.relayUrl || DEFAULT_DATAPLANE_URL).replace(/\/+$/, ""); }
  private appendRef(params: URLSearchParams): void { if (typeof this.ref === "string") params.set("ref", this.ref); else { if (this.ref.serialNumber) params.set("serial_number", this.ref.serialNumber); if (this.ref.droidId) params.set("droid_id", this.ref.droidId); if (this.ref.alias) params.set("alias", this.ref.alias); } }
  private async post<T>(path: string, body: unknown): Promise<T> { return this.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  private async remove(path: string): Promise<void> { await this.request(path, { method: "DELETE" }); }
  private async request<T>(path: string, init: RequestInit): Promise<T> { const url = new URL(`${this.baseUrl()}${path}`); this.appendRef(url.searchParams); const response = await controlPlaneFetch(url.toString(), { ...init, headers: { authorization: `Bearer ${this.options.apiKey}`, ...(init.headers ?? {}) } }, this.options, `${init.method ?? "GET"} ${path}`); const payload = await response.json().catch(() => null) as unknown; if (!response.ok) throw new Error(`Vitrus Droid request failed (${response.status}): ${String(record(payload).detail ?? response.statusText)}`); return payload as T; }
  private realtimeUrl(): string { const url = new URL(this.baseUrl()); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = `${url.pathname.replace(/\/+$/, "")}/realtime`; url.search = ""; url.searchParams.set("api_key", this.options.apiKey); return url.toString(); }
}

async function controlPlaneFetch(
  url: string,
  init: RequestInit,
  options: LiveDroidConnectionOptions,
  operation: string,
): Promise<Response> {
  const timeoutMs = options.controlPlaneTimeoutMs ?? options.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new DroidRequestTimeoutError(operation, new URL(url).pathname, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
