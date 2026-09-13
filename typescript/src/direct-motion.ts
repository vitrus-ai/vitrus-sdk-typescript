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
  type ContinuousNetworkToleranceProfile,
  type MotionIntentMode,
  type MotionJob,
  type MotionJobStartOptions,
  type MotionJobTransport,
} from "./motion-job.js";
import { PersistentLatestUpdateStream, type DirectMotionStreamFactory, type DirectMotionStreamTelemetryTiming } from "./direct-motion-stream.js";

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
  /**
   * Submit device-IK frames to the bounded public latest-only mailbox.  This
   * removes the caller's dependency on the correlated Edge HTTP turnaround;
   * the receipt is queue admission, never native acceptance.
   */
  latestOnlyUpdates?: boolean;
  /** Observation of the actual public mailbox receipt or transport failure. */
  onLatestUpdate?: (observation: LatestUpdateObservation) => void;
  /** Maximum local queue age before an unsent frame is discarded. */
  latestPendingMaxAgeMs?: number;
  /** Maximum concurrent public latest-update receipts. HTTP defaults to one; WebSocket defaults to sixteen. */
  latestMaxInFlight?: number;
  /** Use a persistent authenticated WebSocket for optional latest-only frames. */
  latestTransport?: "http" | "websocket";
  /** Separate bounded readiness budget for an explicitly prepared WebSocket. */
  latestStreamReadyTimeoutMs?: number;
  /** Receipt-observation budget; source admission deadline remains 500 ms on wire. */
  latestReceiptTimeoutMs?: number;
  /**
   * SDK-only continuous-frame source-age policy. `realtime` retains 500 ms;
   * `variable` selects 1500 ms, and an explicit object permits 501..2000 ms,
   * only for complete continuous frames carrying their original timestamp.
   */
  continuousNetworkTolerance?: ContinuousNetworkToleranceProfile;
  /** Observational telemetry samples delivered on a separate latest-only stream. */
  onLatestStreamTelemetry?: (observation: LatestStreamTelemetryObservation) => void | Promise<void>;
  /**
   * Request Bridge's bounded telemetry acknowledgment protocol for the
   * dedicated observation socket. The dedicated observation stream defaults
   * to four; an older Bridge that omits delivery_seq remains unacknowledged.
   * Values are deliberately limited to Bridge's 1..8 contract.
   */
  telemetryDeliveryWindow?: number;
  /** Injectable only for deterministic local telemetry timing tests. */
  telemetryMonotonicNow?: () => number;
  /** Injectable only for deterministic WebSocket transport tests. */
  webSocketFactory?: DirectMotionStreamFactory;
  clientId?: string;
  /** Injectable only for deterministic transport tests. */
  now?: () => number;
  fetch?: typeof globalThis.fetch;
};

export type LatestStreamTelemetryObservation = {
  /** Raw public Bridge telemetry frame; its source timestamps remain unchanged. */
  sample: Record<string, unknown>;
  /** SDK socket generation; increments only when a new stream is constructed. */
  connectionEpoch: number;
  /** Local monotonic receipt time. It is not a source or Bridge clock. */
  receivedAtMonotonicMs: number;
  /** Local monotonic time immediately before the consumer callback began. */
  callbackDispatchedAtMonotonicMs: number;
  /** Local callback queueing latency, never used for control freshness. */
  callbackDispatchLatencyMs: number;
};

