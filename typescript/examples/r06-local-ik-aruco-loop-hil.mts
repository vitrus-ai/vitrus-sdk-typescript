/**
 * Bounded HIL proof for robot-local Cartesian control.
 *
 * The SDK submits one timed Cartesian path.  VitrusOS on the R05 owns the
 * Vitruvian solve and motor targets; this client only records deterministic
 * A-01 tag poses at stationary phases and captures the A-01 video session.
 */
import { Droid, GoldenEdgeClient } from "../src/index.ts";

type Json = Record<string, unknown>;
type Vec3 = [number, number, number];

const DROID_REF = process.env.VITRUS_DROID_REF?.trim() || "VTRS-R06-2607-R2D2X";
const API_KEY = process.env.VITRUS_API_KEY?.trim();
const BRIDGE_ENDPOINT = process.env.VITRUS_DATAPLANE_URL?.trim() || "https://vitrus-dataplane.onrender.com";
const EDGE_ENDPOINT = process.env.VITRUS_EDGE_ENDPOINT?.trim() || "http://127.0.0.1:18782";
const STUDIO_ENDPOINT = process.env.VITRUS_CALIBRATION_STUDIO_URL?.trim() || "http://127.0.0.1:8791";
const A01_ENDPOINT = process.env.VITRUS_A01_URL?.trim() || "http://100.95.232.109:8766";
const DRY_RUN = process.env.VITRUS_HIL_DRY_RUN === "1";
const CHAIN = "LEFT_ARM";
const ARM_JOINTS = ["LEFT_SHOULDER_A", "LEFT_SHOULDER_B", "LEFT_SHOULDER_C", "LEFT_ELBOW_A", "LEFT_ELBOW_B", "LEFT_WRIST_A", "LEFT_WRIST_B"];
const LIFT_M = Math.max(0.005, Math.min(0.03, Number(process.env.VITRUS_HIL_LIFT_M ?? "0.02")));
const TRAJECTORY_TTL_MS = 19_000;
const LEASE_MS = 30_000;

function object(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
function vec3(value: unknown, label: string): Vec3 {
  assert(Array.isArray(value) && value.length === 3 && value.every(item => Number.isFinite(Number(item))), `${label} must be a finite Vec3`);
  return value.map(Number) as Vec3;
}
function median(values: number[]): number { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.floor(ordered.length / 2)]!; }
function deltaMm(from: Vec3, to: Vec3): Vec3 { return to.map((value, axis) => (value - from[axis]!) * 1_000) as Vec3; }

