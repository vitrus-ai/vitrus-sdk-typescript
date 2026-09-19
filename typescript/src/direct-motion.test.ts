import { expect, test } from "bun:test";
import { Droid } from "./droid-live.js";
import { DirectMotionJobClient } from "./direct-motion.js";
import { MotionControlError } from "./motion-job.js";

const job = (state: "hold" | "active" = "hold") => ({
  job_id: "direct-job-1",
  epoch: 1,
  mode: "device_ik" as const,
  state,
  joint_names: ["LEFT_SHOULDER_A"],
  configuration_revision: "rev-1",
  last_sequence: state === "active" ? 1 : 0,
});

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

test("Droid.connect exposes native direct motion only through the public dataplane", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: URL; method: string; body: Record<string, unknown>; headers: Headers }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ url, method: init?.method ?? "GET", body, headers: new Headers(init?.headers) });
    if (url.pathname === "/v1/droids/resolve") {
      return response({ id: "droid-1", serialNumber: "VTRS-R06-2607-R2D2X", model: "r06", displayName: null, organizationId: "org-1", status: "online", enrollmentState: "enrolled" });
    }
    if (url.pathname === "/v1/droids/motion/direct/start") return response({ ok: true, job: { ...job(), auxiliary_joint_names: ["LEFT_SHOULDER_A"] }, initial_feedback: { fresh: true }, prime_receipt: { accepted: 1 } });
    if (url.pathname === "/v1/droids/motion/direct/update") {
      const payload = body.payload as Record<string, unknown>;
      return response({ ok: true, job: job(payload.operation === "hold" ? "hold" : "active"), result: { accepted: true, command_id: 7 } });
    }
    if (url.pathname === "/v1/droids/motion/direct/heartbeat") return response({ ok: true, job: job("active") });
    if (url.pathname === "/v1/droids/motion/direct/execution") return response({ ok: true, execution: { feedback_fresh: true } });
    if (url.pathname === "/v1/droids/motion/direct/feedback") return response({ ok: true, motors: [] });
    if (url.pathname === "/v1/droids/motion/direct/stop") return response({ ok: true, stopped: true, job: { ...job("active"), state: "stopped" } });
    return response({ ok: false, error: `unexpected ${url.pathname}`, code: "UNEXPECTED", domain: "test", retryable: false }, 500);
  }) as typeof fetch;
  try {
    const droid = await Droid.connect("VTRS-R06-2607-R2D2X", { apiKey: "test-api-key" });
    const started = await droid.motion.direct.startWithReceipt({
      mode: "device_ik", owner: "mac-test", jointNames: ["LEFT_SHOULDER_A"],
      auxiliaryJointNames: ["LEFT_SHOULDER_A"], intentMode: "continuous_setpoint", targetLivenessMs: 3_000,
      takeOver: true,
    });
    expect(started.initialFeedback).toEqual({ fresh: true });
    expect(started.primeReceipt).toEqual({ accepted: 1 });
    const session = started.session;
    expect(session.state).toBe("hold");
    await session.updateDeviceIkFrame({
      controlledChains: ["left_arm"],
      targets: [{ chain: "left_arm", points: [{ position_m: [0.1, 0.2, 0.3], orientation_xyzw: [0, 0, 0, 1], time_from_start_ms: 20 }] }],
      auxiliaryJointTargets: [{ joint_name: "LEFT_SHOULDER_A", position_deg: 1.5 }],
      clientCreatedAtMs: 1,
    });
    expect(session.state).toBe("active");
    await session.hold();
    expect(session.state).toBe("hold");
    await session.parkJointTargets({
      targets: [{ joint_name: "LEFT_SHOULDER_A", position_deg: 1.5 }],
      maxVelocityDegS: 5,
      toleranceDeg: 2,
    });
    expect((await droid.motion.direct.execution()).execution).toEqual({ feedback_fresh: true });
    expect((await droid.motion.direct.feedback()).motors).toEqual([]);
    await session.heartbeat({ timeoutMs: 500 });
    await session.stop();
    await session.stop();

    const direct = requests.filter(({ url }) => url.pathname.startsWith("/v1/droids/motion/direct/"));
    expect(direct.map(({ url }) => url.pathname)).toEqual([
      "/v1/droids/motion/direct/start",
      "/v1/droids/motion/direct/update",
      "/v1/droids/motion/direct/update",
      "/v1/droids/motion/direct/update",
      "/v1/droids/motion/direct/execution",
      "/v1/droids/motion/direct/feedback",
      "/v1/droids/motion/direct/heartbeat",
      "/v1/droids/motion/direct/stop",
    ]);
    for (const request of direct) {
      expect(request.url.origin).toBe("https://vitrus-dataplane.onrender.com");
      expect(request.url.searchParams.get("ref")).toBe("VTRS-R06-2607-R2D2X");
      expect(request.headers.get("authorization")).toBe("Bearer test-api-key");
      expect(request.method).toBe("POST");
      expect(request.body.request_id).toEqual(expect.any(String));
      expect(request.body.timeout_ms).toEqual(expect.any(Number));
      expect(JSON.stringify(request.body.payload)).not.toContain("lease_id");
      expect(JSON.stringify(request)).not.toContain("edgeEndpoint");
      expect(JSON.stringify(request.url)).not.toContain("127.0.0.1");
    }
    const startPayload = requests.find(({ url }) => url.pathname.endsWith("/start"))!.body.payload as Record<string, unknown>;
    expect(startPayload).toEqual({
      mode: "device_ik", owner: "mac-test", joint_names: ["LEFT_SHOULDER_A"],
      take_over: true, auxiliary_joint_names: ["LEFT_SHOULDER_A"],
      intent_mode: "continuous_setpoint", target_liveness_ms: 3_000,
    });
    const updatePayload = requests.find(({ url }) => url.pathname.endsWith("/update"))!.body.payload as Record<string, unknown>;
    expect(updatePayload).toMatchObject({ job_id: "direct-job-1", epoch: 1, sequence: 1, controlled_chains: ["left_arm"] });
    expect(updatePayload.chain_targets).toEqual([{ chain: "left_arm", points: [{ position_m: [0.1, 0.2, 0.3], orientation_xyzw: [0, 0, 0, 1], time_from_start_ms: 20 }] }]);
    expect(updatePayload.client_created_at_ms).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("direct start preserves an explicit empty auxiliary scope for an 18-joint canary", async () => {
  const jointNames = Array.from({ length: 18 }, (_, index) => `JOINT_${index + 1}`);
  let startPayload: Record<string, unknown> | undefined;
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.onrender.com",
    apiKey: "test-api-key",
    ref: "VTRS-R06-2607-R2D2X",
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1/droids/motion/direct/start");
      startPayload = (JSON.parse(String(init?.body)) as { payload: Record<string, unknown> }).payload;
      return response({ ok: true, job: {
        job_id: "arm-neck-18", epoch: 1, mode: "device_ik", state: "hold",
        joint_names: jointNames, auxiliary_joint_names: [], configuration_revision: "rev-1", last_sequence: 0,
      }, initial_feedback: { motors: [] }, prime_receipt: { accepted: true } });
    }) as typeof fetch,
  });
  const started = await client.startWithReceipt({
    mode: "device_ik", owner: "public-arm-canary", jointNames, auxiliaryJointNames: [], configurationRevision: "rev-1",
  });
  expect(started.session.id).toBe("arm-neck-18");
  expect(started.session.jointNames).toEqual(jointNames);
  expect(started.session.auxiliaryJointNames).toEqual([]);
  expect(startPayload).toMatchObject({ joint_names: jointNames, auxiliary_joint_names: [] });
});

