/**
 * Authenticated public-data-plane transport for native direct-control jobs.
 *
 * It implements the narrow MotionJobTransport consumed by the shared,
 * full-featured MotionJobSession.  The client has no Edge endpoint, device
 * credential, or broker lease; the data plane correlates a request with the
 * enrolled Edge result before returning it.
 */
import {
  MotionControlError,
  MotionJobSession,
  type MotionErrorPayload,
  type MotionIntentMode,
  type MotionJob,
  type MotionJobStartOptions,
  type MotionJobTransport,
} from "./motion-job.js";

export type DirectMotionOperation =
  | "status"
  | "execution"
  | "feedback"
  | "start"
  | "update"
  | "heartbeat"
  | "stop"
  | "safety-stop";

export type DirectMotionJobClientOptions = {
  /** Public Vitrus dataplane origin. An Edge URL is never accepted here. */
  endpoint: string;
  apiKey: string;
  /** Serial or other Droid.connect reference. */
  ref: string;
  requestTimeoutMs?: number;
  startTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

export type DirectMotionStartReceipt = {
  session: MotionJobSession;
  /** Exact correlated Edge response, with any data-plane timing untouched. */
  receipt: Record<string, unknown>;
  initialFeedback?: Record<string, unknown>;
  primeReceipt?: Record<string, unknown>;
};

type FetchRequest = (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => Promise<Response>;
type StartResponse = { ok: true; job: MotionJob; initial_feedback?: Record<string, unknown>; prime_receipt?: Record<string, unknown> } & Record<string, unknown>;
type StatusResponse = { ok: true; job: MotionJob | null; service?: string; events?: Array<Record<string, unknown>> };

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_START_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 25_000;
const OPERATIONS: Record<string, DirectMotionOperation> = {
  "/api/v2/motion/status": "status",
  "/api/v2/motion/start": "start",
  "/api/v2/motion/update": "update",
  "/api/v2/motion/heartbeat": "heartbeat",
  "/api/v2/motion/stop": "stop",
  "/api/v2/safety/stop": "safety-stop",
  "/api/dora/ik/status": "execution",
  "/api/motor-bridge/status": "feedback",
};

/** Full MotionJobClient-compatible surface, routed only through the public API. */
export class DirectMotionJobClient implements MotionJobTransport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly ref: string;
  private readonly fetchImpl: FetchRequest;

  constructor(private readonly options: DirectMotionJobClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.apiKey = requiredText(options.apiKey, "apiKey");
    this.ref = requiredText(options.ref, "ref");
    if (!this.endpoint) throw new Error("DirectMotionJobClient requires a public dataplane endpoint");
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async startJob(options: MotionJobStartOptions): Promise<MotionJobSession> {
    return (await this.startWithReceipt(options)).session;
  }

  async startWithReceipt(options: MotionJobStartOptions): Promise<DirectMotionStartReceipt> {
    if (options.mode !== "device_ik") throw new Error("native direct control only supports device_ik jobs");
    const names = normalizeScope(options.jointNames);
    // An explicit empty auxiliary declaration means this device-IK job has no
    // servo-only scope.  Primary jointNames remain non-empty and unique.
    const auxiliaryNames = options.auxiliaryJointNames === undefined ? undefined : normalizeOptionalAuxiliaryScope(options.auxiliaryJointNames);
    if (auxiliaryNames !== undefined && auxiliaryNames.some(name => !names.includes(name))) {
      throw new Error("auxiliaryJointNames must be a subset of jointNames");
    }
    const receipt = await this.request<StartResponse>("/api/v2/motion/start", {
      mode: options.mode,
      owner: requiredText(options.owner, "owner"),
      joint_names: names,
      ...(auxiliaryNames === undefined ? {} : { auxiliary_joint_names: auxiliaryNames }),
      ...(options.jobId ? { job_id: requiredText(options.jobId, "jobId") } : {}),
      ...(options.configurationRevision ? { configuration_revision: options.configurationRevision } : {}),
      ...(options.clientLivenessMs == null ? {} : { client_liveness_ms: options.clientLivenessMs }),
      ...(options.intentMode == null ? {} : { intent_mode: validIntent(options.intentMode) }),
      ...(options.targetLivenessMs == null ? {} : { target_liveness_ms: options.targetLivenessMs }),
    }, "POST", this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    if (!receipt.job || typeof receipt.job !== "object") throw invalidResponse("direct start response lacks a job");
    const initialFeedback = record(receipt.initial_feedback);
    const primeReceipt = record(receipt.prime_receipt);
    return {
      session: new MotionJobSession(this, receipt.job),
      receipt,
      ...(initialFeedback ? { initialFeedback } : {}),
      ...(primeReceipt ? { primeReceipt } : {}),
    };
  }

  async status(): Promise<StatusResponse> { return this.request("/api/v2/motion/status", undefined, "GET"); }
  async execution(): Promise<Record<string, unknown>> { return this.request("/api/dora/ik/status", undefined, "GET"); }
  async feedback(): Promise<Record<string, unknown>> { return this.request("/api/motor-bridge/status", undefined, "GET"); }
  async safetyStop(reason = "operator_stop"): Promise<Record<string, unknown>> {
    return this.request("/api/v2/safety/stop", { reason: requiredText(reason, "reason") });
  }

  /**
   * The shared MotionJobSession calls canonical local-looking paths.  This
   * transport maps that closed allowlist to public operations; arbitrary Edge
   * routes cannot be requested through it.
   */
  async request<T>(path: string, payload?: Record<string, unknown>, _method: "GET" | "POST" = "POST", timeoutMs?: number): Promise<T> {
    const operation = OPERATIONS[path];
    if (!operation) throw new Error(`DirectMotionJobClient does not proxy local route ${path}`);
    return this.call<T>(operation, payload ?? {}, timeoutMs);
  }

  private async call<T>(operation: DirectMotionOperation, payload: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const timeout = boundedTimeout(timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    const requestId = createRequestId();
    const readOnly = operation === "status" || operation === "execution" || operation === "feedback";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const url = new URL(`${this.endpoint}/v1/droids/motion/direct/${operation}`);
    url.searchParams.set("ref", this.ref);
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "x-vitrus-trace-id": requestId },
        body: JSON.stringify({ request_id: requestId, payload, timeout_ms: timeout }),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => null) as MotionErrorPayload | T | null;
      if (!response.ok) throw responseError(result, response.status, response.statusText, requestId, readOnly);
      if (!result || typeof result !== "object") throw invalidResponse("direct motion service returned invalid JSON", requestId);
      return result as T;
    } catch (error) {
      if (error instanceof MotionControlError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new MotionControlError({ ok: false, error: `direct motion request timed out after ${timeout} ms`, code: readOnly ? "MOTION_REQUEST_TIMEOUT" : "MOTION_APPLICATION_UNKNOWN", domain: "transport", retryable: readOnly, trace_id: requestId }, 504);
      }
      throw new MotionControlError({ ok: false, error: error instanceof Error ? error.message : String(error), code: readOnly ? "MOTION_TRANSPORT_ERROR" : "MOTION_APPLICATION_UNKNOWN", domain: "transport", retryable: readOnly, trace_id: requestId }, 503);
    } finally {
      clearTimeout(timer);
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function requiredText(value: string | undefined, label: string): string {
  const text = value?.trim() ?? "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}
function normalizeScope(names: string[]): string[] {
  const scope = names.map(name => requiredText(name, "jointNames[]"));
  if (!scope.length || new Set(scope).size !== scope.length) throw new Error("jointNames must be a unique non-empty scope");
  return scope;
}
function normalizeOptionalAuxiliaryScope(names: string[]): string[] {
  if (!Array.isArray(names)) throw new Error("auxiliaryJointNames must be an array when specified");
  return names.length === 0 ? [] : normalizeScope(names);
}
function validIntent(value: MotionIntentMode): MotionIntentMode {
  if (value !== "continuous_setpoint" && value !== "execute_goal") throw new Error("intentMode is invalid");
  return value;
}
function boundedTimeout(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("timeoutMs must be finite");
  return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.trunc(value)));
}
function responseError(value: unknown, status: number, statusText: string, traceId: string, readOnly: boolean): MotionControlError {
  const body = record(value);
  const unknown = body?.error === "direct_motion_application_unknown" || (!readOnly && status >= 500);
  // The native direct-control HTTP handler deliberately returns a compact
  // `{error, message}` body for definite request rejections.  `error` is its
  // stable machine code while `message` says which validation failed.  It is
  // not an SDK MotionErrorPayload, but both parts remain useful to callers.
  const remoteCode = text(body?.code) ?? text(body?.error);
  const remoteMessage = text(body?.message) ?? text(body?.detail) ?? text(body?.error);
  const error = isMotionErrorPayload(value)
    ? { ...value, ...(unknown ? { retryable: false } : {}) }
    : {
      ok: false as const,
      error: remoteMessage ?? (statusText || "direct motion request failed"),
      code: unknown ? "MOTION_APPLICATION_UNKNOWN" : remoteCode ?? (status === 504 ? "MOTION_REQUEST_TIMEOUT" : "MOTION_TRANSPORT_ERROR"),
      domain: text(body?.domain) ?? "transport",
      retryable: readOnly && status >= 500,
      trace_id: traceId,
    };
  return new MotionControlError(error, status);
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function invalidResponse(error: string, traceId?: string): MotionControlError {
  return new MotionControlError({ ok: false, error, code: "MOTION_INVALID_RESPONSE", domain: "transport", retryable: true, ...(traceId ? { trace_id: traceId } : {}) }, 502);
}
function isMotionErrorPayload(value: unknown): value is MotionErrorPayload {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).ok === false && typeof (value as Record<string, unknown>).code === "string" && typeof (value as Record<string, unknown>).error === "string");
}
function createRequestId(): string {
  const random = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  return random ? random() : `direct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
