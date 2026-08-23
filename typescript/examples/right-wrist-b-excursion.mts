import { GoldenEdgeClient } from "../src/golden-edge.ts";

const JOINT = "RIGHT_WRIST_B";
const SOURCE = "vitrus-sdk-hil-right-wrist-b";
const ROBOT_ID = process.env.VITRUS_DROID_SERIAL ?? "VTRS-R06-2607-R2D2X";
const EDGE_ENDPOINT = process.env.VITRUS_EDGE_ENDPOINT ?? "http://127.0.0.1:18782";
const BROKER_ENDPOINT = process.env.VITRUS_BROKER_ENDPOINT ?? "http://127.0.0.1:18775";
const EXECUTE = process.argv.includes("--execute");
const PERIOD_MS = 100;
const TTL_MS = 400;
const ARM_TIMEOUT_MS = 10_000;
const CONTROL_PUBLISH_TIMEOUT_MS = 90;
const CONTROL_READ_TIMEOUT_MS = 75;
const CONTROL_CYCLE_BUDGET_MS = 220;
const CLEANUP_TIMEOUT_MS = 5_000;
const MAX_AMPLITUDE_DEG = 1;
const AMPLITUDE_DEG = Number(process.env.VITRUS_HIL_AMPLITUDE_DEG ?? "0.5");
const MAX_FEEDBACK_AGE_MS = 150;
const MAX_ABS_VELOCITY_DEG_S = 15;
const MAX_ABS_TORQUE_NM = 1.5;

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : {};
}

function finite(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} is not finite`);
  return number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function timedFetch(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  timeoutMs = 12_000,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`request exceeded ${timeoutMs} ms`)), timeoutMs);
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

type JsonRequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  allowNotOk?: boolean;
};

async function jsonRequest(
  path: string,
  init?: RequestInit,
  options: JsonRequestOptions = {},
): Promise<Json> {
  const response = await timedFetch(path, init, options.timeoutMs, options.signal);
  const payload = object(await response.json().catch(() => null));
  if (!response.ok || (!options.allowNotOk && payload.ok === false)) {
    throw new Error(`${path} failed (${response.status}): ${String(payload.error ?? response.statusText)}`);
  }
  return payload;
}

function motorRows(payload: Json): Json[] {
  return Array.isArray(payload.motors) ? payload.motors.map(object) : [];
}

function wristFrom(payload: Json): Json {
  const wrist = motorRows(payload).find((motor) => motor.joint_name === JOINT);
  if (!wrist) throw new Error(`${JOINT} is missing from local broker telemetry`);
  return wrist;
}

function validateWrist(wrist: Json): void {
  assert(wrist.connected === true, `${JOINT} is not connected`);
  assert(wrist.calibrated === true, `${JOINT} is not calibrated`);
  assert(!wrist.fault, `${JOINT} fault: ${String(wrist.fault)}`);
  assert(wrist.stale !== true, `${JOINT} feedback is stale`);
  assert(wrist.clay_can_control === true, `${JOINT} is not control-ready: ${String(wrist.clay_unavailable_reason ?? "unknown")}`);
}

async function brokerStatus(options: JsonRequestOptions = {}): Promise<Json> {
  const query = new URLSearchParams({
    fast: "1",
    preflight_joints: JOINT,
    driver_readback_joints: JOINT,
  });
  return jsonRequest(`${BROKER_ENDPOINT}/api/motor-bridge/status?${query}`, undefined, options);
}

async function realtimeState(options: JsonRequestOptions = {}): Promise<Json> {
  return jsonRequest(`${BROKER_ENDPOINT}/api/motor-bridge/realtime-state`, undefined, options);
}

async function setAccessMode(payload: Json, options: JsonRequestOptions = {}): Promise<Json> {
  return jsonRequest(`${BROKER_ENDPOINT}/api/motor-bridge/access-mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }, options);
}