test("opt-in latest-only frames coalesce locally and preserve monotonic public sequence", async () => {
  const paths: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const observations: Array<{ inputSequence: number | null; state: string; sentAtMs: number; observedAtMs: number }> = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06", latestOnlyUpdates: true,
    onLatestUpdate: (observation) => observations.push(observation),
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.pathname.endsWith("/start")) return response({ ok: true, job: job() });
      if (url.pathname.endsWith("/latest")) return response({ ok: true, job: job(), result: { state: "queued" } }, 202);
      return response({ ok: true, job: job("active") });
    }) as typeof fetch,
  });
  const session = await client.startJob({ mode: "device_ik", owner: "test", jointNames: ["LEFT_SHOULDER_A"] });
  const frame = (x: number) => session.updateDeviceIkFrame({ controlledChains: ["left_arm"], targets: [{ chain: "left_arm", points: [{ position_m: [x, 0, 0] }] }] });
  await frame(0.1);
  await frame(0.2);
  await client.drainLatestUpdates();
  expect(paths).toEqual(["/v1/droids/motion/direct/start", "/v1/droids/motion/direct/latest", "/v1/droids/motion/direct/latest"]);
  expect(observations.some((observation) => observation.state === "queued" && observation.inputSequence === 2 && observation.observedAtMs >= observation.sentAtMs)).toBe(true);
  expect(client.latestUpdateStatus()).toMatchObject({ state: "queued", inputSequence: 2 });
});

