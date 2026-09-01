import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Droid, GoldenEdgeClient, type DeviceStatus, type DroidCommandResult } from "../src/index.ts";

type Json = Record<string, unknown>;
type Matrix4 = number[][];

const DROID_REF = process.env.VITRUS_DROID_REF?.trim() || "VTRS-R06-2607-R2D2X";
const API_KEY = process.env.VITRUS_API_KEY?.trim();
const BRIDGE_ENDPOINT = process.env.VITRUS_DATAPLANE_URL?.trim() || "https://vitrus-dataplane.onrender.com";
const EDGE_ENDPOINT = process.env.VITRUS_EDGE_ENDPOINT?.trim() || "http://127.0.0.1:18782";
const BROKER_ENDPOINT = process.env.VITRUS_BROKER_ENDPOINT?.trim() || "http://127.0.0.1:18775";
const ALIGNMENT_PROFILE_PATH = process.env.VITRUS_ALIGNMENT_PROFILE?.trim()
  || "/Users/lucas-vitrus/Documents/ChatGPT/R06 VItrusOS Control/robot_calibration_app/calibration_studio/calibration_profiles/R06-studio-r2-autorebase.json";
const VITRUVIAN_MODELS_PATH = process.env.VITRUS_VITRUVIAN_MODELS?.trim()
  || "/Users/lucas-vitrus/Documents/ChatGPT/R06 VItrusOS Control/audit/create_robot_r06_cannon_sensor_parent_candidate_20260818T193100Z/vitruvian_models.json";
const VITRUVIAN_MODULE_PATH = process.env.VITRUS_VITRUVIAN_MODULE?.trim()
  || "/Users/lucas-vitrus/Documents/GitHub/Clay/vitruvian/typescript/dist/index.js";
const VITRUVIAN_WASM_PATH = process.env.VITRUS_VITRUVIAN_WASM?.trim()
  || "/Users/lucas-vitrus/Documents/GitHub/Clay/vitruvian/typescript/dist/generated/vitruvian_ik_bg.wasm";
const DRY_RUN = process.env.VITRUS_HIL_DRY_RUN === "1";
const LIFT_M = Math.max(0.005, Math.min(0.06, Number(process.env.VITRUS_LIFT_M ?? "0.05")));
const PERIOD_MS = 20;
const TTL_MS = 250;
const ARMING_TIMEOUT_MS = 8_000;
const FEEDBACK_MAX_AGE_MS = 180;
const LEASE_DURATION_MS = 30_000;
const GOAL_HOLD_MS = Math.max(500, Math.min(15_000, Number(process.env.VITRUS_GOAL_HOLD_MS ?? "8_000")));
const CORRECTION_HOLD_MS = 2_500;
const CORRECTION_PASSES = 3;

const ARM_JOINTS = [
  "LEFT_SHOULDER_A",
  "LEFT_SHOULDER_B",
  "LEFT_SHOULDER_C",
  "LEFT_ELBOW_A",
  "LEFT_ELBOW_B",
  "LEFT_WRIST_A",
  "LEFT_WRIST_B",
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
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new Error(`${url} timed out after ${timeoutMs} ms`);
    }
    throw error;
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
  assert(status.telemetry.complete && !status.telemetry.stale, "SDK telemetry is incomplete or stale");
  assert(status.robot.available_joint_count === status.robot.joint_count, "not all configured joints are available");
}

function assertReadOnly(state: Json): void {
  assert(state.access_mode === "read_only", `broker access mode is ${String(state.access_mode)}`);
  assert(state.control_phase === "read_only", `broker phase is ${String(state.control_phase)}`);
  assert(state.global_control === "stop", `broker global control is ${String(state.global_control)}`);
  assert(state.exclusive_lease_id == null, `unexpected lease ${String(state.exclusive_lease_id)}`);
}

function assertMotorReady(row: Json, jointName: string): void {
  assert(row.connected === true, `${jointName} is disconnected`);
  assert(row.calibrated === true, `${jointName} is not calibrated`);
  assert(row.stale !== true, `${jointName} feedback is stale`);
  assert(!row.fault, `${jointName} fault: ${String(row.fault)}`);
  assert(row.clay_can_control === true, `${jointName} is not controllable: ${String(row.clay_unavailable_reason ?? "unknown")}`);
  const feedbackAgeMs = finite(row.feedback_age_ms, `${jointName}.feedback_age_ms`);
  assert(feedbackAgeMs <= FEEDBACK_MAX_AGE_MS, `${jointName} feedback is ${feedbackAgeMs.toFixed(1)} ms old`);
}

