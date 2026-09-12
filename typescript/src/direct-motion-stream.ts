export type DirectMotionStreamSocket = Pick<WebSocket, "send" | "close" | "addEventListener" | "bufferedAmount">;
export type DirectMotionStreamFactory = (url: string) => DirectMotionStreamSocket;

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
  private closed = false;

  constructor(private readonly options: {
    url: string; apiKey: string; clientId: string; factory: DirectMotionStreamFactory;
    onReady: () => void; onLost: (error: Error) => void; readyTimeoutMs: number;
    onTelemetry?: (sample: Record<string, unknown>) => void;
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
              try { socket.send(JSON.stringify({ type: "subscribe", topics: ["telemetry"] })); }
              catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
            }
            resolve(); this.options.onReady(); return;
          }
          if (message.type === "telemetry") {
            this.options.onTelemetry?.(message);
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
    const rejectConnecting = this.connectingReject; this.connectingReject = null;
    rejectConnecting?.(error);
    this.failAll(error);
    try { socket?.close(1000, "client closed"); } catch { /* best effort */ }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