test("latest desired-state admission exposes the normalized receipt name and retains a legacy alias", () => {
  const client = new DirectMotionJobClient({ endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06", latestOnlyUpdates: true,
    fetch: (async () => response({ ok: true })) as typeof fetch,
  });
  const admission = client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 7, controlled_chains: ["left_arm"], chain_targets: [{ chain: "left_arm", points: [{ position_m: [0, 0, 0] }] }] });
  expect(admission).toEqual({ state: "queued", input_sequence: 7, delivery: "desired_state_accepted", legacy_delivery: "latest_only_sdk_mailbox", desired_state_key: "device_ik:job:left_arm" });
  client.discardLatestUpdates();
});

test("an older Bridge receipt is normalized as desired-state admission without rewriting its raw provenance", async () => {
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06", latestOnlyUpdates: true,
    fetch: (async () => response({
      ok: true, trace_id: "bridge-trace-7",
      result: { state: "queued", request_id: "bridge-request-7", delivery: "latest_only_public_mailbox" },
    }, 202)) as typeof fetch,
  });
  client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 7, controlled_chains: ["left_arm"], chain_targets: [{ chain: "left_arm", points: [{ position_m: [0, 0, 0] }] }] });
  await client.drainLatestUpdates();
  expect(client.latestUpdateStatus()).toMatchObject({
    state: "queued", inputSequence: 7, delivery: "desired_state_accepted",
    legacyDelivery: "latest_only_public_mailbox", desiredStateKey: "device_ik:job:left_arm", traceId: "bridge-trace-7",
    receipt: { result: { delivery: "latest_only_public_mailbox" } },
  });
});

test("an ambiguous latest receipt remains observable without making drain fail", async () => {
  const client = new DirectMotionJobClient({ endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06", latestOnlyUpdates: true,
    fetch: (async () => { throw new TypeError("network interrupted after send"); }) as typeof fetch,
  });
  client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 7, controlled_chains: ["left_arm"], chain_targets: [{ chain: "left_arm", points: [{ position_m: [0, 0, 0] }] }] });
  await client.drainLatestUpdates();
  expect(client.latestUpdateStatus()).toMatchObject({ state: "receipt_unknown", inputSequence: 7, error: expect.stringContaining("network interrupted") });
});

test("safety stop drops an unsent latest frame before its public lifecycle request", async () => {
  const paths: string[] = [];
  let resolveLatest!: (response: Response) => void;
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06", latestOnlyUpdates: true,
    fetch: ((input) => {
      const url = new URL(String(input)); paths.push(url.pathname);
      if (url.pathname.endsWith("/latest")) return new Promise<Response>((resolve) => { resolveLatest = resolve; });
      return Promise.resolve(response({ ok: true, stopped: true }));
    }) as typeof fetch,
  });
  client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 1 });
  client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 2 });
  await client.safetyStop();
  resolveLatest(response({ ok: true }));
  await client.drainLatestUpdates();
  expect(paths).toEqual(["/v1/droids/motion/direct/latest", "/v1/droids/motion/direct/safety-stop"]);
});