function validateLiveState(state: Json, leaseId: string): Json {
  assert(state.access_mode === "read_write", `broker left read_write: ${String(state.control_phase)}`);
  assert(state.exclusive_lease_id === leaseId, "exclusive lease changed during HIL run");
  assert(state.complete === true, `incomplete feedback: ${JSON.stringify(state.missing_joints ?? [])}`);
  const motors = motorRows(state);
  assert(motors.length === 1 && motors[0]?.joint_name === JOINT, `armed motor set is not exactly ${JOINT}: ${motors.map((motor) => motor.joint_name).join(",")}`);
  const feedbackAgeMs = finite(state.feedback_age_ms, "feedback_age_ms");
  assert(feedbackAgeMs <= MAX_FEEDBACK_AGE_MS, `feedback is ${feedbackAgeMs.toFixed(1)} ms old`);

  const wrist = wristFrom(state);
  validateWrist(wrist);
  const wristFeedbackAgeMs = finite(wrist.feedback_age_ms, `${JOINT}.feedback_age_ms`);
  assert(wristFeedbackAgeMs <= MAX_FEEDBACK_AGE_MS, `${JOINT} feedback is ${wristFeedbackAgeMs.toFixed(1)} ms old`);
  const velocity = Math.abs(finite(wrist.velocity_deg_s ?? wrist.vel_dps, "velocity_deg_s"));
  const torque = Math.abs(finite(wrist.torque_nm ?? wrist.tau, "torque_nm"));
  assert(velocity <= MAX_ABS_VELOCITY_DEG_S, `velocity exceeded ${MAX_ABS_VELOCITY_DEG_S} deg/s: ${velocity.toFixed(2)}`);
  assert(torque <= MAX_ABS_TORQUE_NM, `torque exceeded ${MAX_ABS_TORQUE_NM} Nm: ${torque.toFixed(3)}`);
  return wrist;
}

