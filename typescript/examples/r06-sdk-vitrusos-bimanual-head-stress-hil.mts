/**
 * HIL stress proof for the SDK -> local VitrusOS/Vitruvian control path.
 *
 * One SDK lease spans both arms and NECK_HEAD. Cartesian trajectories are
 * solved on the R05; the head remains an intentionally direct joint command.
 * A-01/table-tag samples are evidence only, never a control input.
 */
import { Droid, GoldenEdgeClient } from "../src/index.ts";

type Json = Record<string, unknown>;
type Vec3 = [number, number, number];

const DROID_REF = process.env.VITRUS_DROID_REF?.trim() || "VTRS-R06-2607-R2D2X";
const API_KEY = process.env.VITRUS_API_KEY?.trim();
const DATAPLANE = process.env.VITRUS_DATAPLANE_URL?.trim() || "https://vitrus-dataplane.onrender.com";
const EDGE = process.env.VITRUS_EDGE_ENDPOINT?.trim() || "http://127.0.0.1:18782";
const STUDIO = process.env.VITRUS_CALIBRATION_STUDIO_URL?.trim() || "http://127.0.0.1:8791";
const A01 = process.env.VITRUS_A01_URL?.trim() || "http://100.95.232.109:8766";
const LEFT = ["LEFT_SHOULDER_A", "LEFT_SHOULDER_B", "LEFT_SHOULDER_C", "LEFT_ELBOW_A", "LEFT_ELBOW_B", "LEFT_WRIST_A", "LEFT_WRIST_B"];
const RIGHT = ["RIGHT_SHOULDER_A", "RIGHT_SHOULDER_B", "RIGHT_SHOULDER_C", "RIGHT_ELBOW_A", "RIGHT_ELBOW_B", "RIGHT_WRIST_A", "RIGHT_WRIST_B"];
const HEAD = "NECK_HEAD";
const SCOPE = [...LEFT, ...RIGHT, HEAD];
const LEASE_MS = 30_000;
const PATH_TTL_MS = 6_000;