async function brokerStatus(jointNames: readonly string[] = []): Promise<Json> {
  const query = new URLSearchParams({ fast: "1" });
  if (jointNames.length) {
    const names = jointNames.join(",");
    query.set("preflight_joints", names);
    query.set("driver_readback_joints", names);
  } else {
    query.set("live", "1");
  }
  return jsonRequest(`${BROKER_ENDPOINT}/api/motor-bridge/status?${query}`, undefined, jointNames.length ? 20_000 : 3_000);
}

async function freshArmStatus(): Promise<Json> {
  const deadline = performance.now() + 1_500;
  let last: Json = {};
  while (performance.now() < deadline) {
    last = await brokerStatus(ARM_JOINTS);
    assertReadOnly(last);
    const ready = ARM_JOINTS.every((jointName) => {
      const row = motor(last, jointName);
      const age = Number(row.feedback_age_ms);
      return row.connected === true && row.calibrated === true && row.stale !== true && !row.fault
        && row.clay_can_control === true && Number.isFinite(age) && age <= FEEDBACK_MAX_AGE_MS;
    });
    if (ready) {
      for (const jointName of ARM_JOINTS) assertMotorReady(motor(last, jointName), jointName);
      return last;
    }
    await sleep(25);
  }
  throw new Error(`left arm did not provide complete fresh feedback: ${JSON.stringify(motors(last).map((row) => ({ joint: row.joint_name, age: row.feedback_age_ms, reason: row.clay_unavailable_reason })))}`);
}

function identity(): Matrix4 {
  return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
}

function multiply(a: Matrix4, b: Matrix4): Matrix4 {
  return a.map((row) => row.map((_value, column) => row.reduce((sum, value, index) => sum + value * b[index]![column]!, 0)));
}

function rotation(axis: number[], angle: number): Matrix4 {
  const length = Math.hypot(...axis);
  assert(length > 1e-12, "joint axis has zero length");
  const [x, y, z] = axis.map((value) => value / length) as [number, number, number];
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0],
    [0, 0, 0, 1],
  ];
}

function quaternion(matrix: Matrix4): [number, number, number, number] {
  const m00 = matrix[0]![0]!, m11 = matrix[1]![1]!, m22 = matrix[2]![2]!, trace = m00 + m11 + m22;
  let x = 0, y = 0, z = 0, w = 1, scale = 1;
  if (trace > 0) {
    scale = Math.sqrt(trace + 1) * 2;
    w = 0.25 * scale; x = (matrix[2]![1]! - matrix[1]![2]!) / scale;
    y = (matrix[0]![2]! - matrix[2]![0]!) / scale; z = (matrix[1]![0]! - matrix[0]![1]!) / scale;
  } else if (m00 > m11 && m00 > m22) {
    scale = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (matrix[2]![1]! - matrix[1]![2]!) / scale; x = 0.25 * scale;
    y = (matrix[0]![1]! + matrix[1]![0]!) / scale; z = (matrix[0]![2]! + matrix[2]![0]!) / scale;
  } else if (m11 > m22) {
    scale = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (matrix[0]![2]! - matrix[2]![0]!) / scale; x = (matrix[0]![1]! + matrix[1]![0]!) / scale;
    y = 0.25 * scale; z = (matrix[1]![2]! + matrix[2]![1]!) / scale;
  } else {
    scale = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (matrix[1]![0]! - matrix[0]![1]!) / scale; x = (matrix[0]![2]! + matrix[2]![0]!) / scale;
    y = (matrix[1]![2]! + matrix[2]![1]!) / scale; z = 0.25 * scale;
  }
  return [x, y, z, w];
}

function pose(model: Json, q: number[]): { positionM: [number, number, number]; quaternionXyzw: [number, number, number, number] } {
  let transform = identity();
  const joints = model.joints as Json[];
  joints.forEach((joint, index) => {
    transform = multiply(transform, joint.originMatrix as Matrix4);
    transform = multiply(transform, rotation(joint.axis as number[], q[index]!));
  });
  transform = multiply(transform, model.terminalMatrix as Matrix4);
  return {
    positionM: [transform[0]![3]!, transform[1]![3]!, transform[2]![3]!],
    quaternionXyzw: quaternion(transform),
  };
}