test("a local latest frame expires behind a stalled public request and is never posted", async () => {
  const paths: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const observations: Array<{ inputSequence: number | null; state: string; error?: string }> = [];
  let now = 1_000, resolveFirst!: (response: Response) => void;
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06", latestOnlyUpdates: true,
    latestPendingMaxAgeMs: 500, now: () => now,
    onLatestUpdate: (observation) => observations.push(observation),
    fetch: ((input, init) => {
      paths.push(new URL(String(input)).pathname);
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Promise<Response>((resolve) => { resolveFirst = resolve; });
    }) as typeof fetch,
  });
  client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 1 });
  client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 2 });
  now += 501;
  resolveFirst(response({ ok: true }));
  await client.drainLatestUpdates();
  expect(paths).toEqual(["/v1/droids/motion/direct/latest"]);
  expect((bodies[0].payload as Record<string, unknown>).client_created_at_ms).toBe(1_000);
  expect(observations.at(-1)).toMatchObject({ inputSequence: 2, state: "failed", error: expect.stringContaining("expired locally") });
});

test("direct motion rejects arbitrary local paths and preserves typed public failures", async () => {
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.onrender.com",
    apiKey: "test-api-key",
    ref: "VTRS-R06-2607-R2D2X",
    fetch: (async () => response({ ok: false, error: "Edge result timed out", code: "MOTION_REQUEST_TIMEOUT", domain: "transport", retryable: true }, 504)) as typeof fetch,
  });
  await expect(client.request("/api/not-an-edge-proxy", undefined, "GET")).rejects.toThrow("does not proxy local route");
  await expect(client.status()).rejects.toBeInstanceOf(MotionControlError);
  await client.status().catch((error: unknown) => {
    expect(error).toBeInstanceOf(MotionControlError);
    expect((error as MotionControlError).status).toBe(504);
    expect((error as MotionControlError).payload.code).toBe("MOTION_REQUEST_TIMEOUT");
  });
});

test("ambiguous public mutations are never advertised as retryable", async () => {
  for (const mode of ["edge-timeout", "connection-loss"] as const) {
    let calls = 0;
    const client = new DirectMotionJobClient({ endpoint: "https://vitrus-dataplane.onrender.com", apiKey: "test-api-key", ref: "R06", fetch: (async () => {
      calls++;
      if (mode === "connection-loss") throw new TypeError("socket closed after request");
      return response({ ok: false, error: "direct_motion_application_unknown", request_id: "correlation" }, 504);
    }) as typeof fetch });
    await client.request("/api/v2/motion/update", { job_id: "job", epoch: 1, sequence: 2 }).then(() => { throw Error("expected failure"); }, (error: MotionControlError) => {
      expect(error.payload.code).toBe("MOTION_APPLICATION_UNKNOWN");
      expect(error.payload.retryable).toBe(false);
      if (mode === "edge-timeout") expect(error.payload.error).toBe("direct_motion_application_unknown");
    });
    expect(calls).toBe(1);
  }
});

test("ambiguous start reconciles the retained result with the same request id", async () => {
  let calls = 0;
  const requestIds: string[] = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.onrender.com", apiKey: "test-api-key", ref: "R06",
    fetch: (async (_input, init) => {
      calls += 1;
      const envelope = JSON.parse(String(init?.body)) as { request_id: string };
      requestIds.push(envelope.request_id);
      if (calls === 1) return response({ ok: false, error: "direct_motion_application_unknown", request_id: envelope.request_id }, 504);
      return response({ ok: true, job: job("hold"), initial_feedback: { fresh: true }, prime_receipt: { accepted: 1 } });
    }) as typeof fetch,
  });
  const started = await client.startWithReceipt({ mode: "device_ik", owner: "sdk-control", jointNames: ["LEFT_SHOULDER_A"] });
  expect(started.session.id).toBe("direct-job-1");
  expect(calls).toBe(2);
  expect(requestIds[0]).toBe(requestIds[1]);
});