export type LatestUpdateObservation = {
  /** Job identity scopes the observation sequence watermark across restarts. */
  jobId: string | null;
  inputSequence: number | null;
  state: "sending" | "queued" | "failed";
  /** Time the SDK actually began the public request, never a native ACK. */
  sentAtMs: number;
  /** Time the public mailbox receipt or failure was observed. */
  observedAtMs: number;
  receipt?: Record<string, unknown>;
  error?: string;
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
type LatestFragment<T> = { value: T; createdAtMs: number };
type LatestPending = {
  /** The newest compatible envelope supplies job identity and sequence. */
  payload: Record<string, unknown>;
  timeoutMs?: number;
  createdAtMs: number;
  /** Independent Cartesian chains must not overwrite one another in a one-slot queue. */
  chainTargets: Map<string, LatestFragment<Record<string, unknown>>>;
  /** Auxiliary updates always contain their complete immutable auxiliary scope. */
  auxiliaryTargets: LatestFragment<unknown[]> | null;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_START_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 25_000;
/** The public latest route is a source-freshness mailbox, never a long poll. */
const LATEST_SOURCE_DEADLINE_MS = 500;
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
  readonly supportsLatestUpdates: boolean;
  readonly continuousNetworkTolerance: ContinuousNetworkToleranceProfile;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly ref: string;
  private readonly fetchImpl: FetchRequest;
  private readonly latestOnlyUpdates: boolean;
  private latestPending: LatestPending | null = null;
  private readonly latestInFlight = new Set<Promise<void>>();
  private latestError: unknown = null;
  private latestObservation: LatestUpdateObservation | null = null;
  private readonly latestPendingMaxAgeMs: number;
  private readonly latestMaxInFlight: number;
  private readonly latestTransport: "http" | "websocket";
  private readonly latestStreamReadyTimeoutMs: number;
  private readonly latestReceiptTimeoutMs: number;
  private readonly webSocketFactory: DirectMotionStreamFactory | null;
  private latestStream: PersistentLatestUpdateStream | null = null;
  private telemetryStream: PersistentLatestUpdateStream | null = null;
  private latestStreamEpoch = 0;
  private readonly now: () => number;
  private readonly telemetryDeliveryWindow: number | undefined;

  constructor(private readonly options: DirectMotionJobClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.apiKey = requiredText(options.apiKey, "apiKey");
    this.ref = requiredText(options.ref, "ref");
    // Opt in only after the deployed public Bridge advertises the additive
    // endpoint.  Falling back after a mutation would make delivery ambiguous.
    this.latestOnlyUpdates = options.latestOnlyUpdates ?? false;
    this.supportsLatestUpdates = this.latestOnlyUpdates;
    this.continuousNetworkTolerance = normalizeContinuousNetworkTolerance(options.continuousNetworkTolerance);
    const profilePendingAge = typeof this.continuousNetworkTolerance === "object"
      ? this.continuousNetworkTolerance.sourceMaxAgeMs
      : LATEST_SOURCE_DEADLINE_MS;
    this.latestPendingMaxAgeMs = boundedPendingAge(options.latestPendingMaxAgeMs ?? profilePendingAge, profilePendingAge);
    this.latestTransport = options.latestTransport ?? "http";
    // Stream receipts are independent; the mailbox remains one pending merged frame.
    this.latestMaxInFlight = boundedLatestInFlight(options.latestMaxInFlight ?? (this.latestTransport === "websocket" ? 16 : 1), this.latestTransport === "websocket" ? 16 : 4);
    this.latestStreamReadyTimeoutMs = boundedStreamReadyTimeout(options.latestStreamReadyTimeoutMs ?? 2_000);
    this.latestReceiptTimeoutMs = boundedReceiptTimeout(options.latestReceiptTimeoutMs ?? 2_000);
    // This applies only to the separately authenticated telemetry socket.
    // Older Bridges ignore the additive subscribe field and omit delivery_seq,
    // in which case the stream deliberately sends no ACKs.
    this.telemetryDeliveryWindow = boundedTelemetryDeliveryWindow(options.telemetryDeliveryWindow ?? 4);
    this.webSocketFactory = options.webSocketFactory ?? (typeof WebSocket === "undefined" ? null : (url) => new WebSocket(url));
    if (this.latestTransport === "websocket" && !this.webSocketFactory) throw new Error("latest websocket transport requires WebSocket support or webSocketFactory");
    this.now = options.now ?? Date.now;
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
    this.discardLatestUpdates();
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

  /**
   * Force the correlated update route while retaining this client's separate
   * latest-only telemetry capability. This is only an Edge response; callers
   * must still verify native execution independently.
   */
  async requestConfirmed<T>(path: string, payload?: Record<string, unknown>, _method: "GET" | "POST" = "POST", timeoutMs?: number): Promise<T> {
    const operation = OPERATIONS[path];
    if (!operation) throw new Error(`DirectMotionJobClient does not proxy local route ${path}`);
    return this.call<T>(operation, payload ?? {}, timeoutMs, true);
  }

  /**
   * Coalesce continuous setpoints locally before they enter the authenticated
   * public mailbox.  This returns after local admission: native execution is
   * reported later by the existing execution and feedback reads.
   */
  publishLatestUpdate(payload: Record<string, unknown>, timeoutMs?: number): Record<string, unknown> {
    if (!this.latestOnlyUpdates) throw new Error("latest-only updates were not enabled for this public dataplane client");
    const now = this.now();
    const suppliedSourceAtMs = payload.client_created_at_ms;
    if (suppliedSourceAtMs !== undefined && (typeof suppliedSourceAtMs !== "number" || !Number.isSafeInteger(suppliedSourceAtMs)
      || suppliedSourceAtMs < 0 || suppliedSourceAtMs > now)) {
      throw new RangeError("client_created_at_ms must be a non-future non-negative safe integer");
    }
    const createdAtMs = suppliedSourceAtMs === undefined ? now : suppliedSourceAtMs;
    // The Bridge strips this fixed transport envelope field before forwarding
    // to native. It bounds source freshness across a delayed HTTP arrival.
    const next = latestPendingFrame({ ...payload, client_created_at_ms: createdAtMs }, timeoutMs, createdAtMs);
    this.latestPending = this.latestPending === null
      ? next
      : mergeLatestPending(this.latestPending, next);
    this.pumpLatestUpdates();
    return {
      state: "queued",
      input_sequence: payload.sequence,
      delivery: "latest_only_sdk_mailbox",
    };
  }

  /** Authenticate the optional stream before DRIVE target publication. */
  async prepareLatestStream(): Promise<void> {
    if (!this.latestOnlyUpdates || this.latestTransport !== "websocket") throw new Error("latest WebSocket transport was not enabled");
    await this.ensureLatestStream().connect();
    if (this.options.onLatestStreamTelemetry) await this.ensureTelemetryStream().connect();
  }

  async drainLatestUpdates(): Promise<void> {
    while (this.latestInFlight.size || this.latestPending) {
      if (this.latestInFlight.size) await Promise.race(this.latestInFlight);
      else this.pumpLatestUpdates();
    }
    if (this.latestError) {
      const error = this.latestError;
      this.latestError = null;
      throw error;
    }
  }

  /**
   * A Hold or Stop must never first send a superseded local setpoint.  An
   * already transmitted HTTP request remains ambiguous and is reconciled by
   * the terminal command; the Bridge gives terminal commands priority.
   */
  discardLatestUpdates(): void {
    this.latestPending = null;
    this.latestStream?.close();
    this.latestStream = null;
    this.telemetryStream?.close();
    this.telemetryStream = null;
  }

  /** Latest public receipt; it is not a native/physical command acknowledgement. */
  latestUpdateStatus(): LatestUpdateObservation | null {
    return this.latestObservation ? { ...this.latestObservation } : null;
  }

  private pumpLatestUpdates(): void {
    if (this.latestTransport === "websocket" && this.latestPending) {
      const stream = this.ensureLatestStream();
      if (!stream.ready) { void stream.connect().catch(() => undefined); return; }
    }
    while (this.latestInFlight.size < this.latestMaxInFlight && this.latestPending) {
      const next = this.latestPending;
      this.latestPending = null;
      const payload = freshLatestPayload(next, this.now(), this.latestPendingMaxAgeMs);
      const inputSequence = typeof next.payload.sequence === "number" ? next.payload.sequence : null;
      const jobId = typeof next.payload.job_id === "string" ? next.payload.job_id : null;
      const now = this.now();
      if (payload === null) {
        this.publishLatestObservation({ jobId, inputSequence, state: "failed", sentAtMs: next.createdAtMs, observedAtMs: now, error: "latest direct-motion update expired locally before public delivery" });
        continue;
      }
      const sentAtMs = now;
      this.publishLatestObservation({ jobId, inputSequence, state: "sending", sentAtMs, observedAtMs: sentAtMs });
      const sourceDeadlineMs = sourceDeadlineForPayload(payload);
      // The Bridge envelope deadline equals the unmodified source-age budget.
      // It cannot be renewed by a retry or by a merged later frame.
      const timeoutMs = Math.min(next.timeoutMs ?? sourceDeadlineMs, sourceDeadlineMs);
      let request!: Promise<void>;
      const receipt = this.latestTransport === "websocket"
        ? this.latestStream!.submit(createRequestId(), payload, timeoutMs, this.latestReceiptTimeoutMs)
        : this.call<Record<string, unknown>>("update", payload, timeoutMs);
      request = receipt.then((value) => {
        this.publishLatestObservation({ jobId, inputSequence, state: "queued", sentAtMs, observedAtMs: this.now(), receipt: value });
      }, (error) => {
        this.latestError = error;
        this.publishLatestObservation({ jobId, inputSequence, state: "failed", sentAtMs, observedAtMs: this.now(), error: error instanceof Error ? error.message : String(error) });
      }).finally(() => { this.latestInFlight.delete(request); this.pumpLatestUpdates(); });
      this.latestInFlight.add(request);
    }
  }

  private ensureLatestStream(): PersistentLatestUpdateStream {
    if (this.latestStream) return this.latestStream;
    if (!this.latestStream) {
      const url = new URL(`${this.endpoint}/v1/droids/motion/direct/stream`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ref", this.ref);
      const connectionEpoch = ++this.latestStreamEpoch;
      let stream: PersistentLatestUpdateStream;
      stream = new PersistentLatestUpdateStream({
        url: url.toString(), apiKey: this.apiKey, clientId: this.options.clientId ?? "direct-motion-sdk",
        factory: this.webSocketFactory!, readyTimeoutMs: this.latestStreamReadyTimeoutMs,
        onReady: () => this.pumpLatestUpdates(),
        onLost: (error) => {
          if (this.latestStream !== stream) return;
          this.latestStream = null;
          const pending = this.latestPending; this.latestPending = null;
          if (pending) this.publishLatestObservation({ jobId: typeof pending.payload.job_id === "string" ? pending.payload.job_id : null, inputSequence: typeof pending.payload.sequence === "number" ? pending.payload.sequence : null, state: "failed", sentAtMs: pending.createdAtMs, observedAtMs: this.now(), error: error.message });
        },
      });
      this.latestStream = stream;
      void stream.connect().catch(() => undefined);
    }
    return this.latestStream;
  }

  private ensureTelemetryStream(): PersistentLatestUpdateStream {
    if (this.telemetryStream) return this.telemetryStream;
    const url = new URL(`${this.endpoint}/v1/droids/motion/direct/telemetry/stream`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ref", this.ref);
    const connectionEpoch = ++this.latestStreamEpoch;
    let stream: PersistentLatestUpdateStream;
    stream = new PersistentLatestUpdateStream({
      url: url.toString(), apiKey: this.apiKey, clientId: this.options.clientId ?? "direct-motion-sdk",
      factory: this.webSocketFactory!, readyTimeoutMs: this.latestStreamReadyTimeoutMs,
      onReady: () => undefined,
      onTelemetry: (sample, timing: DirectMotionStreamTelemetryTiming) => this.options.onLatestStreamTelemetry?.({ sample, connectionEpoch, ...timing }),
      telemetryDeliveryWindow: this.telemetryDeliveryWindow,
      monotonicNow: this.options.telemetryMonotonicNow,
      // Observation transport loss never makes a pending control frame look
      // rejected or unknown. Direct receipts retain their own connection.
      onLost: () => { if (this.telemetryStream === stream) this.telemetryStream = null; },
    });
    this.telemetryStream = stream;
    void stream.connect().catch(() => undefined);
    return stream;
  }

  private publishLatestObservation(observation: LatestUpdateObservation): void {
    // Completion order is not public sequence order once callers explicitly
    // opt into more than one request. Retain current status only for the
    // same/newer sequence in this job; still publish every event for tracing.
    const current = this.latestObservation;
    if (
      current === null
      || observation.jobId !== current.jobId
      || observation.inputSequence === null
      || current.inputSequence === null
      || observation.inputSequence >= current.inputSequence
    ) this.latestObservation = observation;
    try { this.options.onLatestUpdate?.(observation); } catch { /* Observer failures cannot affect control. */ }
  }

  private async call<T>(operation: DirectMotionOperation, payload: Record<string, unknown>, timeoutMs?: number, forceConfirmed = false): Promise<T> {
    const timeout = boundedTimeout(timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    const requestId = createRequestId();
    const readOnly = operation === "status" || operation === "execution" || operation === "feedback";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    // Only continuous device-IK frames use the nonblocking mailbox route.
    // Start, stop, hold, heartbeat, safety, and all reads retain their exact
    // correlated Edge result semantics.
    const path = operation === "update" && this.latestOnlyUpdates && !forceConfirmed && isContinuousDeviceIkFrame(payload)
      ? "/v1/droids/motion/direct/latest"
      : `/v1/droids/motion/direct/${operation}`;
    const url = new URL(`${this.endpoint}${path}`);
    url.searchParams.set("ref", this.ref);
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "x-vitrus-trace-id": requestId },
        body: JSON.stringify({ request_id: requestId, payload, timeout_ms: timeout }),
        signal: controller.signal,
      });
      // Do not turn a deadline abort during body consumption into a malformed
      // JSON response. Fetch implementations may resolve headers first and only
      // reject response.json() when the abort reaches the body reader.
      let result: MotionErrorPayload | T | null;
      try {
        result = await response.json() as MotionErrorPayload | T;
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        result = null;
      }
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

/**
 * Describe a frame as independent latest-only intents.  The SDK only merges
 * frames it can prove share one device-IK contract; unknown/update lifecycle
 * payloads retain the old whole-frame replacement semantics.
 */
function latestPendingFrame(payload: Record<string, unknown>, timeoutMs: number | undefined, createdAtMs: number): LatestPending {
  const chainTargets = new Map<string, LatestFragment<Record<string, unknown>>>();
  const rawTargets = payload.chain_targets;
  if (Array.isArray(rawTargets)) {
    for (const target of rawTargets) {
      if (!target || typeof target !== "object" || Array.isArray(target)) continue;
      const item = target as Record<string, unknown>;
      if (typeof item.chain !== "string" || !item.chain || !Array.isArray(item.points) || !item.points.length) continue;
      chainTargets.set(item.chain, { value: { ...item }, createdAtMs });
    }
  }
  const rawAuxiliary = payload.auxiliary_joint_targets;
  const auxiliaryTargets = Array.isArray(rawAuxiliary)
    ? { value: [...rawAuxiliary], createdAtMs }
    : null;
  return { payload, timeoutMs, createdAtMs, chainTargets, auxiliaryTargets };
}

function latestFrameContract(payload: Record<string, unknown>): string | null {
  if (payload.operation !== undefined || !Array.isArray(payload.controlled_chains)) return null;
  if (!payload.controlled_chains.length || !payload.controlled_chains.every(value => typeof value === "string" && value.length > 0)) return null;
  if (new Set(payload.controlled_chains).size !== payload.controlled_chains.length) return null;
  if (!Array.isArray(payload.chain_targets)) return null;
  if (!payload.chain_targets.length && !Array.isArray(payload.auxiliary_joint_targets)) return null;
  const chains = new Set<string>();
  for (const target of payload.chain_targets) {
    if (!target || typeof target !== "object" || Array.isArray(target)) return null;
    const item = target as Record<string, unknown>;
    if (typeof item.chain !== "string" || !item.chain || !payload.controlled_chains.includes(item.chain)
      || !Array.isArray(item.points) || !item.points.length || chains.has(item.chain)) return null;
    chains.add(item.chain);
  }
  const contract = { ...payload };
  delete contract.sequence;
  delete contract.chain_targets;
  delete contract.auxiliary_joint_targets;
  delete contract.client_created_at_ms;
  try { return stableJson(contract); }
  catch { return null; }
}

function mergeLatestPending(previous: LatestPending, next: LatestPending): LatestPending {
  const previousContract = latestFrameContract(previous.payload);
  const nextContract = latestFrameContract(next.payload);
  if (previousContract === null || nextContract === null || previousContract !== nextContract) return next;
  const chainTargets = new Map(previous.chainTargets);
  for (const [chain, fragment] of next.chainTargets) chainTargets.set(chain, fragment);
  const earliestSourceAtMs = Math.min(previous.createdAtMs, next.createdAtMs);
  return {
    ...next,
    payload: { ...next.payload, client_created_at_ms: earliestSourceAtMs },
    createdAtMs: earliestSourceAtMs,
    chainTargets,
    auxiliaryTargets: next.auxiliaryTargets ?? previous.auxiliaryTargets,
  };
}

function freshLatestPayload(pending: LatestPending, now: number, maxAgeMs: number): Record<string, unknown> | null {
  const contract = latestFrameContract(pending.payload);
  // Preserve legacy whole-payload handling for inputs outside the narrowly
  // validated device-IK frame representation.
  if (contract === null) return now - pending.createdAtMs > maxAgeMs ? null : pending.payload;
  const freshChains = [...pending.chainTargets.values()]
    .filter(fragment => now - fragment.createdAtMs <= maxAgeMs)
    .map(fragment => fragment.value);
  const freshAuxiliary = pending.auxiliaryTargets !== null && now - pending.auxiliaryTargets.createdAtMs <= maxAgeMs
    ? pending.auxiliaryTargets.value
    : null;
  if (!freshChains.length && freshAuxiliary === null) return null;
  const sourceAtMs = Math.min(
    ...[...pending.chainTargets.values()].filter(fragment => now - fragment.createdAtMs <= maxAgeMs).map(fragment => fragment.createdAtMs),
    ...(freshAuxiliary === null ? [] : [pending.auxiliaryTargets!.createdAtMs]),
  );
  const payload: Record<string, unknown> = { ...pending.payload, client_created_at_ms: sourceAtMs, chain_targets: freshChains };
  delete payload.auxiliary_joint_targets;
  if (freshAuxiliary !== null) payload.auxiliary_joint_targets = freshAuxiliary;
  return payload;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

/** Only frame-shaped continuous device-IK targets may use the nonblocking mailbox. */
function isContinuousDeviceIkFrame(payload: Record<string, unknown>): boolean {
  // Lifecycle updates carry an explicit operation (for example `hold` or
  // `joint_park`) and must retain their correlated public acknowledgement.
  // publishLatestUpdate alone stamps client_created_at_ms. Older update APIs
  // do not carry that transport-owned field and remain correlated.
  return payload.operation === undefined
    && typeof payload.client_created_at_ms === "number"
    && Number.isFinite(payload.client_created_at_ms);
}

function boundedPendingAge(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value < 1 || value > maximum) {
    throw new RangeError(`latestPendingMaxAgeMs must be a finite value in [1, ${maximum}]`);
  }
  return Math.trunc(value);
}
function normalizeContinuousNetworkTolerance(value: ContinuousNetworkToleranceProfile | undefined): ContinuousNetworkToleranceProfile {
  if (value === undefined || value === "realtime") return "realtime";
  if (value === "variable") return { sourceMaxAgeMs: 1_500 };
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.sourceMaxAgeMs)
    || value.sourceMaxAgeMs <= LATEST_SOURCE_DEADLINE_MS || value.sourceMaxAgeMs > 2_000) {
    throw new RangeError("continuousNetworkTolerance.sourceMaxAgeMs must be an integer from 501 through 2000");
  }
  return { sourceMaxAgeMs: value.sourceMaxAgeMs };
}
function sourceDeadlineForPayload(payload: Record<string, unknown>): number {
  const value = payload.source_max_age_ms;
  if (value === undefined) return LATEST_SOURCE_DEADLINE_MS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= LATEST_SOURCE_DEADLINE_MS || value > 2_000) {
    throw new RangeError("continuous source_max_age_ms must be an integer from 501 through 2000");
  }
  return value;
}

function boundedLatestInFlight(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value < 1 || value > maximum) {
    throw new RangeError(`latestMaxInFlight must be a finite value in [1, ${maximum}]`);
  }
  return Math.trunc(value);
}
function boundedStreamReadyTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 50 || value > 10_000) throw new RangeError("latestStreamReadyTimeoutMs must be a finite value in [50, 10000]");
  return Math.trunc(value);
}
function boundedReceiptTimeout(value: number): number {
  if (!Number.isFinite(value) || value < LATEST_SOURCE_DEADLINE_MS || value > 10_000) throw new RangeError("latestReceiptTimeoutMs must be a finite value in [500, 10000]");
  return Math.trunc(value);
}
function boundedTelemetryDeliveryWindow(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > 8) throw new RangeError("telemetryDeliveryWindow must be a finite value in [1, 8]");
  return Math.trunc(value);
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