async function request(base: string, path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Json> {
  const response = await fetch(`${base.replace(/\/+$/, "")}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const payload = object(await response.json().catch(() => null));
  if (!response.ok || payload.ok === false) throw new Error(`${path}: ${String(payload.error ?? response.statusText)}`);
  return payload;
}

async function captureBurst(label: string, count = 5): Promise<Json> {
  const rows: Json[] = [];
  const rejected: Json[] = [];
  const candidateCount = count + 4;
  for (let attempt = 0; attempt < candidateCount * 4 && rows.length < candidateCount; attempt += 1) {
    const response = await request(STUDIO_ENDPOINT, "/api/fine-alignment/capture", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, 15_000);
    const sample = object(response.sample), observation = object(sample.observation), world = object(observation.worldReference), fixture = object(object(observation.fixtures).left_eef);
    if (sample.accepted !== true || world.motionGradeReady !== true) {
      rejected.push({ id: sample.id, reasons: sample.rejectionReasons ?? [], motionGradeReady: world.motionGradeReady });
      await sleep(100);
      continue;
    }
    rows.push({ id: sample.id, capturedAt: sample.capturedAt, tableFromLeftEefM: vec3(object(fixture.tableFromFixture).translationM, `${label}.left_eef`), jointReprojectionPx: world.jointCornerReprojectionErrorPx });
    await sleep(100);
  }
  assert(rows.length >= count, `${label}: only ${rows.length}/${count} accepted deterministic captures: ${JSON.stringify(rejected)}`);
  const candidates = rows.map(row => vec3(row.tableFromLeftEefM, `${label}.tableFromLeftEefM`));
  const candidateCenter: Vec3 = [median(candidates.map(point => point[0])), median(candidates.map(point => point[1])), median(candidates.map(point => point[2]))];
  const selectedRows = rows
    .map((row, index) => ({ row, point: candidates[index]!, distanceM: Math.hypot(...candidates[index]!.map((value, axis) => value - candidateCenter[axis]!)) }))
    .sort((left, right) => left.distanceM - right.distanceM)
    .slice(0, count);
  const points = selectedRows.map(row => row.point);
  const center: Vec3 = [median(points.map(point => point[0])), median(points.map(point => point[1])), median(points.map(point => point[2]))];
  const maxSpreadM = Math.max(...points.map(point => Math.hypot(...point.map((value, axis) => value - center[axis]!))));
  assert(maxSpreadM <= 0.002, `${label}: ArUco burst spread ${(maxSpreadM * 1_000).toFixed(2)} mm exceeds 2 mm`);
  return { label, sampleCount: selectedRows.length, candidateSampleCount: rows.length, rejectedAttemptCount: rejected.length, tableFromLeftEefM: center, maxSpreadM, samples: selectedRows.map(item => item.row) };
}

async function waitForLease(edge: GoldenEdgeClient, leaseId: string): Promise<Json> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const state = await edge.controlState() as unknown as Json;
    // This is the broker's completed hold transition, not a separate SDK
    // authorization gate.  Before it, realtime telemetry intentionally has
    // no settled controller state for the robot-local solver to seed from.
    if (state.access_mode === "read_write" && state.exclusive_lease_id === leaseId && state.control_phase === "ready_for_realtime") return state;
    await sleep(50);
  }
  throw new Error("broker did not confirm the requested local IK lease");
}

async function waitForStop(edge: GoldenEdgeClient): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const state = await edge.controlState() as unknown as Json;
    if (state.access_mode === "read_only" && state.global_control === "stop" && state.exclusive_lease_id == null) return;
    await sleep(50);
  }
  throw new Error("broker did not return to read_only/stop");
}

async function startRecording(): Promise<string> {
  const started = await request(A01_ENDPOINT, "/api/recording-sessions/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ camera: "high_camera", fps: 30, max_duration_seconds: 45, name: `r06-local-ik-aruco-loop-${Date.now()}` }) }, 20_000);
  const id = String(started.id ?? "");
  assert(id, "A-01 did not return a recording id");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await request(A01_ENDPOINT, `/api/recording-sessions/${encodeURIComponent(id)}`);
    const state = String(object(current.session).state ?? current.state ?? "").toLowerCase();
    if (state === "recording") return id;
    if (["failed", "cancelled", "stopped", "completed"].includes(state)) throw new Error(`A-01 recording entered ${state}`);
    await sleep(250);
  }
  throw new Error("A-01 recording did not start");
}

async function stopRecording(id: string): Promise<Json> {
  const stopped = await request(A01_ENDPOINT, `/api/recording-sessions/${encodeURIComponent(id)}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, 20_000);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const current = await request(A01_ENDPOINT, `/api/recording-sessions/${encodeURIComponent(id)}`);
    const session = object(current.session), state = String(session.state ?? current.state ?? "").toLowerCase();
    if (["completed", "stopped", "cancelled", "failed"].includes(state)) return { started: stopped, terminal: current };
    await sleep(250);
  }
  throw new Error("A-01 recording did not reach a terminal state");
}