test("definite native direct-control rejections preserve the native code and message", async () => {
  let calls = 0;
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.onrender.com",
    apiKey: "test-api-key",
    ref: "R06",
    fetch: (async () => {
      calls++;
      return response({
        ok: false,
        error: "invalid_direct_control_request",
        message: "first target must contain a non-empty chain_targets list",
      }, 422);
    }) as typeof fetch,
  });
  await client.request("/api/v2/motion/update", { job_id: "job", epoch: 1, sequence: 2 }).then(
    () => { throw Error("expected native validation rejection"); },
    (error: unknown) => {
      expect(error).toBeInstanceOf(MotionControlError);
      const typed = error as MotionControlError;
      expect(typed.status).toBe(422);
      expect(typed.payload).toMatchObject({
        code: "invalid_direct_control_request",
        error: "first target must contain a non-empty chain_targets list",
        domain: "transport",
        retryable: false,
      });
      expect(typed.message).toBe("invalid_direct_control_request: first target must contain a non-empty chain_targets list");
    },
  );
  expect(calls).toBe(1);
});

test("a read response whose body aborts at the SDK deadline is a request timeout, not invalid JSON", async () => {
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06", requestTimeoutMs: 5,
    fetch: ((_input, init) => Promise.resolve({
      ok: true, status: 200, statusText: "OK",
      json: () => new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("deadline", "AbortError")), { once: true });
      }),
    } as Response)) as typeof fetch,
  });
  await client.status().then(
    () => { throw new Error("expected a timeout"); },
    (error: unknown) => {
      expect(error).toBeInstanceOf(MotionControlError);
      const typed = error as MotionControlError;
      expect(typed.status).toBe(504);
      expect(typed.payload.code).toBe("MOTION_REQUEST_TIMEOUT");
    },
  );
});

test("a successful heartbeat intentionally resolves void", async () => {
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06",
    fetch: (async (_input, init) => {
      const operation = new URL(String(_input)).pathname;
      if (operation.endsWith("/start")) return response({ ok: true, job: job() });
      if (operation.endsWith("/heartbeat")) return response({ ok: true, job: job("active") });
      throw new Error(`unexpected ${operation} ${String(init?.method)}`);
    }) as typeof fetch,
  });
  const session = await client.startJob({ mode: "device_ik", owner: "test", jointNames: ["LEFT_SHOULDER_A"] });
  await expect(session.heartbeat()).resolves.toBeUndefined();
});

test("variable continuous tolerance keeps the original source timestamp, bounds the Bridge deadline, and drops expired jitter", async () => {
  let now = 10_000;
  const envelopes: Array<{ timeout_ms: number; payload: Record<string, unknown> }> = [];
  const updates: Array<{ inputSequence: number | null; state: string; error?: string }> = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06",
    latestOnlyUpdates: true, continuousNetworkTolerance: { sourceMaxAgeMs: 1_200 }, now: () => now,
    onLatestUpdate: observation => updates.push(observation),
    fetch: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/start")) return response({ ok: true, job: { ...job(), intent_mode: "continuous_setpoint" } });
      if (path.endsWith("/latest")) {
        envelopes.push(JSON.parse(String(init?.body)) as { timeout_ms: number; payload: Record<string, unknown> });
        return response({ ok: true, result: { state: "queued" } });
      }
      throw new Error(`unexpected ${path}`);
    }) as typeof fetch,
  });
  const session = await client.startJob({ mode: "device_ik", owner: "test", jointNames: ["LEFT_SHOULDER_A"], intentMode: "continuous_setpoint" });
  await session.updateDeviceIkFrame({
    controlledChains: ["LEFT_ARM"], targets: [{ chain: "LEFT_ARM", points: [{ position_m: [0, 0, 0] }] }], clientCreatedAtMs: 10_000,
  });
  await client.drainLatestUpdates();
  expect(envelopes).toEqual([expect.objectContaining({ timeout_ms: 1_200, payload: expect.objectContaining({ sequence: 1, client_created_at_ms: 10_000, source_max_age_ms: 1_200 }) })]);

  // A delayed input keeps its old timestamp and is observed as failed locally;
  // it is never transmitted as a reconnected/retried setpoint.
  now = 11_201;
  await session.updateDeviceIkFrame({
    controlledChains: ["LEFT_ARM"], targets: [{ chain: "LEFT_ARM", points: [{ position_m: [0.1, 0, 0] }] }], clientCreatedAtMs: 10_000,
  });
  await client.drainLatestUpdates();
  expect(envelopes).toHaveLength(1);
  expect(updates.at(-1)).toMatchObject({ inputSequence: 2, state: "failed", error: expect.stringContaining("expired locally") });
});