async function main(): Promise<void> {
  assert(Number.isFinite(AMPLITUDE_DEG) && Math.abs(AMPLITUDE_DEG) > 0, "VITRUS_HIL_AMPLITUDE_DEG must be non-zero and finite");
  assert(Math.abs(AMPLITUDE_DEG) <= MAX_AMPLITUDE_DEG, `amplitude is limited to ${MAX_AMPLITUDE_DEG} degree`);

  const controlAbort = new AbortController();
  const edge = new GoldenEdgeClient({
    endpoint: EDGE_ENDPOINT,
    robotId: ROBOT_ID,
    leaseId: `preflight-${crypto.randomUUID()}`,
    source: SOURCE,
    fetch: (input, init) => timedFetch(input, init, CONTROL_PUBLISH_TIMEOUT_MS, controlAbort.signal),
  });
  const health = await edge.health();
  assert(health.ok && health.transport === "dora", "Golden Edge Dora gateway is unavailable");

  const preflight = await brokerStatus();
  assert(preflight.access_mode === "read_only", `broker is already armed: ${String(preflight.access_mode)}`);
  assert(preflight.global_control === "stop", `global control is not stopped: ${String(preflight.global_control)}`);
  assert(!preflight.error, `broker error: ${String(preflight.error)}`);

  const wrist = wristFrom(preflight);
  validateWrist(wrist);
  const startDeg = finite(wrist.display_pos_deg, "display_pos_deg");
  const calibration = object(wrist.calibration);
  const minDeg = finite(calibration.control_min_deg ?? calibration.min_deg, "control_min_deg");
  const maxDeg = finite(calibration.control_max_deg ?? calibration.max_deg, "control_max_deg");
  const targetDeg = startDeg + AMPLITUDE_DEG;
  assert(targetDeg >= minDeg + 2 && targetDeg <= maxDeg - 2, `target ${targetDeg.toFixed(3)} is too close to calibrated limits`);

  console.log(JSON.stringify({
    preflight: "ok",
    robotId: ROBOT_ID,
    joint: JOINT,
    startDeg,
    targetDeg,
    calibratedRangeDeg: [minDeg, maxDeg],
    gateway: EDGE_ENDPOINT,
  }, null, 2));

  if (!EXECUTE) {
    console.log(`Preflight only. Physical motion requires --execute and VITRUS_HIL_CONFIRM=${JOINT}.`);
    return;
  }
  assert(process.env.VITRUS_HIL_CONFIRM === JOINT, `set VITRUS_HIL_CONFIRM=${JOINT} after checking the workspace and E-stop`);

  const leaseId = `sdk-hil-${crypto.randomUUID()}`;
  edge.setLease(leaseId);
  let armAttempted = false;
  let authorityOwned = false;
  let requestedSignal: string | null = null;

  const waitForStopped = async (): Promise<Json> => {
    const deadline = performance.now() + CLEANUP_TIMEOUT_MS;
    let lastState: Json = {};
    while (performance.now() < deadline) {
      lastState = await realtimeState({ timeoutMs: 500, allowNotOk: true });
      if (
        lastState.access_mode === "read_only"
        && lastState.global_control === "stop"
        && lastState.exclusive_lease_id == null
      ) return lastState;
      await sleep(50);
    }
    throw new Error(`broker failed to stop: mode=${String(lastState.access_mode)} phase=${String(lastState.control_phase)} lease=${String(lastState.exclusive_lease_id)}`);
  };

  const disarm = async (reason: string): Promise<Json> => {
    let requestError: unknown;
    try {
      await setAccessMode(
        { access_mode: "read_only", mode: "read_only", source: `${SOURCE}:${reason}` },
        { timeoutMs: CLEANUP_TIMEOUT_MS, allowNotOk: true },
      );
    } catch (error) {
      requestError = error;
    }
    let result: Json;
    try {
      result = await waitForStopped();
    } catch (verificationError) {
      if (requestError) throw new AggregateError([requestError, verificationError], "release request and verification both failed");
      throw verificationError;
    }
    authorityOwned = false;
    return result;
  };

  const releaseIfOwned = async (reason: string): Promise<Json | null> => {
    let state: Json;
    try {
      state = await realtimeState({ timeoutMs: 500, allowNotOk: true });
    } catch (error) {
      if (authorityOwned) return disarm(`${reason}-state-unavailable`);
      throw error;
    }
    if (state.exclusive_lease_id !== leaseId) {
      if (
        state.exclusive_lease_id == null
        && state.access_mode === "read_only"
        && state.global_control === "stop"
      ) {
        authorityOwned = false;
        return state;
      }
      if (authorityOwned) throw new Error("exclusive authority changed before cleanup");
      return state;
    }
    return disarm(reason);
  };

  const onSignal = (signal: string): void => {
    if (requestedSignal) return;
    requestedSignal = signal;
    controlAbort.abort(new Error(`${signal} requested`));
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  let runError: unknown;
  let cleanupError: unknown;
  let lastSendStartedAt = 0;
  let firstAppliedSeq: number | null = null;
  let lastAppliedSeq: number | null = null;
  let firstGatewaySeq: number | null = null;
  let lastGatewaySeq: number | null = null;
  let maxExcursionDeg = 0;
  let finalActiveDeg = startDeg;

  const waitUntilReady = async (): Promise<Json> => {
    const deadline = performance.now() + ARM_TIMEOUT_MS;
    let lastState: Json = {};
    while (performance.now() < deadline) {
      if (controlAbort.signal.aborted) throw controlAbort.signal.reason;
      lastState = await realtimeState({ timeoutMs: 500, signal: controlAbort.signal });
      assert(lastState.access_mode === "read_write", `broker left read_write during arming: ${String(lastState.control_phase)}`);
      assert(lastState.exclusive_lease_id === leaseId, "exclusive lease changed during arming");
      if (lastState.control_phase === "ready_for_realtime" && lastState.complete === true) {
        validateLiveState(lastState, leaseId);
        return lastState;
      }
      await sleep(50);
    }
    throw new Error(`broker did not become ready: phase=${String(lastState.control_phase)}`);
  };

  try {
    armAttempted = true;
    const armed = await setAccessMode(
      {
        access_mode: "read_write",
        mode: "read_write",
        source: SOURCE,
        joint_names: [JOINT],
        exclusive_lease_id: leaseId,
        exclusive_owner: SOURCE,
      },
      { timeoutMs: ARM_TIMEOUT_MS, signal: controlAbort.signal },
    );
    assert(armed.access_mode === "read_write", `arm failed: ${String(armed.control_phase)}`);
    assert(armed.exclusive_lease_id === leaseId, "broker did not establish the requested exclusive lease");
    authorityOwned = true;
    await waitUntilReady();

    let batchIndex = 0;
    let clientSequence = 0;
    const send = async (displayDeg: number): Promise<void> => {
      if (controlAbort.signal.aborted) throw controlAbort.signal.reason;
      const sendStartedAt = performance.now();
      const gapMs = lastSendStartedAt === 0 ? 0 : sendStartedAt - lastSendStartedAt;
      assert(gapMs === 0 || gapMs <= 240, `command gap exceeded recovery bound: ${gapMs.toFixed(1)} ms`);
      lastSendStartedAt = sendStartedAt;
      const clientSeq = ++clientSequence;

      const ack = await edge.sendJointTargets(
        [{ joint_name: JOINT, position_deg: displayDeg, velocity_deg_s: 2 }],
        { ttlMs: TTL_MS },
      );
      assert(ack.ok && !ack.dropped, `Dora rejected batch: ${String(ack.error ?? ack.dropped)}`);
      const gatewaySeq = finite(ack.sequence, "Dora gateway sequence");
      assert(lastGatewaySeq === null || gatewaySeq > lastGatewaySeq, `Dora gateway sequence did not advance: ${gatewaySeq}`);
      if (firstGatewaySeq === null) firstGatewaySeq = gatewaySeq;
      lastGatewaySeq = gatewaySeq;

      let state: Json;
      let liveWrist: Json;
      let observedAppliedSeq: number | null = null;
      while (true) {
        const remainingBudgetMs = CONTROL_CYCLE_BUDGET_MS - (performance.now() - sendStartedAt);
        assert(remainingBudgetMs > 10, `batch ${clientSeq} exceeded ${CONTROL_CYCLE_BUDGET_MS} ms control budget`);
        state = await realtimeState({
          timeoutMs: Math.max(10, Math.min(CONTROL_READ_TIMEOUT_MS, remainingBudgetMs - 5)),
          signal: controlAbort.signal,
        });
        liveWrist = validateLiveState(state, leaseId);
        const rawAppliedSeq = liveWrist.applied_command_seq ?? liveWrist.applied_seq;
        const parsedAppliedSeq = Number(rawAppliedSeq);
        observedAppliedSeq = Number.isFinite(parsedAppliedSeq) ? parsedAppliedSeq : null;
        if (batchIndex < 5 || (observedAppliedSeq !== null && observedAppliedSeq >= clientSeq)) break;
        await sleep(10);
      }

      if (batchIndex >= 5) {
        const acceptedSeq = finite(liveWrist.accepted_command_seq ?? liveWrist.accepted_seq, "accepted_command_seq");
        const appliedSeq = finite(liveWrist.applied_command_seq ?? liveWrist.applied_seq, "applied_command_seq");
        assert(object(state.deadman).latched !== true, "deadman remained latched after recovery batches");
        assert(acceptedSeq >= clientSeq, `batch ${clientSeq} was published but not accepted`);
        assert(appliedSeq >= clientSeq, `batch ${clientSeq} was published but not applied`);
        if (firstAppliedSeq === null) firstAppliedSeq = appliedSeq;
        lastAppliedSeq = appliedSeq;
      }
      finalActiveDeg = finite(liveWrist.display_pos_deg, "live display_pos_deg");
      maxExcursionDeg = Math.max(maxExcursionDeg, Math.abs(finalActiveDeg - startDeg));
      batchIndex += 1;

      const remainingMs = PERIOD_MS - (performance.now() - sendStartedAt);
      if (remainingMs > 0) await sleep(remainingMs);
    };

    for (let index = 0; index < 8; index += 1) await send(startDeg);
    for (let index = 1; index <= 10; index += 1) await send(startDeg + AMPLITUDE_DEG * index / 10);
    for (let index = 0; index < 5; index += 1) await send(targetDeg);
    for (let index = 1; index <= 10; index += 1) await send(targetDeg - AMPLITUDE_DEG * index / 10);
    for (let index = 0; index < 5; index += 1) await send(startDeg);

    assert(firstAppliedSeq !== null && lastAppliedSeq !== null && lastAppliedSeq > firstAppliedSeq, "no monotonic applied sequence was observed");
    assert(maxExcursionDeg >= Math.min(0.1, Math.abs(AMPLITUDE_DEG) * 0.25), `physical excursion was not observed: ${maxExcursionDeg.toFixed(3)} deg`);
    assert(Math.abs(finalActiveDeg - startDeg) <= 0.35, `joint did not return near start: ${finalActiveDeg.toFixed(3)} deg`);
  } catch (error) {
    runError = error;
  } finally {
    if (armAttempted) {
      try {
        await releaseIfOwned(runError ? "abort" : "complete");
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  const stopped = await brokerStatus({ allowNotOk: true });
  assert(stopped.access_mode === "read_only" && stopped.global_control === "stop", "broker did not return to read_only/stop");
  const stoppedWrist = wristFrom(stopped);
  validateWrist(stoppedWrist);
  const finalDeg = finite(stoppedWrist.display_pos_deg, "final display_pos_deg");

  if (cleanupError) throw cleanupError;
  if (requestedSignal) {
    console.error(`${requestedSignal} received; verified read_only/stop before exit.`);
    process.exitCode = 130;
    return;
  }
  if (runError) throw runError;
  assert(Math.abs(finalDeg - startDeg) <= 0.35, `final read-only position is ${finalDeg.toFixed(3)} deg, expected ${startDeg.toFixed(3)} deg`);

  console.log(JSON.stringify({
    result: "passed",
    joint: JOINT,
    startDeg,
    targetDeg,
    finalDeg,
    maxExcursionDeg,
    firstAppliedSeq,
    lastAppliedSeq,
    firstGatewaySeq,
    lastGatewaySeq,
    finalAccessMode: stopped.access_mode,
    finalGlobalControl: stopped.global_control,
  }, null, 2));
}

await main();