function adaptedModel(source: Json, profile: Json, state: Json): { model: Json; frameCorrections: number; runtimeLimits: number } {
  const model = structuredClone(source);
  const workspaceJoints = record(record(profile.workspace).joints);
  const rows = new Map(motors(state).map((row) => [String(row.joint_name), row]));
  let frameCorrections = 0, runtimeLimits = 0;
  for (const joint of model.joints as Json[]) {
    const name = String(joint.name);
    const patch = record(workspaceJoints[name]);
    const translation = Array.isArray(patch.frameTranslationM) ? patch.frameTranslationM.map(Number) : [0, 0, 0];
    const angles = Array.isArray(patch.frameRotationDeg) ? patch.frameRotationDeg.map(Number) : [0, 0, 0];
    if ([...translation, ...angles].some((value) => Number.isFinite(value) && Math.abs(value) > 1e-12)) frameCorrections += 1;
    let origin = structuredClone(joint.originMatrix) as Matrix4;
    origin[0]![3] += Number(translation[0]) || 0;
    origin[1]![3] += Number(translation[1]) || 0;
    origin[2]![3] += Number(translation[2]) || 0;
    const toRad = Math.PI / 180;
    const euler = multiply(
      multiply(rotation([1, 0, 0], (Number(angles[0]) || 0) * toRad), rotation([0, 1, 0], (Number(angles[1]) || 0) * toRad)),
      rotation([0, 0, 1], (Number(angles[2]) || 0) * toRad),
    );
    joint.originMatrix = multiply(origin, euler);
    const row = rows.get(name);
    const calibration = record(row?.calibration);
    const minDeg = Number(calibration.control_min_deg ?? calibration.min_deg);
    const maxDeg = Number(calibration.control_max_deg ?? calibration.max_deg);
    assert(Number.isFinite(minDeg) && Number.isFinite(maxDeg) && Math.abs(maxDeg - minDeg) > 0.1, `${name} has no authoritative runtime limits`);
    joint.lower = Math.min(minDeg, maxDeg) * toRad;
    joint.upper = Math.max(minDeg, maxDeg) * toRad;
    runtimeLimits += 1;
  }
  return { model, frameCorrections, runtimeLimits };
}

async function loadPlanner(state: Json): Promise<{ model: Json; profile: Json; provenance: Json }> {
  const [profileText, modelsText] = await Promise.all([
    readFile(ALIGNMENT_PROFILE_PATH, "utf8"),
    readFile(VITRUVIAN_MODELS_PATH, "utf8"),
  ]);
  const profile = record(JSON.parse(profileText));
  const models = record(JSON.parse(modelsText));
  assert(profile.schema === "vitrus.robot_calibration_profile.v1", "Alignment Studio profile schema is invalid");
  assert(record(profile.provenance).studioVersion === "alignment-v15", "Alignment Studio profile is not the latest alignment-v15 contract");
  const source = record(models.LEFT_ARM_TCP);
  assert(Array.isArray(source.joints) && source.joints.length === ARM_JOINTS.length, "LEFT_ARM_TCP Vitruvian model is missing or incomplete");
  const adapted = adaptedModel(source, profile, state);
  const names = (adapted.model.joints as Json[]).map((joint) => String(joint.name));
  assert(JSON.stringify(names) === JSON.stringify(ARM_JOINTS), `Vitruvian joint order does not match the physical chain: ${JSON.stringify(names)}`);
  return {
    model: adapted.model,
    profile,
    provenance: {
      alignmentProfile: ALIGNMENT_PROFILE_PATH,
      profileId: profile.id,
      profileCreatedAt: profile.createdAt,
      studioVersion: record(profile.provenance).studioVersion,
      modelBundle: VITRUVIAN_MODELS_PATH,
      frameCorrectionsApplied: adapted.frameCorrections,
      runtimeEdgeLimitsApplied: adapted.runtimeLimits,
    },
  };
}

function qFromState(model: Json, state: Json): number[] {
  const byName = new Map(motors(state).map((row) => [String(row.joint_name), row]));
  return (model.joints as Json[]).map((joint) => finite(byName.get(String(joint.name))?.display_pos_deg, `${String(joint.name)}.display_pos_deg`) * Math.PI / 180);
}