async function main(): Promise<void> {
  assert(API_KEY, "VITRUS_API_KEY is required");
  const droid = await Droid.connect(DROID_REF, { apiKey: API_KEY, endpoint: BRIDGE_ENDPOINT, clientId: `sdk-local-ik-aruco-${Date.now()}`, edgeEndpoint: EDGE_ENDPOINT, controlTransport: "edge", motionTransport: "edge", motionAdmissionTimeoutMs: 4_000, requestTimeoutMs: 5_000 });
  const identity = await droid.identity.get();
  const edge = new GoldenEdgeClient({ endpoint: EDGE_ENDPOINT, robotId: identity.id, leaseId: `preflight-${crypto.randomUUID()}`, source: "sdk-local-ik-aruco-loop", requestTimeoutMs: 4_000 });
  assert((await edge.health()).ok, "Edge gateway is unavailable");
  const preflight = await edge.controlState() as unknown as Json;
  assert(preflight.access_mode === "read_only" && preflight.global_control === "stop" && preflight.exclusive_lease_id == null, "broker is not idle before local IK HIL");
  const preflightMotors = new Map((Array.isArray(preflight.motors) ? preflight.motors : []).map(row => { const motor = object(row); return [String(motor.joint_name), motor]; }));
  for (const name of ARM_JOINTS) {
    const motor = preflightMotors.get(name);
    assert(motor?.connected === true && motor.stale !== true && !motor.fault && motor.clay_can_control === true, `${name} is not ready for local IK HIL`);
  }
  const baseline = await captureBurst("baseline");
  const current = await edge.currentCartesianPose(CHAIN);
  assert(JSON.stringify(current.joint_names) === JSON.stringify(ARM_JOINTS), "local IK chain does not match left arm");
  const base = vec3(current.position, "local IK current pose"), quaternion = current.quaternion;
  const raised: Vec3 = [base[0], base[1], base[2] + LIFT_M];
  const points = [
    { positionM: base, quaternionXyzw: quaternion, timeMs: 0 },
    { positionM: raised, quaternionXyzw: quaternion, timeMs: 600 },
    { positionM: raised, quaternionXyzw: quaternion, timeMs: 4_600 },
    { positionM: base, quaternionXyzw: quaternion, timeMs: 5_200 },
    { positionM: base, quaternionXyzw: quaternion, timeMs: 9_000 },
    { positionM: raised, quaternionXyzw: quaternion, timeMs: 9_600 },
    { positionM: raised, quaternionXyzw: quaternion, timeMs: 13_600 },
    { positionM: base, quaternionXyzw: quaternion, timeMs: 14_200 },
    { positionM: base, quaternionXyzw: quaternion, timeMs: 17_200 },
  ];
  if (DRY_RUN) {
    console.log(JSON.stringify({ result: "planned", chain: CHAIN, localPose: current, defaultAlignmentProfile: current.alignment_profile, baseline, points }, null, 2));
    return;
  }

  let leaseId: string | null = null, recordingId: string | null = null;
  const captures: Json[] = [];
  try {
    recordingId = await startRecording();
    const lease = await droid.control.acquire({ durationMs: LEASE_MS, owner: "sdk-local-ik-aruco-loop", jointNames: ARM_JOINTS });
    leaseId = lease.id; edge.setLease(lease.id);
    await waitForLease(edge, lease.id);
    const admission = await droid.motion.sendCartesianTrajectory({ leaseId: lease.id, jobId: `${lease.id}:aruco-loop`, inputSequence: 1, chain: CHAIN, points, ttlMs: TRAJECTORY_TTL_MS });
    const result = object(admission.result);
    assert(admission.status === "acknowledged" && result.accepted === true && result.mode === "ik", `local IK was not accepted: ${JSON.stringify(admission)}`);
    assert(object(result.alignment_profile).id === current.alignment_profile.id, "local IK did not use the device default alignment profile");
    const motionStartedAt = Date.now();
    for (const [label, atMs] of [["peak_1", 2_000], ["return_1", 6_600], ["peak_2", 11_000], ["return_2", 15_600]] as const) {
      await sleep(Math.max(0, motionStartedAt + atMs - Date.now()));
      const burst = await captureBurst(label);
      const state = await edge.controlState() as unknown as Json;
      const applied = Object.fromEntries((Array.isArray(state.motors) ? state.motors : []).map(row => { const motor = object(row); return [String(motor.joint_name), { acceptedOriginSequence: motor.accepted_origin_sequence, appliedOriginSequence: motor.applied_origin_sequence, feedbackAgeMs: motor.feedback_age_ms }]; }));
      assert(ARM_JOINTS.every(name => Number.isSafeInteger(Number(object(applied[name]).appliedOriginSequence))), `${label}: missing applied-origin proof`);
      captures.push({ ...burst, broker: applied });
    }
    await sleep(Math.max(0, motionStartedAt + 17_800 - Date.now()));
    const final = captures.at(-1)!;
    console.log(JSON.stringify({ result: "passed", chain: CHAIN, solver: "VitrusOS/Vitruvian local", requestedLiftM: LIFT_M, defaultAlignmentProfile: current.alignment_profile, localStartPose: current, a01Baseline: baseline, captures: captures.map(capture => ({ label: capture.label, tableFromLeftEefM: capture.tableFromLeftEefM, deltaFromBaselineMm: deltaMm(vec3(baseline.tableFromLeftEefM, "baseline"), vec3(capture.tableFromLeftEefM, String(capture.label))), maxSpreadM: capture.maxSpreadM })), final }, null, 2));
  } finally {
    if (leaseId) await droid.control.release(leaseId).catch(() => undefined);
    await waitForStop(edge);
    if (recordingId) console.log(JSON.stringify({ a01Recording: await stopRecording(recordingId) }, null, 2));
  }
}

await main();