test("realtime tolerance cannot quietly extend a latest frame's local queue age", () => {
  expect(() => new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06",
    latestOnlyUpdates: true, latestPendingMaxAgeMs: 501,
  })).toThrow("[1, 500]");
  expect(() => new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06",
    continuousNetworkTolerance: { sourceMaxAgeMs: 2_001 },
  })).toThrow("501 through 2000");
  const variable = new DirectMotionJobClient({ endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06", continuousNetworkTolerance: "variable" });
  expect(variable.continuousNetworkTolerance).toEqual({ sourceMaxAgeMs: 1_500 });
});

test("latest-only routing is limited to continuous device-IK frames; Hold remains correlated", async () => {
  const paths: string[] = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06", latestOnlyUpdates: true,
    fetch: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      const payload = (JSON.parse(String(init?.body)) as { payload: Record<string, unknown> }).payload;
      if (path.endsWith("/start")) return response({ ok: true, job: job() });
      if (path.endsWith("/latest")) {
        expect(payload.client_created_at_ms).toEqual(expect.any(Number));
        expect(payload.chain_targets).toEqual(expect.any(Array));
        return response({ ok: true, job: job("active"), result: { state: "queued" } }, 202);
      }
      expect(path).toBe("/v1/droids/motion/direct/update");
      expect(payload.operation).toBe("hold");
      expect(payload.client_created_at_ms).toBeUndefined();
      return response({ ok: true, job: job(), result: { held: true } });
    }) as typeof fetch,
  });
  const session = await client.startJob({ mode: "device_ik", owner: "test", jointNames: ["LEFT_SHOULDER_A"] });
  await session.updateDeviceIkFrame({
    controlledChains: ["left_arm"],
    targets: [{ chain: "left_arm", points: [{ position_m: [0.1, 0.2, 0.3] }] }],
  });
  await client.drainLatestUpdates();
  await expect(session.hold()).resolves.toEqual({ held: true });
  expect(paths).toEqual([
    "/v1/droids/motion/direct/start",
    "/v1/droids/motion/direct/latest",
    "/v1/droids/motion/direct/update",
  ]);
});

test("confirmed frame delivery bypasses latest routing while retaining latest capability", async () => {
  const paths: string[] = [];
  const envelopes: Array<Record<string, unknown>> = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06", latestOnlyUpdates: true,
    fetch: (async (input, init) => {
      const url = new URL(String(input)); paths.push(url.pathname);
      const envelope = JSON.parse(String(init?.body)) as Record<string, unknown>; envelopes.push(envelope);
      if (url.pathname.endsWith("/start")) return response({ ok: true, job: job() });
      if (url.pathname.endsWith("/update")) return response({ ok: true, job: job("active"), result: { accepted: true, command_id: 77 } });
      return response({ ok: false, error: `unexpected ${url.pathname}` }, 500);
    }) as typeof fetch,
  });
  expect(client.supportsLatestUpdates).toBe(true);
  const session = await client.startJob({ mode: "device_ik", owner: "confirmed-test", jointNames: ["NECK_A"] });
  await expect(session.updateDeviceIkFrame({
    controlledChains: ["NECK"],
    targets: [{ chain: "NECK", points: [{ position_m: [0, 0, 0], orientation_xyzw: [0, 0, 0, 1] }] }],
    clientCreatedAtMs: 1_000,
    delivery: "confirmed",
  })).resolves.toEqual({ accepted: true, command_id: 77, clientInputSequence: 1 });
  expect(paths).toEqual(["/v1/droids/motion/direct/start", "/v1/droids/motion/direct/update"]);
  expect(envelopes[1]).toMatchObject({ payload: { sequence: 1, controlled_chains: ["NECK"], client_created_at_ms: 1_000 } });
});