async function solveTarget(model: Json, measuredQ: number[], targetPosition: [number, number, number]): Promise<Json> {
  // The serialized neutral belongs to the source URDF limit convention. Once
  // Alignment Studio frames and live Edge limits are applied, the measured
  // configuration is the only valid local seed for this one-shot HIL plan.
  model.neutral = measuredQ.slice();
  const currentPose = pose(model, measuredQ);
  const requestedLiftM = targetPosition[2] - currentPose.positionM[2];
  const library = await import(pathToFileURL(VITRUVIAN_MODULE_PATH).href);
  const wasm = await readFile(VITRUVIAN_WASM_PATH);
  const solver = await library.VitruvianIK.create(model, {
    // Match Alignment Studio's calibration-vertical contract: this candidate
    // bundle has a documented invalid arm collision capsule. A Z-only <=60 mm
    // solve therefore omits that capsule gate while all live joint limits,
    // feedback, fault, lease, deadman, and applied-command checks remain active.
    selfCollisionEnabled: false,
    environmentCollisionEnabled: false,
    orientationWeight: 0,
    maxPositionStep: 0.005,
    maxOrientationStep: 0.035,
    maxJointStep: Math.PI / 180,
    iterations: 12,
    singularValueThreshold: 0.001,
  }, wasm);
  try {
    let q = measuredQ.slice();
    let output: Json = {};
    const iterations: Json[] = [];
    for (let index = 0; index < 80; index += 1) {
      output = record(solver.step({
        measuredQ: q,
        measuredDq: new Array(q.length).fill(0),
        targetPosition,
        targetQuaternion: currentPose.quaternionXyzw,
        dt: PERIOD_MS / 1_000,
        positionOnly: true,
      }));
      const status = String(output.status);
      const candidate = Array.isArray(output.qTarget) ? output.qTarget.map(Number) : [];
      const candidatePose = candidate.length === q.length && candidate.every(Number.isFinite)
        ? pose(model, candidate)
        : null;
      assert(
        status === "converged" || status === "improving",
        `Vitruvian ${status}: ${JSON.stringify({ measuredQ, currentPose, targetPosition, candidatePose, candidateQ: candidate, diagnostics: output.diagnostics })}`,
      );
      const next = candidate;
      assert(next.length === q.length && next.every(Number.isFinite), "Vitruvian returned an invalid joint target");
      for (const [jointIndex, joint] of (model.joints as Json[]).entries()) {
        assert(next[jointIndex]! >= Number(joint.lower) - 1e-8 && next[jointIndex]! <= Number(joint.upper) + 1e-8, `${String(joint.name)} exceeded the active calibrated limits`);
      }
      q = next;
      const predicted = pose(model, q);
      const errorM = Math.hypot(...targetPosition.map((value, axis) => value - predicted.positionM[axis]!));
      iterations.push({ index: index + 1, status, errorM, diagnostics: output.diagnostics });
      if (errorM <= 0.0015) break;
    }
    const goalPose = pose(model, q);
    const achievedLiftM = goalPose.positionM[2] - currentPose.positionM[2];
    assert(achievedLiftM >= requestedLiftM - 0.002, `Vitruvian only planned ${(achievedLiftM * 1_000).toFixed(1)} mm of the requested ${(requestedLiftM * 1_000).toFixed(1)} mm`);
    return {
      schema: "vitrus.sdk_vitruvian_lift_plan.v1",
      currentPose,
      targetPositionM: targetPosition,
      goalPose,
      requestedLiftM,
      achievedLiftM,
      measuredQ,
      goalQ: q,
      iterations,
      finalDiagnostics: output.diagnostics,
    };
  } finally {
    solver.dispose();
  }
}

function trajectory(startQ: number[], goalQ: number[]): number[][] {
  const maxDeltaDeg = Math.max(...goalQ.map((value, index) => Math.abs(value - startQ[index]!) * 180 / Math.PI));
  const frames = Math.max(20, Math.ceil(maxDeltaDeg / 0.75));
  return Array.from({ length: frames }, (_value, index) => {
    const t = (index + 1) / frames;
    const alpha = t * t * (3 - 2 * t);
    return startQ.map((value, jointIndex) => value + (goalQ[jointIndex]! - value) * alpha);
  });
}

function originSequence(admission: DroidCommandResult): number {
  const result = record(admission.result);
  const value = Number(result.sdkSequence ?? result.sequence ?? admission.requestId);
  assert(Number.isSafeInteger(value) && value > 0, "SDK admission did not preserve a valid origin sequence");
  return value;
}

function assertAdmissionProof(admission: DroidCommandResult, origin: number): void {
  const broker = record(record(admission.result).broker);
  const rejected = Array.isArray(broker.rejected) ? broker.rejected : [];
  const deadman = record(broker.deadman);
  assert(Number(broker.accepted) === ARM_JOINTS.length, `origin ${origin} admitted ${String(broker.accepted)}/${ARM_JOINTS.length} joints`);
  assert(rejected.length === 0, `origin ${origin} has rejected joints: ${JSON.stringify(rejected)}`);
  assert(broker.access_mode === "read_write", `origin ${origin} left broker in ${String(broker.access_mode)}`);
  assert(deadman.active !== true && deadman.latched !== true, `origin ${origin} tripped the broker deadman`);
}

