import { Droid, GoldenEdgeClient, type DeviceStatus, type DroidCommandResult } from "../src/index.ts";

type Json = Record<string, unknown>;

const DROID_REF = process.env.VITRUS_DROID_REF?.trim() || "VTRS-R06-2607-R2D2X";
const API_KEY = process.env.VITRUS_API_KEY?.trim();
const BRIDGE_ENDPOINT = process.env.VITRUS_DATAPLANE_URL?.trim() || "https://vitrus-dataplane.onrender.com";
const EDGE_ENDPOINT = process.env.VITRUS_EDGE_ENDPOINT?.trim() || "http://127.0.0.1:18782";
const BROKER_ENDPOINT = process.env.VITRUS_BROKER_ENDPOINT?.trim() || "http://127.0.0.1:18775";
const EXECUTE = process.argv.includes("--execute");
const CONFIRMATION = "workspace-clear-estop-reachable:LEFT_WRIST_B,NECK_HEAD";

const PERIOD_MS = 100;
const TTL_MS = 400;
const COMMAND_PROOF_TIMEOUT_MS = 180;
const FEEDBACK_MAX_AGE_MS = 150;
const RETURN_TOLERANCE_DEG = 0.35;
const LIMIT_MARGIN_DEG = 2;
const LEASE_DURATION_MS = 20_000;

