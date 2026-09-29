/** Typed caller for the Fred Haise planning and supervision runtime. */

export const FRED_HAISE_SERVICE_SCHEMA = "vitrus.physical-agent.service.v1" as const;

export type FredHaiseTcpTrajectoryRequest = {
  terminal: "NECK_TCP" | "LEFT_ARM_TCP" | "RIGHT_ARM_TCP";
  position_m: [number, number, number];
  orientation_xyzw: [number, number, number, number];
};

export type FredHaiseRobotResource = {
  id: "r06a";
  type: "robot";
  name: "Vitrus R06A";
  role: "physical_robot";
};

export type FredHaiseAgentResource = {
  id: "fred-haise";
  type: "agent_runtime";
  name: "Fred Haise";
  role: "planning_and_supervision_runtime";
};

export type FredHaiseResource = FredHaiseRobotResource | FredHaiseAgentResource;

export type FredHaiseDiscovery = {
  schema: typeof FRED_HAISE_SERVICE_SCHEMA;
  service: { id: "fred.physical-agent"; role: "agent_runtime"; host: "Fred Haise" };
  resources: [FredHaiseRobotResource, FredHaiseAgentResource];
  capabilities: Array<{ name: string; method: "GET" | "POST"; path: string; effect: string }>;
  authority: {
    robot_motion_owner: "Vitrus SDK and Edge safety authority";
    preview_executes_motion: false;
    approval_response_confirms_motion: false;
  };
};

export type FredHaisePlanReceipt = {
  schema: typeof FRED_HAISE_SERVICE_SCHEMA;
  status: "review_only";
  execution_started: false;
  physical_task_success_verified: false;
  plan: {
    id: string;
    hash: string;
    collision: unknown;
    model_binding: unknown;
    observation: { captured_at: string | null; received_at: number | null; sha256: string | null };
  };
};

export type FredHaiseApprovalReceipt = {
  schema: typeof FRED_HAISE_SERVICE_SCHEMA;
  status: "submitted_for_validation";
  plan_id: string;
  plan_hash: string;
  validation_pending: true;
  motion_started: false;
  motion_command_accepted: false;
  physical_motion_verified: false;
  physical_task_success_verified: false;
};

export type FredHaiseTaskReceipt = {
  schema: typeof FRED_HAISE_SERVICE_SCHEMA;
  status: "task_started";
  task_id: string | null;
  generation: number;
  task_status: string;
  planning_started: true;
  motion_started: false;
  physical_task_success_verified: false;
};

export type FredHaiseTaskSnapshot = {
  schema: typeof FRED_HAISE_SERVICE_SCHEMA;
  task_id: string | null;
  task: string;
  generation: number;
  task_status: string;
  phase: string;
  decision: unknown;
  pending_plan: null | {
    id: string;
    hash: string;
    model_binding: unknown;
    review_only: boolean;
    approval_submitted: boolean;
    consumed: boolean;
  };
  motion_command_accepted: boolean;
  physical_task_success_verified: false;
};

export type FredHaiseCapabilities = FredHaiseDiscovery & {
  runtime: {
    phase: string;
    task_status: string;
    connected: boolean;
    model_sync_ready: boolean;
    pending_plan: null | { id: string; hash: string; review_only: boolean; approval_submitted: boolean };
  };
};

export class FredHaiseRequestError extends Error {
  constructor(message: string, readonly status: number, readonly payload: unknown) {
    super(message);
    this.name = "FredHaiseRequestError";
  }
}

export type FredHaiseClientOptions = {
  /** Fred's local physical-agent service origin, commonly http://127.0.0.1:8898. */
  baseUrl: string;
  /** Operator-session CSRF token provided by Fred's state endpoint. */
  csrf: string;
  /** Exact allowed browser or proxy origin configured on Fred. */
  origin: string;
  fetch?: typeof globalThis.fetch;
};

/**
 * Reads and submits planning requests to Fred. This client has no robot motion
 * methods: physical control and its safety checks remain in Vitrus SDK/Edge.
 */
export class FredHaiseClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: FredHaiseClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (!this.baseUrl) throw new Error("Fred Haise service baseUrl is required");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.csrf = options.csrf;
    this.origin = options.origin;
  }

  private readonly csrf: string;
  private readonly origin: string;

  discovery(): Promise<FredHaiseDiscovery> {
    return this.request("/api/v1", { method: "GET" });
  }

  capabilities(): Promise<FredHaiseCapabilities> {
    return this.request("/api/v1/capabilities", { method: "GET" });
  }

  resources(): Promise<FredHaiseDiscovery["resources"]> {
    return this.request("/api/v1/resources", { method: "GET" });
  }

  /** Compiles a review-only TCP plan. This does not submit approval or execute motion. */
  planTrajectory(target: FredHaiseTcpTrajectoryRequest): Promise<FredHaisePlanReceipt> {
    return this.request("/api/v1/planTrajectory", { method: "POST", body: target });
  }

  /** Starts Fred's planning task; the returned receipt does not claim robot motion. */
  startTask(task: string): Promise<FredHaiseTaskReceipt> {
    return this.request("/api/v1/tasks", { method: "POST", body: { task } });
  }

  currentTask(): Promise<FredHaiseTaskSnapshot> {
    return this.request("/api/v1/tasks/current", { method: "GET" });
  }

  /** Submits a specific reviewed plan for validation; the receipt is not motion acceptance. */
  approvePlan(planId: string, planHash: string): Promise<FredHaiseApprovalReceipt> {
    return this.request("/api/v1/approvals", { method: "POST", body: { planId, planHash } });
  }

  private async request<T>(path: string, request: { method: "GET" | "POST"; body?: unknown }): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: request.method,
      headers: request.method === "POST" ? {
        accept: "application/json",
        "content-type": "application/json",
        // Browsers supply Origin themselves and forbid setting it from JavaScript.
        ...(typeof window === "undefined" ? { origin: this.origin } : {}),
        "x-agent-csrf": this.csrf,
      } : { accept: "application/json" },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const detail = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).error
        : undefined;
      throw new FredHaiseRequestError(
        typeof detail === "string" ? detail : `Fred Haise request failed with HTTP ${response.status}`,
        response.status,
        payload,
      );
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("Fred Haise service returned invalid JSON");
    }
    return payload as T;
  }
}