async function waitForArmedScope(edge: GoldenEdgeClient, leaseId: string): Promise<void> {
  const deadline = performance.now() + ARMING_TIMEOUT_MS;
  let last: Json = {};
  while (performance.now() < deadline) {
    last = record(await edge.controlState());
    assert(last.ok !== false, `broker reports an error while arming: ${String(last.error ?? "unknown")}`);
    assert(last.access_mode === "read_write", `broker did not enter read_write: ${String(last.control_phase)}`);
    assert(last.exclusive_lease_id === leaseId, "exclusive lease changed while arming");
    if (last.complete === true) {
      const actual = motors(last).map((row) => String(row.joint_name)).sort();
      const expected = [...ARM_JOINTS].sort();
      if (JSON.stringify(actual) === JSON.stringify(expected)) {
        for (const jointName of ARM_JOINTS) assertMotorReady(motor(last, jointName), jointName);
        return;
      }
    }
    await sleep(25);
  }
  throw new Error(`broker did not arm the complete left-arm scope: ${String(last.control_phase)}/${JSON.stringify(last.missing_joints ?? [])}`);
}

async function waitForStopped(): Promise<Json> {
  const deadline = performance.now() + 6_000;
  let state: Json = {};
  while (performance.now() < deadline) {
    state = await brokerStatus();
    if (state.access_mode === "read_only" && state.global_control === "stop" && state.exclusive_lease_id == null) return state;
    await sleep(50);
  }
  throw new Error(`broker did not stop: ${String(state.access_mode)}/${String(state.control_phase)}/${String(state.exclusive_lease_id)}`);
}

function summarizeMs(samples: number[]): Json {
  const sorted = [...samples].sort((a, b) => a - b);
  assert(sorted.length > 0, "timing samples are empty");
  const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction))]!;
  return { count: sorted.length, min: sorted[0], p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) };
}

