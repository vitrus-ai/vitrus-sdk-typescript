export type DirectMotionStreamSocket = Pick<WebSocket, "send" | "close" | "addEventListener" | "bufferedAmount">;
export type DirectMotionStreamFactory = (url: string) => DirectMotionStreamSocket;

/** Local timing captured after a public telemetry frame reaches this SDK. */
export type DirectMotionStreamTelemetryTiming = {
  /** Monotonic SDK clock when the WebSocket message event was received. */
  receivedAtMonotonicMs: number;
  /** Monotonic SDK clock immediately before the observer was invoked. */
  callbackDispatchedAtMonotonicMs: number;
  /** Local queueing time only; it is not comparable to a source timestamp. */
  callbackDispatchLatencyMs: number;
};

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/**
 * One authenticated, duplex latest-update stream. It never reconnects or
 * replays: callers explicitly submit a new current intent after a loss.
 */
export class PersistentLatestUpdateStream {
  private socket: DirectMotionStreamSocket | null = null;
  private readyValue = false;
  private connecting: Promise<void> | null = null;
  private connectingReject: ((error: Error) => void) | null = null;
  private readonly pending = new Map<string, Pending>();
  // Legacy telemetry has no delivery acknowledgement, so retain only the
  // latest callback. Negotiated telemetry is bounded by the peer's delivery
  // window and each frame must be observed before it is acknowledged.
  private latestTelemetry: { message: Record<string, unknown>; receivedAtMonotonicMs: number } | null = null;
  private readonly acknowledgedTelemetry: Array<{ message: Record<string, unknown>; deliverySeq: number; receivedAtMonotonicMs: number }> = [];
  private telemetryDispatchTimer: ReturnType<typeof setTimeout> | null = null;
  private telemetryDispatching = false;
  // This is set only by this socket's explicit Bridge subscription response.
  // A request alone is not protocol negotiation: older Bridges may ignore it.
  private negotiatedTelemetryDeliveryWindow: number | undefined;
  private closed = false;

  constructor(private readonly options: {
    url: string; apiKey: string; clientId: string; factory: DirectMotionStreamFactory;
    onReady: () => void; onLost: (error: Error) => void; readyTimeoutMs: number;
    onTelemetry?: (sample: Record<string, unknown>, timing: DirectMotionStreamTelemetryTiming) => void | Promise<void>;
    /** Additive protocol capability. Omit it for a legacy telemetry stream. */
    telemetryDeliveryWindow?: number;
    /** Injectable only for deterministic timing tests. */
    monotonicNow?: () => number;
  }) {}

