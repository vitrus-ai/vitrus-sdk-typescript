import { expect, test } from "bun:test";
import { FredHaiseClient, type FredHaiseDiscovery } from "./fred-haise-client.js";

const discovery: FredHaiseDiscovery = {
  schema: "vitrus.physical-agent.service.v1",
  service: { id: "fred.physical-agent", role: "agent_runtime", host: "Fred Haise" },
  resources: [
    { id: "r06a", type: "robot", name: "Vitrus R06A", role: "physical_robot" },
    { id: "fred-haise", type: "agent_runtime", name: "Fred Haise", role: "planning_and_supervision_runtime" },
  ],
  capabilities: [
    { name: "trajectory.preview", method: "POST", path: "/api/v1/planTrajectory", effect: "compile_review_only" },
    { name: "task.start", method: "POST", path: "/api/v1/tasks", effect: "start_agent_task" },
    { name: "task.read", method: "GET", path: "/api/v1/tasks/current", effect: "read_agent_state" },
    { name: "plan.approve", method: "POST", path: "/api/v1/approvals", effect: "submit_existing_execution_validation" },
    { name: "service.capabilities", method: "GET", path: "/api/v1/capabilities", effect: "read_only" },
  ],
  authority: {
    robot_motion_owner: "Vitrus SDK and Edge safety authority",
    preview_executes_motion: false,
    approval_response_confirms_motion: false,
  },
};

test("Fred client discovers the robot and agent runtime as separate resources", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new FredHaiseClient({
    baseUrl: "http://127.0.0.1:8898/", csrf: "operator-session", origin: "http://127.0.0.1:8899",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const url = calls.at(-1)?.url ?? "";
      if (url.endsWith("/resources")) return Response.json(discovery.resources);
      if (url.endsWith("/capabilities")) return Response.json({ ...discovery, runtime: { phase: "idle", task_status: "idle", connected: false, model_sync_ready: false, pending_plan: null } });
      return Response.json(discovery);
    },
  });

  const result = await client.discovery();
  expect(result.resources.map(({ id, type }) => [id, type])).toEqual([
    ["r06a", "robot"], ["fred-haise", "agent_runtime"],
  ]);
  expect(result.authority).toMatchObject({ preview_executes_motion: false, approval_response_confirms_motion: false });
  expect(await client.capabilities()).toMatchObject({ service: discovery.service, runtime: { phase: "idle", connected: false } });
  expect(await client.resources()).toEqual(discovery.resources);
  expect(calls.map(({ url }) => url)).toEqual([
    "http://127.0.0.1:8898/api/v1", "http://127.0.0.1:8898/api/v1/capabilities", "http://127.0.0.1:8898/api/v1/resources",
  ]);
});

test("plan, task, status, and approval use the Fred contract and preserve review receipts", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new FredHaiseClient({
    baseUrl: "http://fred.local:8898", csrf: "csrf-secret", origin: "http://127.0.0.1:8899",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      switch (url.pathname) {
        case "/api/v1/planTrajectory": return Response.json({ schema: discovery.schema, status: "review_only", execution_started: false, physical_task_success_verified: false, plan: { id: "p1", hash: "h1", collision: { clear: true }, model_binding: { model_epoch: 3 }, observation: { captured_at: null, received_at: null, sha256: null } } });
        case "/api/v1/tasks": return Response.json({ schema: discovery.schema, status: "task_started", task_id: "t1", generation: 1, task_status: "observing", planning_started: true, motion_started: false, physical_task_success_verified: false }, { status: 202 });
        case "/api/v1/tasks/current": return Response.json({ schema: discovery.schema, task_id: "t1", task: "inspect", generation: 1, task_status: "observing", phase: "observing", decision: null, pending_plan: null, motion_command_accepted: false, physical_task_success_verified: false });
        case "/api/v1/approvals": return Response.json({ schema: discovery.schema, status: "submitted_for_validation", plan_id: "p1", plan_hash: "h1", validation_pending: true, motion_started: false, motion_command_accepted: false, physical_motion_verified: false, physical_task_success_verified: false }, { status: 202 });
        default: return Response.json({ error: "unexpected route" }, { status: 404 });
      }
    },
  });

  const target = { terminal: "LEFT_ARM_TCP" as const, position_m: [0.2, -0.1, 0.3] as [number, number, number], orientation_xyzw: [0, 0, 0, 1] as [number, number, number, number] };
  const preview = await client.planTrajectory(target);
  expect(preview).toMatchObject({ status: "review_only", execution_started: false, physical_task_success_verified: false, plan: { id: "p1", hash: "h1" } });
  expect(await client.startTask("inspect")).toMatchObject({ status: "task_started", motion_started: false });
  expect(await client.currentTask()).toMatchObject({ task_id: "t1", motion_command_accepted: false });
  expect(await client.approvePlan("p1", "h1")).toMatchObject({ status: "submitted_for_validation", plan_id: "p1", plan_hash: "h1", motion_started: false, motion_command_accepted: false });

  expect(calls.map(({ url }) => `${url.origin}${url.pathname}`)).toEqual([
    "http://fred.local:8898/api/v1/planTrajectory",
    "http://fred.local:8898/api/v1/tasks",
    "http://fred.local:8898/api/v1/tasks/current",
    "http://fred.local:8898/api/v1/approvals",
  ]);
  for (const { init } of calls.filter(({ init }) => init?.method === "POST")) {
    expect(init?.headers).toMatchObject({ origin: "http://127.0.0.1:8899", "x-agent-csrf": "csrf-secret", "content-type": "application/json" });
  }
  expect(JSON.parse(String(calls[0].init?.body))).toEqual(target);
  expect(JSON.parse(String(calls[1].init?.body))).toEqual({ task: "inspect" });
  expect(JSON.parse(String(calls[3].init?.body))).toEqual({ planId: "p1", planHash: "h1" });
  expect(calls.some(({ url }) => /motion|control|lease|stop/i.test(url.pathname))).toBe(false);
});

test("Fred client exposes structured HTTP failures", async () => {
  const client = new FredHaiseClient({
    baseUrl: "http://127.0.0.1:8898", csrf: "csrf", origin: "http://127.0.0.1:8899",
    fetch: async () => Response.json({ error: "No matching reviewable plan" }, { status: 409 }),
  });
  await expect(client.approvePlan("stale", "hash")).rejects.toMatchObject({
    name: "FredHaiseRequestError", status: 409, message: "No matching reviewable plan", payload: { error: "No matching reviewable plan" },
  });
});