async function executePlan(
  droid: Awaited<ReturnType<typeof Droid.connect>>,
  edge: GoldenEdgeClient,
  model: Json,
  plan: Json,
): Promise<Json> {
  const startQ = (plan.measuredQ as number[]).slice();
  let goalQ = (plan.goalQ as number[]).slice();
  const targetPosition = (plan.targetPositionM as number[]).slice() as [number, number, number];
  let trajectoryFrameCount = 0;
  const lease = await droid.control.acquire({
    durationMs: LEASE_DURATION_MS,
    owner: "sdk-hil-left-arm-vitruvian-lift",
    jointNames: [...ARM_JOINTS],
  });
  const admissionMs: number[] = [];
  const stateSamples: Json[] = [];
  const corrections: Json[] = [];
  let released = false;
  let lastOrigin: number | null = null;
  let sentFrames = 0;

  const sendFrame = async (q: number[]): Promise<void> => {
    const started = performance.now();
    const admission = await droid.motion.sendTargets(
      ARM_JOINTS.map((jointName, index) => ({ jointName, displayDeg: q[index]! * 180 / Math.PI })),
      { leaseId: lease.id, ttlMs: TTL_MS },
    );
    admissionMs.push(performance.now() - started);
    sentFrames += 1;
    lastOrigin = originSequence(admission);
    assertAdmissionProof(admission, lastOrigin);
    const remaining = PERIOD_MS - (performance.now() - started);
    if (remaining > 0) await sleep(remaining);
  };

  const sendTrajectory = async (fromQ: number[], toQ: number[]): Promise<void> => {
    const frames = trajectory(fromQ, toQ);
    trajectoryFrameCount += frames.length;
    for (const frame of frames) await sendFrame(frame);
  };

  const hold = async (q: number[], durationMs: number): Promise<void> => {
    const deadline = performance.now() + durationMs;
    while (performance.now() < deadline) {
      await sendFrame(q);
      if (stateSamples.length % 5 === 0) stateSamples.push(record(await edge.controlState()));
      else stateSamples.push({});
    }
  };

  try {
    edge.setLease(lease.id);
    await waitForArmedScope(edge, lease.id);
    for (let index = 0; index < 5; index += 1) await sendFrame(startQ);
    await sendTrajectory(startQ, goalQ);
    await hold(goalQ, GOAL_HOLD_MS);
    for (let pass = 1; pass <= CORRECTION_PASSES; pass += 1) {
      const feedback = record(await edge.controlState());
      const feedbackQ = qFromState(model, feedback);
      const feedbackPose = pose(model, feedbackQ);
      const beforeErrorM = Math.hypot(...targetPosition.map((value, axis) => value - feedbackPose.positionM[axis]!));
      if (beforeErrorM <= 0.003) break;
      const correction = await solveTarget(model, feedbackQ, targetPosition);
      goalQ = (correction.goalQ as number[]).slice();
      corrections.push({ pass, beforeErrorM, plannedPose: correction.goalPose, finalDiagnostics: correction.finalDiagnostics });
      await sendTrajectory(feedbackQ, goalQ);
      await hold(goalQ, CORRECTION_HOLD_MS);
    }
    const underAuthority = record(await edge.controlState());
    const measuredQ = qFromState(model, underAuthority);
    const measuredPose = pose(model, measuredQ);
    const jointErrorDeg = goalQ.map((value, index) => (value - measuredQ[index]!) * 180 / Math.PI);
    const rows = motors(underAuthority);
    for (const jointName of ARM_JOINTS) {
      const row = rows.find((item) => item.joint_name === jointName);
      assert(row, `${jointName} disappeared under authority`);
      assert(row.fault == null && row.stale !== true, `${jointName} faulted during the lift`);
      assert(Number.isSafeInteger(Number(row.applied_origin_sequence)), `${jointName} has no applied origin proof`);
    }
    return {
      leaseId: lease.id,
      frameCount: sentFrames,
      trajectoryFrames: trajectoryFrameCount,
      corrections,
      lastOrigin,
      admissionMs: summarizeMs(admissionMs),
      underAuthority: {
        measuredQ,
        jointErrorDeg,
        maxJointErrorDeg: Math.max(...jointErrorDeg.map(Math.abs)),
        measuredPose,
        cartesianTargetErrorM: Math.hypot(...targetPosition.map((value, axis) => value - measuredPose.positionM[axis]!)),
        estimatedLiftM: measuredPose.positionM[2] - (record(plan.currentPose).positionM as number[])[2]!,
        joints: Object.fromEntries(rows.map((row) => [String(row.joint_name), {
          displayPosDeg: row.display_pos_deg,
          appliedOriginSequence: row.applied_origin_sequence,
          acceptedOriginSequence: row.accepted_origin_sequence,
          feedbackAgeMs: row.feedback_age_ms,
        }])),
      },
    };
  } finally {
    try {
      await droid.control.release(lease.id);
      released = true;
    } finally {
      await waitForStopped();
    }
    assert(released, "left-arm lease was not released");
  }
}

async function main(): Promise<void> {
  const preflight = await freshArmStatus();
  const planner = await loadPlanner(preflight);
  const measuredQ = qFromState(planner.model, preflight);
  const currentPose = pose(planner.model, measuredQ);
  const targetPosition: [number, number, number] = [...currentPose.positionM];
  targetPosition[2] += LIFT_M;
  const plan = await solveTarget(planner.model, measuredQ, targetPosition);
  if (DRY_RUN) {
    console.log(JSON.stringify({ result: "planned", dryRun: true, provenance: planner.provenance, plan }, null, 2));
    return;
  }

  assert(API_KEY, "VITRUS_API_KEY is required");
  const droid = await Droid.connect(DROID_REF, {
    apiKey: API_KEY,
    endpoint: BRIDGE_ENDPOINT,
    clientId: `sdk-hil-r06-vitruvian-lift-${Date.now()}`,
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
  const edge = new GoldenEdgeClient({
    endpoint: EDGE_ENDPOINT,
    robotId: identity.id,
    leaseId: `preflight-${crypto.randomUUID()}`,
    source: "sdk-hil-r06-vitruvian-left-arm-preflight",
  });
  const health = await edge.health();
  assert(health.ok && health.transport === "dora", "Golden Edge Dora gateway is unavailable");
  const execution = await executePlan(droid, edge, planner.model, plan);
  assertReadOnly(await brokerStatus());
  console.log(JSON.stringify({
    result: "passed",
    identity,
    solver: "VitruvianIK",
    chain: "LEFT_ARM_TCP",
    requestedLiftM: LIFT_M,
    provenance: planner.provenance,
    plan,
    execution,
    finalSafety: { accessMode: "read_only", globalControl: "stop", lease: null },
  }, null, 2));
}

await main();