const JOINTS = [
  { name: "LEFT_WRIST_B", amplitudeDeg: 0.5, maxVelocityDegS: 2, maxAbsVelocityDegS: 15, maxAbsTorqueNm: 1.5 },
  { name: "NECK_HEAD", amplitudeDeg: 0.5, maxVelocityDegS: 2, maxAbsVelocityDegS: 10, maxAbsTorqueNm: 0.8 },
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function finite(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not finite`);
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonRequest(url: string, init?: RequestInit, timeoutMs = 3_000): Promise<Json> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const payload = record(await response.json().catch(() => null));
    if (!response.ok || payload.ok === false) {
      throw new Error(`${url} failed (${response.status}): ${String(payload.error ?? response.statusText)}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function motors(payload: Json): Json[] {
  return Array.isArray(payload.motors) ? payload.motors.map(record) : [];
}

function motor(payload: Json, jointName: string): Json {
  const found = motors(payload).find((row) => row.joint_name === jointName);
  if (!found) throw new Error(`${jointName} is missing from broker telemetry`);
  return found;
}

function assertSdkSafety(status: DeviceStatus): void {
  assert(status.device_id.length > 0 && status.model === "R06", "SDK resolved a device other than R06");
  assert(status.safety.state === "safe", `SDK safety is ${status.safety.state}, expected safe`);
  assert(status.safety.estop === false, "E-stop is active");
  assert(status.control.mode === "read_only" && status.control.lease_id === null, "SDK status is not read_only without a lease");
  assert(status.telemetry.complete && !status.telemetry.stale, "SDK telemetry is incomplete or stale");
  assert(status.robot.available_joint_count === status.robot.joint_count, "not all configured joints are available");
}

function assertReadOnly(state: Json): void {
  assert(state.access_mode === "read_only", `broker access mode is ${String(state.access_mode)}`);
  assert(state.control_phase === "read_only", `broker phase is ${String(state.control_phase)}`);
  assert(state.global_control === "stop", `broker global control is ${String(state.global_control)}`);
  assert(state.exclusive_lease_id == null, `unexpected lease ${String(state.exclusive_lease_id)}`);
}

function assertMotorReady(row: Json, joint: typeof JOINTS[number]): void {
  assert(row.connected === true, `${joint.name} is disconnected`);
  assert(row.calibrated === true, `${joint.name} is not calibrated`);
  assert(row.stale !== true, `${joint.name} feedback is stale`);
  assert(!row.fault, `${joint.name} fault: ${String(row.fault)}`);
  assert(row.clay_can_control === true, `${joint.name} is not controllable: ${String(row.clay_unavailable_reason ?? "unknown")}`);
  const feedbackAgeMs = finite(row.feedback_age_ms, `${joint.name}.feedback_age_ms`);
  assert(feedbackAgeMs <= FEEDBACK_MAX_AGE_MS, `${joint.name} feedback is ${feedbackAgeMs.toFixed(1)} ms old`);
  const velocity = Math.abs(finite(row.velocity_deg_s ?? row.vel_dps, `${joint.name}.velocity_deg_s`));
  const torque = Math.abs(finite(row.torque_nm ?? row.tau, `${joint.name}.torque_nm`));
  assert(velocity <= joint.maxAbsVelocityDegS, `${joint.name} velocity ${velocity.toFixed(2)} deg/s exceeds the HIL gate`);
  assert(torque <= joint.maxAbsTorqueNm, `${joint.name} torque ${torque.toFixed(3)} Nm exceeds the HIL gate`);
}

async function brokerStatus(jointName?: string): Promise<Json> {
  const query = new URLSearchParams({ fast: "1" });
  if (jointName) {
    query.set("preflight_joints", jointName);
    query.set("driver_readback_joints", jointName);
  }
  return jsonRequest(`${BROKER_ENDPOINT}/api/motor-bridge/status?${query}`, undefined, jointName ? 15_000 : 3_000);
}

async function realtimeState(): Promise<Json> {
  return jsonRequest(`${BROKER_ENDPOINT}/api/motor-bridge/realtime-state`, undefined, 500);
}

function originSequence(admission: DroidCommandResult): number {
  const result = record(admission.result);
  const value = Number(result.sdkSequence ?? result.sequence ?? admission.requestId);
  assert(Number.isSafeInteger(value) && value > 0, "SDK admission did not preserve a valid origin sequence");
  return value;
}

async function waitForCommandProof(leaseId: string, expectedOrigin: number): Promise<Map<string, Json>> {
  const deadline = performance.now() + COMMAND_PROOF_TIMEOUT_MS;
  let lastRows: Json[] = [];
  while (performance.now() < deadline) {
    const state = await realtimeState();
    assert(state.access_mode === "read_write", `broker left read_write: ${String(state.control_phase)}`);
    assert(state.exclusive_lease_id === leaseId, "exclusive lease changed during HIL");
    assert(state.complete === true, `armed feedback is incomplete: ${JSON.stringify(state.missing_joints ?? [])}`);
    lastRows = motors(state);
    const expectedNames = JOINTS.map((joint) => joint.name).sort();
    const actualNames = lastRows.map((row) => String(row.joint_name)).sort();
    assert(JSON.stringify(actualNames) === JSON.stringify(expectedNames), `armed scope changed: ${actualNames.join(",")}`);
    if (lastRows.every((row) => (
      Number(row.accepted_origin_sequence) === expectedOrigin
      && Number(row.applied_origin_sequence) === expectedOrigin
    ))) return new Map(lastRows.map((row) => [String(row.joint_name), row]));
    await sleep(10);
  }
  throw new Error(
    `joint scope lacks exact accepted/applied proof for origin ${expectedOrigin}: `
    + lastRows.map((row) => `${String(row.joint_name)}=${String(row.accepted_origin_sequence)}/${String(row.applied_origin_sequence)}`).join(", "),
  );
}

function ramp(from: number, to: number, steps = 8): number[] {
  return Array.from({ length: steps }, (_, index) => from + (to - from) * (index + 1) / steps);
}

async function waitForStopped(): Promise<Json> {
  const deadline = performance.now() + 5_000;
  let state: Json = {};
  while (performance.now() < deadline) {
    state = await brokerStatus();
    if (state.access_mode === "read_only" && state.global_control === "stop" && state.exclusive_lease_id == null) return state;
    await sleep(50);
  }
  throw new Error(`broker did not stop: ${String(state.access_mode)}/${String(state.control_phase)}/${String(state.exclusive_lease_id)}`);
}

type JointPlan = {
  joint: typeof JOINTS[number];
  startDeg: number;
  lowDeg: number;
  highDeg: number;
};

async function preflightJoint(joint: typeof JOINTS[number]): Promise<JointPlan> {
  const preflight = await brokerStatus(joint.name);
  assertReadOnly(preflight);
  const startRow = motor(preflight, joint.name);
  assertMotorReady(startRow, joint);

  const startDeg = finite(startRow.display_pos_deg, `${joint.name}.display_pos_deg`);
  const calibration = record(startRow.calibration);
  const minDeg = finite(calibration.control_min_deg ?? calibration.min_deg, `${joint.name}.control_min_deg`);
  const maxDeg = finite(calibration.control_max_deg ?? calibration.max_deg, `${joint.name}.control_max_deg`);
  const highDeg = startDeg + joint.amplitudeDeg;
  const lowDeg = startDeg - joint.amplitudeDeg;
  assert(lowDeg >= minDeg + LIMIT_MARGIN_DEG && highDeg <= maxDeg - LIMIT_MARGIN_DEG, `${joint.name} oscillation is too close to calibrated limits`);
  return { joint, startDeg, lowDeg, highDeg };
}

async function runSingleLeaseFlow(
  droid: Awaited<ReturnType<typeof Droid.connect>>,
  plans: JointPlan[],
): Promise<Json[]> {
  const lease = await droid.control.acquire({
    durationMs: LEASE_DURATION_MS,
    owner: "sdk-hil-left-wrist-head",
    jointNames: JOINTS.map((joint) => joint.name),
  });
  const observed = new Map(plans.map((plan) => [plan.joint.name, {
    minDeg: plan.startDeg,
    maxDeg: plan.startDeg,
    firstOrigin: null as number | null,
    lastOrigin: null as number | null,
  }]));
  const starts = new Map(plans.map((plan) => [plan.joint.name, plan.startDeg]));

  let released = false;
  const sendFrame = async (targets: ReadonlyMap<string, number>): Promise<void> => {
    const started = performance.now();
    const admission = await droid.motion.sendTargets(
      JOINTS.map((joint) => ({
        jointName: joint.name,
        displayDeg: finite(targets.get(joint.name), `${joint.name}.target`),
        maxVelocityDegS: joint.maxVelocityDegS,
      })),
      { leaseId: lease.id, ttlMs: TTL_MS, edgeKeepaliveMs: 0 },
    );
    const origin = originSequence(admission);
    const liveRows = await waitForCommandProof(lease.id, origin);
    for (const joint of JOINTS) {
      const liveRow = liveRows.get(joint.name);
      assert(liveRow, `${joint.name} is absent from live feedback`);
      assertMotorReady(liveRow, joint);
      const displayDeg = finite(liveRow.display_pos_deg, `${joint.name}.live_display_pos_deg`);
      const jointObserved = observed.get(joint.name);
      assert(jointObserved, `${joint.name} observation state is absent`);
      jointObserved.minDeg = Math.min(jointObserved.minDeg, displayDeg);
      jointObserved.maxDeg = Math.max(jointObserved.maxDeg, displayDeg);
      jointObserved.firstOrigin ??= origin;
      jointObserved.lastOrigin = origin;
    }
    const remaining = PERIOD_MS - (performance.now() - started);
    if (remaining > 0) await sleep(remaining);
  };

  const holdFrame = (): Map<string, number> => new Map(starts);
  const waveform = (plan: JointPlan): number[] => [
    ...ramp(plan.startDeg, plan.highDeg), plan.highDeg, plan.highDeg,
    ...ramp(plan.highDeg, plan.startDeg),
    ...ramp(plan.startDeg, plan.lowDeg), plan.lowDeg, plan.lowDeg,
    ...ramp(plan.lowDeg, plan.startDeg),
  ];

  try {
    for (let index = 0; index < 8; index += 1) await sendFrame(holdFrame());
    for (const plan of plans) {
      for (const target of waveform(plan)) {
        const frame = holdFrame();
        frame.set(plan.joint.name, target);
        await sendFrame(frame);
      }
      for (let index = 0; index < 4; index += 1) await sendFrame(holdFrame());
    }
    for (let index = 0; index < 8; index += 1) await sendFrame(holdFrame());
  } finally {
    try {
      await droid.control.release(lease.id);
      released = true;
    } finally {
      await waitForStopped();
    }
  }

  assert(released, "joint-scope lease was not released");
  const results: Json[] = [];
  for (const plan of plans) {
    const finalStatus = await brokerStatus(plan.joint.name);
    assertReadOnly(finalStatus);
    const finalRow = motor(finalStatus, plan.joint.name);
    assertMotorReady(finalRow, plan.joint);
    const finalDeg = finite(finalRow.display_pos_deg, `${plan.joint.name}.final_display_pos_deg`);
    const jointObserved = observed.get(plan.joint.name);
    assert(jointObserved, `${plan.joint.name} observation state is absent`);
    assert(jointObserved.maxDeg - plan.startDeg >= 0.1, `${plan.joint.name} positive physical excursion was not observed`);
    assert(plan.startDeg - jointObserved.minDeg >= 0.1, `${plan.joint.name} negative physical excursion was not observed`);
    assert(Math.abs(finalDeg - plan.startDeg) <= RETURN_TOLERANCE_DEG, `${plan.joint.name} did not return near start`);
    results.push({
      joint: plan.joint.name,
      startDeg: plan.startDeg,
      lowDeg: plan.lowDeg,
      highDeg: plan.highDeg,
      finalDeg,
      minObservedDeg: jointObserved.minDeg,
      maxObservedDeg: jointObserved.maxDeg,
      firstOrigin: jointObserved.firstOrigin,
      lastOrigin: jointObserved.lastOrigin,
      executed: true,
    });
  }
  return results;
}

async function main(): Promise<void> {
  assert(API_KEY, "VITRUS_API_KEY is required");
  if (EXECUTE) {
    assert(process.env.VITRUS_HIL_CONFIRM === CONFIRMATION, `set VITRUS_HIL_CONFIRM=${CONFIRMATION}`);
  }

  const droid = await Droid.connect(DROID_REF, {
    apiKey: API_KEY,
    endpoint: BRIDGE_ENDPOINT,
    clientId: `sdk-hil-r06-wrist-head-${Date.now()}`,
    edgeEndpoint: EDGE_ENDPOINT,
    edgeStatusUrl: `${EDGE_ENDPOINT}/v1/device/status`,
    controlTransport: "edge",
    motionTransport: "edge",
    motionAdmissionTimeoutMs: 1_000,
    requestTimeoutMs: 5_000,
  });
  const identity = await droid.identity.get();
  const status = await droid.status.snapshot();
  assert(identity.id === status.device_id, "Bridge identity and Edge status identify different devices");
  assertSdkSafety(status);

  const scopeClient = new GoldenEdgeClient({
    endpoint: EDGE_ENDPOINT,
    robotId: identity.id,
    leaseId: `preflight-${crypto.randomUUID()}`,
    source: "sdk-hil-r06-wrist-head-preflight",
  });
  const health = await scopeClient.health();
  assert(health.ok && health.transport === "dora", "Golden Edge Dora gateway is unavailable");
  const scope = await scopeClient.controlScope();
  for (const joint of JOINTS) assert(scope.joint_names.includes(joint.name), `${joint.name} is outside the configured remote joint scope`);

  const plans: JointPlan[] = [];
  for (const joint of JOINTS) plans.push(await preflightJoint(joint));
  const results: Json[] = EXECUTE
    ? await runSingleLeaseFlow(droid, plans)
    : plans.map((plan) => ({
      joint: plan.joint.name,
      preflight: "passed",
      startDeg: plan.startDeg,
      rangeDeg: [plan.lowDeg, plan.highDeg],
      executed: false,
    }));
  assertReadOnly(await brokerStatus());
  console.log(JSON.stringify({
    result: EXECUTE ? "passed" : "preflight_passed",
    identity,
    leaseStrategy: "single_lease_exact_joint_scope",
    joints: JOINTS.map((joint) => joint.name),
    results,
  }, null, 2));
}

await main();