function record(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
function vec3(value: unknown, label: string): Vec3 {
  assert(Array.isArray(value) && value.length === 3 && value.every(Number.isFinite), `${label} is not a finite Vec3`);
  return value as Vec3;
}
function deltaMm(a: Vec3, b: Vec3): Vec3 { return b.map((value, index) => (value - a[index]!) * 1_000) as Vec3; }

async function request(base: string, path: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<Json> {
  const response = await fetch(`${base.replace(/\/+$/, "")}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const payload = record(await response.json().catch(() => null));
  if (!response.ok || payload.ok === false) throw new Error(`${path}: ${String(payload.error ?? response.statusText)}`);
  return payload;
}

async function capture(label: string, requireStationary = true): Promise<Json> {
  const rejections: unknown[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const captured = await request(STUDIO, "/api/fine-alignment/capture", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }, 15_000);
    const sample = record(captured.sample), observation = record(sample.observation);
    const world = record(observation.worldReference), fixtures = record(observation.fixtures);
    // A frame taken during a commanded path is still a deterministic ArUco
    // observation, but is deliberately not promoted to a settled measurement.
    if ((requireStationary && (sample.accepted !== true || world.motionGradeReady !== true)) || Number(world.detectedCount) !== 4) {
      rejections.push(sample.rejectionReasons ?? []);
      await sleep(100);
      continue;
    }
    const eef = (name: string): Vec3 => vec3(record(record(fixtures[name]).tableFromFixture).translationM, `${label}.${name}`);
    return {
      label,
      sampleId: sample.id,
      capturedAt: sample.capturedAt,
      attempts: attempt + 1,
      stationary: sample.accepted === true && world.motionGradeReady === true,
      rejectionReasons: sample.rejectionReasons ?? [],
      jointReprojectionErrorPx: world.jointCornerReprojectionErrorPx,
      tableFromLeftEefM: eef("left_eef"),
      tableFromRightEefM: eef("right_eef"),
    };
  }
  throw new Error(`${label}: no accepted deterministic tag capture: ${JSON.stringify(rejections)}`);
}

async function waitForSettled(edge: GoldenEdgeClient, names: string[], label: string): Promise<Json> {
  const deadline = Date.now() + 11_000;
  let last: Json = {};
  while (Date.now() < deadline) {
    last = await edge.controlState() as unknown as Json;
    const motors = motorMap(last);
    const settled = names.every(name => {
      const motor = motors.get(name);
      return motor?.connected === true && motor.stale !== true && !motor.fault
        && Math.abs(Number(motor.velocity_deg_s ?? motor.vel_dps)) <= 2;
    });
    if (settled) return last;
    await sleep(100);
  }
  throw new Error(`${label}: joints did not settle before the next path`);
}

async function waitFor(edge: GoldenEdgeClient, predicate: (state: Json) => boolean, label: string, timeoutMs = 8_000): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  let last: Json = {};
  while (Date.now() < deadline) {
    last = await edge.controlState() as unknown as Json;
    if (predicate(last)) return last;
    await sleep(50);
  }
  throw new Error(`${label}: ${JSON.stringify({ access: last.access_mode, phase: last.control_phase, lease: last.exclusive_lease_id })}`);
}

async function renewSameLease(droid: Awaited<ReturnType<typeof Droid.connect>>, leaseId: string): Promise<void> {
  const renewed = await droid.control.renew(leaseId, { durationMs: LEASE_MS });
  assert(renewed.id === leaseId, "renew changed the active lease identity");
}

function motorMap(state: Json): Map<string, Json> {
  return new Map((Array.isArray(state.motors) ? state.motors : []).map(row => {
    const motor = record(row); return [String(motor.joint_name), motor];
  }));
}

function proveApplied(state: Json, names: string[], label: string): Json {
  const byName = motorMap(state);
  const applied: Json = {};
  for (const name of names) {
    const motor = byName.get(name);
    assert(motor?.connected === true && motor.stale !== true && !motor.fault, `${label}: ${name} lost valid feedback`);
    const sequence = Number(motor.applied_origin_sequence);
    assert(Number.isSafeInteger(sequence) && sequence > 0, `${label}: ${name} has no applied-origin proof`);
    applied[name] = { acceptedOriginSequence: motor.accepted_origin_sequence, appliedOriginSequence: motor.applied_origin_sequence, feedbackAgeMs: motor.feedback_age_ms };
  }
  return applied;
}

function path(base: Vec3, quaternion: number[], offsets: Vec3[]): Array<{ positionM: Vec3; quaternionXyzw: number[]; timeMs: number }> {
  return offsets.map((offset, index) => ({
    positionM: base.map((value, axis) => value + offset[axis]!) as Vec3,
    quaternionXyzw: quaternion,
    timeMs: [0, 700, 1_450, 2_200, 3_400][index]!,
  }));
}

async function startRecording(): Promise<string> {
  const start = await request(A01, "/api/recording-sessions/start", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ camera: "high_camera", fps: 30, max_duration_seconds: 35, name: `r06-sdk-vitrusos-stress-${Date.now()}` }),
  }, 20_000);
  const id = String(start.id ?? ""); assert(id, "A-01 returned no recording id");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await request(A01, `/api/recording-sessions/${encodeURIComponent(id)}`);
    const state = String(record(current.session).state ?? current.state ?? "").toLowerCase();
    if (state === "recording") return id;
    if (["failed", "cancelled", "stopped", "completed"].includes(state)) throw new Error(`A-01 recording is ${state}`);
    await sleep(250);
  }
  throw new Error("A-01 recording did not start");
}

async function stopRecording(id: string): Promise<Json> {
  await request(A01, `/api/recording-sessions/${encodeURIComponent(id)}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, 20_000);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const current = await request(A01, `/api/recording-sessions/${encodeURIComponent(id)}`);
    const state = String(record(current.session).state ?? current.state ?? "").toLowerCase();
    if (["completed", "stopped", "cancelled", "failed"].includes(state)) return current;
    await sleep(250);
  }
  throw new Error("A-01 recording did not finish");
}

async function main(): Promise<void> {
  assert(API_KEY, "VITRUS_API_KEY is required");
  const droid = await Droid.connect(DROID_REF, { apiKey: API_KEY, endpoint: DATAPLANE, edgeEndpoint: EDGE, controlTransport: "edge", motionTransport: "edge", clientId: `sdk-vitrusos-stress-${Date.now()}`, motionAdmissionTimeoutMs: 4_000 });
  const identity = await droid.identity.get();
  // Status is evidence-only and can share CPU with video + ArUco. Keep its
  // timeout independent from the 4 s motion-admission deadline above.
  const edge = new GoldenEdgeClient({ endpoint: EDGE, robotId: identity.id, source: "sdk-vitrusos-bimanual-head-stress", leaseId: `preflight-${crypto.randomUUID()}`, requestTimeoutMs: 10_000 });
  assert((await edge.health()).ok, "Edge gateway is unavailable");
  const before = await edge.controlState() as unknown as Json;
  assert(before.access_mode === "read_only" && before.global_control === "stop" && before.exclusive_lease_id == null, "broker is not idle");
  const preflight = motorMap(before);
  for (const name of SCOPE) {
    const motor = preflight.get(name);
    assert(motor?.connected === true && motor.stale !== true && !motor.fault && motor.clay_can_control === true, `${name} is not control-ready`);
  }
  const [leftPose, rightPose, baseline, cameras] = await Promise.all([
    edge.currentCartesianPose("LEFT_ARM"), edge.currentCartesianPose("RIGHT_ARM"), capture("baseline"), droid.camera.list(),
  ]);
  const profile = record(rightPose.alignment_profile);
  assert(typeof profile.id === "string" && profile.id.length > 0 && profile.studio_version === "alignment-v15", "right arm has no current Alignment Studio profile");
  assert(record(leftPose.alignment_profile).id === profile.id, "arm alignment profiles differ");
  const headStart = Number(preflight.get(HEAD)?.display_pos_deg); assert(Number.isFinite(headStart), "NECK_HEAD has no measured position");
  const leftPoints = path(vec3(leftPose.position, "left pose"), leftPose.quaternion, [[0, 0, 0], [0.014, 0, 0.008], [0.006, 0.012, 0.014], [-0.008, 0.005, 0.009], [0, 0, 0]]);
  const rightPoints = path(vec3(rightPose.position, "right pose"), rightPose.quaternion, [[0, 0, 0], [-0.014, 0, 0.008], [-0.006, 0.012, 0.014], [0.008, 0.005, 0.009], [0, 0, 0]]);

  let leaseId: string | null = null, recordingId: string | null = null;
  const evidence: Json[] = [baseline];
  try {
    recordingId = await startRecording();
    const lease = await droid.control.acquire({ durationMs: LEASE_MS, owner: "sdk-vitrusos-bimanual-head-stress", jointNames: SCOPE });
    leaseId = lease.id; edge.setLease(leaseId);
    await waitFor(edge, state => state.access_mode === "read_write" && state.control_phase === "ready_for_realtime" && state.exclusive_lease_id === leaseId, "lease was not ready");

    // The device's default profile is the latest Alignment Studio profile.
    // Omit the opaque profile id: profile files are device-local names, while
    // their embedded IDs are provenance, not lookup keys.
    const left = await droid.motion.sendCartesianTrajectory({ leaseId, chain: "LEFT_ARM", points: leftPoints, ttlMs: PATH_TTL_MS });
    assert(left.status === "acknowledged" && record(left.result).accepted === true, `left IK rejected: ${JSON.stringify(left)}`);
    await sleep(2_500);
    // The table sample is intentionally marked transient: BLDC settling is
    // observable for longer than the planned Cartesian interpolation, and we
    // do not treat a moving camera frame as a settled calibration datum.
    evidence.push({ ...(await capture("left_transient", false)), applied: proveApplied(await edge.controlState() as unknown as Json, LEFT, "left transient") });
    await renewSameLease(droid, leaseId);

    await sleep(1_500);
    const right = await droid.motion.sendCartesianTrajectory({ leaseId, chain: "RIGHT_ARM", points: rightPoints, ttlMs: PATH_TTL_MS });
    assert(right.status === "acknowledged" && record(right.result).accepted === true, `right IK rejected: ${JSON.stringify(right)}`);
    await sleep(2_500);
    evidence.push({ ...(await capture("right_transient", false)), applied: proveApplied(await edge.controlState() as unknown as Json, RIGHT, "right transient") });
    await renewSameLease(droid, leaseId);

    for (const target of [headStart + 5, headStart - 5, headStart + 3, headStart]) {
      const result = await droid.motion.sendTargets([{ jointName: HEAD, displayDeg: target }], { leaseId, ttlMs: 1_500 });
      assert(result.status === "acknowledged", `head target rejected: ${JSON.stringify(result)}`);
      await sleep(1_400);
    }
    await sleep(800);
    const headState = await edge.controlState() as unknown as Json;
    evidence.push({ ...(await capture("after_head_sweep", false)), applied: proveApplied(headState, [HEAD], "head") });
    const cameraFrames = (await droid.camera.list()).map(camera => ({ name: camera.name, ready: camera.ready, latestFrameId: record(camera).latest_frame?.frameId }));
    assert(cameraFrames.every(camera => camera.ready === true && typeof camera.latestFrameId === "string"), "one or more SDK cameras lack a fresh frame");

    const samples = evidence.map(record);
    console.log(JSON.stringify({
      result: "passed", lease: "single", profile, paths: { left: leftPoints, right: rightPoints },
      a01Baseline: baseline, a01MovementMm: samples.slice(1).map(sample => ({ label: sample.label, left: deltaMm(vec3(baseline.tableFromLeftEefM, "baseline.left"), vec3(sample.tableFromLeftEefM, `${sample.label}.left`)), right: deltaMm(vec3(baseline.tableFromRightEefM, "baseline.right"), vec3(sample.tableFromRightEefM, `${sample.label}.right`)) })),
      evidence, camerasBefore: cameras.map(camera => ({ name: camera.name, ready: camera.ready })), cameraFrames,
    }, null, 2));
  } finally {
    if (leaseId) await droid.control.release(leaseId).catch(() => undefined);
    await waitFor(edge, state => state.access_mode === "read_only" && state.global_control === "stop" && state.exclusive_lease_id == null, "broker did not stop");
    if (recordingId) console.log(JSON.stringify({ a01Recording: await stopRecording(recordingId) }, null, 2));
  }
}

await main();
