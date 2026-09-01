export type JointStopCalibrationStartOptions = {
  joint: string;
  /** Defaults to true. Physical execution must always be explicit. */
  dryRun?: boolean;
  autoCommit?: boolean;
  /** Optional opaque correlation owned by Clay or another recorder. */
  evidenceSessionId?: string;
};

export type JointStopCalibrationRun = {
  ok: boolean;
  runId: string;
  run_id?: string;
  joint: string;
  state: string;
  dryRun: boolean;
  auto_commit?: boolean;
  persisted?: boolean;
  error?: { code?: string; detail?: string } | null;
  [key: string]: unknown;
};

export type JointStopCalibrationClientOptions = {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  pollIntervalMs?: number;
};

const TERMINAL_STATES = new Set(["eligible", "failed", "cancelled", "committed"]);

export class JointStopCalibrationClient {
  private readonly baseUrl: string;
  private readonly requestFetch: typeof globalThis.fetch;
  private readonly pollIntervalMs: number;

  constructor(options: JointStopCalibrationClientOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    if (!this.baseUrl) throw new Error("JointStopCalibrationClient requires baseUrl");
    const requestFetch = options.fetch ?? globalThis.fetch;
    if (typeof requestFetch !== "function") throw new Error("JointStopCalibrationClient requires fetch");
    this.requestFetch = requestFetch.bind(globalThis);
    this.pollIntervalMs = Math.max(50, Math.trunc(options.pollIntervalMs ?? 250));
  }

  async start(options: JointStopCalibrationStartOptions): Promise<JointStopCalibrationRun> {
    const joint = options.joint.trim();
    if (!joint) throw new Error("joint is required");
    const dryRun = options.dryRun !== false;
    return this.request("POST", "/api/calibration/joint-stop/auto", {
      joint,
      dry_run: dryRun,
      auto_commit: options.autoCommit ?? !dryRun,
      ...(options.evidenceSessionId?.trim()
        ? { evidence_session_id: options.evidenceSessionId.trim() }
        : {}),
    });
  }

  async status(): Promise<{ ok: boolean; active: JointStopCalibrationRun | null; [key: string]: unknown }> {
    return this.request("GET", "/api/calibration/joint-stop/status");
  }

  async cancel(runId?: string): Promise<Record<string, unknown>> {
    return this.request("POST", "/api/calibration/joint-stop/cancel", runId ? { runId } : {});
  }

  async wait(runId: string, timeoutMs = 15 * 60_000): Promise<JointStopCalibrationRun> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (Date.now() < deadline) {
      const snapshot = await this.status();
      const run = snapshot.active;
      if (!run || (run.runId !== runId && run.run_id !== runId)) {
        throw new Error(`Joint-stop run ${runId} is no longer active`);
      }
      if (TERMINAL_STATES.has(String(run.state))) return run;
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new Error(`Joint-stop run ${runId} timed out`);
  }

  async autoCalibrateJoint(
    options: JointStopCalibrationStartOptions & { wait?: boolean; timeoutMs?: number },
  ): Promise<JointStopCalibrationRun> {
    const run = await this.start(options);
    if (options.wait === false || TERMINAL_STATES.has(String(run.state))) return run;
    return this.wait(run.runId ?? run.run_id ?? "", options.timeoutMs);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.requestFetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json() as T & { error?: unknown };
    if (!response.ok) {
      const detail = typeof payload?.error === "string" ? payload.error : JSON.stringify(payload);
      throw new Error(`VitrusOS joint-stop request failed (${response.status}): ${detail}`);
    }
    return payload;
  }
}
