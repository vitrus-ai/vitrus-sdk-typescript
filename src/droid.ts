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