  get ready(): boolean { return this.readyValue; }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("latest-update stream is closed"));
    if (this.readyValue) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      this.connectingReject = reject;
      let authSent = false;
      let timer = setTimeout(() => fail(new Error("latest-update stream authentication timed out")), this.options.readyTimeoutMs);
      const fail = (error: Error) => {
        clearTimeout(timer); timer = undefined as never;
        if (this.connecting === null && !this.socket) return;
        this.readyValue = false; this.connecting = null;
        const rejectConnecting = this.connectingReject;
        this.connectingReject = null;
        // Clear first because some WebSocket implementations synchronously emit close().
        const socket = this.socket;
        this.socket = null;
        this.clearQueuedTelemetry();
        try { socket?.close(1011, "latest stream unavailable"); } catch { /* best effort */ }
        rejectConnecting?.(error);
        this.failAll(error);
        this.options.onLost(error);
      };
      try {
        const socket = this.options.factory(this.options.url);
        this.socket = socket;
        socket.addEventListener("open", () => {
          if (this.socket !== socket || this.closed) return;
          try {
            socket.send(JSON.stringify({ type: "authenticate", api_key: this.options.apiKey, client_id: this.options.clientId }));
            authSent = true;
          } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
        });
        socket.addEventListener("message", (event) => {
          if (this.socket !== socket || this.closed) return;
          let message: Record<string, unknown>;
          try { message = JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>; } catch { return; }
          if (message.type === "ready") {
            if (!authSent) { fail(new Error("latest-update stream became ready before authentication")); return; }
            clearTimeout(timer); timer = undefined as never;
            this.readyValue = true; this.connecting = null; this.connectingReject = null;
            // Telemetry is opt-in and has its own Bridge mailbox. Subscribe once
            // for this authenticated socket before the caller can publish targets.
            if (this.options.onTelemetry) {
              const subscribe: Record<string, unknown> = { type: "subscribe", topics: ["telemetry"] };
              if (this.options.telemetryDeliveryWindow !== undefined) subscribe.telemetry_delivery_window = this.options.telemetryDeliveryWindow;
              try { socket.send(JSON.stringify(subscribe)); }
              catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
            }
            resolve(); this.options.onReady(); return;
          }
          if (message.type === "telemetry") {
            this.queueTelemetry(message, socket);
            return;
          }
          if (message.type === "subscribed") {
            const window = message.telemetry_delivery_window;
            this.negotiatedTelemetryDeliveryWindow = this.options.onTelemetry
              && window === this.options.telemetryDeliveryWindow
              && Number.isSafeInteger(window)
              && (window as number) >= 1
              && (window as number) <= 8
              ? window as number
              : undefined;
            return;
          }
          if (message.type === "receipt" && typeof message.request_id === "string") {
            const pending = this.pending.get(message.request_id); if (!pending) return;
            this.pending.delete(message.request_id); clearTimeout(pending.timer);
            const result = message.result;
            if (!result || typeof result !== "object" || Array.isArray(result)) pending.reject(new Error("latest-update stream receipt lacks result"));
            else pending.resolve(result as Record<string, unknown>);
            return;
          }
          if (message.type === "error") {
            const detail = typeof message.detail === "string" ? message.detail : "latest-update stream rejected request";
            if (typeof message.request_id === "string" && this.pending.has(message.request_id)) {
              const pending = this.pending.get(message.request_id)!; this.pending.delete(message.request_id); clearTimeout(pending.timer); pending.reject(new Error(detail));
            } else fail(new Error(detail));
          }
        });
        // The browser cannot know whether a request already reached the
        // public mailbox when its duplex connection disappears.  Preserve
        // that uncertainty instead of making a lost receipt look like a
        // rejected target; callers must observe native evidence and submit a
        // new current intent after explicitly preparing a replacement stream.
        socket.addEventListener("close", () => { if (this.socket === socket) fail(new Error("latest-update stream closed before receipt; execution unknown")); });
        socket.addEventListener("error", () => { if (this.socket === socket) fail(new Error("latest-update stream transport error before receipt; execution unknown")); });
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    const connection = this.connecting;
    // connect() may be invoked fire-and-forget from a publisher. Prevent an
    // unhandled rejection while still returning the exact failure to prepare().
    void connection.catch(() => undefined);
    return connection;
  }

  submit(requestId: string, payload: Record<string, unknown>, timeoutMs: number, receiptTimeoutMs: number): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!this.readyValue || !socket) return Promise.reject(new Error("latest-update stream is not authenticated"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`latest-update receipt unconfirmed after ${receiptTimeoutMs} ms; execution unknown`));
      }, receiptTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      if (socket.bufferedAmount > 64 * 1024) {
        clearTimeout(timer); this.pending.delete(requestId);
        reject(new Error("latest-update stream backpressure exceeds 65536 bytes"));
        return;
      }
      try { socket.send(JSON.stringify({ type: "latest_update", request_id: requestId, payload, timeout_ms: timeoutMs })); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  close(): void {
    this.closed = true; this.readyValue = false;
    const error = new Error("latest-update stream closed by client");
    const socket = this.socket;
    // A pending explicit prepare must complete immediately on terminal cleanup.
    this.socket = null; this.connecting = null;
    this.clearQueuedTelemetry();
    const rejectConnecting = this.connectingReject; this.connectingReject = null;
    rejectConnecting?.(error);
    this.failAll(error);
    try { socket?.close(1000, "client closed"); } catch { /* best effort */ }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  private queueTelemetry(message: Record<string, unknown>, socket: DirectMotionStreamSocket): void {
    if (!this.options.onTelemetry) return;
    const receivedAtMonotonicMs = this.monotonicNow();
    const deliverySeq = message.delivery_seq;
    if (Number.isSafeInteger(deliverySeq) && (deliverySeq as number) > 0) {
      const window = this.negotiatedTelemetryDeliveryWindow;
      // A sequence from a server that did not negotiate a bounded window is
      // observational legacy data. Do not send an unsolicited acknowledgement.
      if (window !== undefined) {
        if (this.acknowledgedTelemetry.length >= window) {
          this.failTelemetryLane(socket, new Error("telemetry delivery window exceeded before callback acknowledgment"));
          return;
        }
        this.acknowledgedTelemetry.push({ message, deliverySeq: deliverySeq as number, receivedAtMonotonicMs });
        this.scheduleTelemetryDispatch(socket);
        return;
      }
    }
    this.latestTelemetry = { message, receivedAtMonotonicMs };
    this.scheduleTelemetryDispatch(socket);
  }

  private scheduleTelemetryDispatch(socket: DirectMotionStreamSocket): void {
    if (this.telemetryDispatchTimer !== null) return;
    this.telemetryDispatchTimer = setTimeout(() => {
      this.telemetryDispatchTimer = null;
      void this.dispatchTelemetry(socket);
    }, 0);
  }

  private async dispatchTelemetry(socket: DirectMotionStreamSocket): Promise<void> {
    if (this.telemetryDispatching || this.socket !== socket || !this.readyValue || this.closed) return;
    const acknowledged = this.acknowledgedTelemetry[0];
    const legacy = acknowledged ? null : this.latestTelemetry;
    if (legacy) this.latestTelemetry = null;
    const item = acknowledged ?? legacy;
    if (!item) return;
    this.telemetryDispatching = true;
    const callbackDispatchedAtMonotonicMs = this.monotonicNow();
    const timing: DirectMotionStreamTelemetryTiming = {
      receivedAtMonotonicMs: item.receivedAtMonotonicMs,
      callbackDispatchedAtMonotonicMs,
      callbackDispatchLatencyMs: Math.max(0, callbackDispatchedAtMonotonicMs - item.receivedAtMonotonicMs),
    };
    try {
      // Telemetry observer errors are advisory, but the attempted callback is
      // complete before ACK so Bridge can safely advance its bounded window.
      try { await this.options.onTelemetry?.(item.message, timing); } catch { /* advisory observer failure */ }
      if (acknowledged && this.socket === socket && this.readyValue && !this.closed) {
        try {
          socket.send(JSON.stringify({ type: "telemetry_ack", delivery_seq: acknowledged.deliverySeq }));
          // Keep an in-flight delivery in the window until its callback has
          // settled and its ACK was actually handed to the socket.
          this.acknowledgedTelemetry.shift();
        }
        catch (error) { this.failTelemetryLane(socket, error instanceof Error ? error : new Error(String(error))); return; }
      }
    } finally {
      this.telemetryDispatching = false;
      if ((this.acknowledgedTelemetry.length > 0 || this.latestTelemetry !== null) && this.socket === socket && this.readyValue && !this.closed) this.scheduleTelemetryDispatch(socket);
    }
  }

  private failTelemetryLane(socket: DirectMotionStreamSocket, error: Error): void {
    if (this.socket !== socket) return;
    this.readyValue = false;
    this.socket = null;
    this.clearQueuedTelemetry();
    try { socket.close(1011, "telemetry stream unavailable"); } catch { /* best effort */ }
    this.options.onLost(error);
  }

  private monotonicNow(): number {
    if (this.options.monotonicNow) return this.options.monotonicNow();
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  private clearQueuedTelemetry(): void {
    this.latestTelemetry = null;
    this.acknowledgedTelemetry.length = 0;
    this.negotiatedTelemetryDeliveryWindow = undefined;
    if (this.telemetryDispatchTimer !== null) clearTimeout(this.telemetryDispatchTimer);
    this.telemetryDispatchTimer = null;
  }
}
