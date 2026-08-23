import { Droid, type DroidTelemetry, type JointTarget } from "../src/droid-live.ts";

const endpoint = process.env.VITRUS_DATAPLANE_URL?.trim()
  || "https://vitrus-dataplane.onrender.com";
const apiKey = process.env.VITRUS_API_KEY?.trim();
const droidRef = process.env.VITRUS_DROID_REF?.trim();
const hil = process.env.VITRUS_SMOKE_HIL === "1";
const requestedJoints = (process.env.VITRUS_SMOKE_JOINTS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!apiKey) throw new Error("VITRUS_API_KEY is required");
if (!droidRef) throw new Error("VITRUS_DROID_REF is required");
if (hil && process.env.VITRUS_SMOKE_SAFETY_CONFIRMED !== "workspace-clear-estop-reachable") {
  throw new Error(
    "HIL requires VITRUS_SMOKE_SAFETY_CONFIRMED=workspace-clear-estop-reachable",
  );
}
if (hil && requestedJoints.length === 0) {
  throw new Error("HIL requires an explicit VITRUS_SMOKE_JOINTS allowlist");
}

const droid = await Droid.connect(droidRef, {
  apiKey,
  endpoint,
  clientId: `sdk-dataplane-smoke-${Date.now()}`,
});

function bridge(telemetry: DroidTelemetry): Record<string, unknown> {
  return telemetry.motorBridge ?? {};
}

function summary(telemetry: DroidTelemetry): Record<string, unknown> {
  const status = bridge(telemetry);
  const motors = Array.isArray(status.motors) ? status.motors : [];
  return {
    endpoint,
    droidRef,
    accessMode: status.access_mode ?? null,
    phase: status.control_phase ?? null,
    leaseId: status.exclusive_lease_id ?? null,
    motorCount: motors.length,
    connectedCount: motors.filter((value) =>
      !!value && typeof value === "object" && !Array.isArray(value)
      && (value as Record<string, unknown>).connected === true,
    ).length,
    staleCount: motors.filter((value) =>
      !!value && typeof value === "object" && !Array.isArray(value)
      && (value as Record<string, unknown>).stale === true,
    ).length,
    faultCount: motors.filter((value) =>
      !!value && typeof value === "object" && !Array.isArray(value)
      && Boolean((value as Record<string, unknown>).fault),
    ).length,
    sampleAgeMs: status.sample_age_ms ?? null,
  };
}

function requireHealthyReadOnly(
  telemetry: DroidTelemetry,
  source: string,
  requiredJoints: string[] = [],
): void {
  const status = bridge(telemetry);
  const motors = Array.isArray(status.motors)
    ? status.motors.filter((value): value is Record<string, unknown> =>
        !!value && typeof value === "object" && !Array.isArray(value),
      )
    : [];
  if (status.access_mode !== "read_only" || status.control_phase !== "read_only") {
    throw new Error(
      `${source}: expected read_only/read_only, got `
      + `${String(status.access_mode ?? "unknown")}/${String(status.control_phase ?? "unknown")}`,
    );
  }
  if (status.exclusive_lease_id) {
    throw new Error(`${source}: unexpected active lease ${String(status.exclusive_lease_id)}`);
  }
  if (motors.length === 0) throw new Error(`${source}: no motors in Dataplane telemetry`);
  const disconnected = motors.filter((motor) => motor.connected !== true);
  const faulted = motors.filter((motor) => Boolean(motor.fault));
  if (disconnected.length || faulted.length) {
    throw new Error(
      `${source}: unhealthy motors `
      + `(disconnected=${disconnected.length}, faulted=${faulted.length})`,
    );
  }
  const byName = new Map(motors.map((motor) => [String(motor.joint_name ?? ""), motor]));
  const required = requiredJoints.map((jointName) => {
    const motor = byName.get(jointName);
    if (!motor) throw new Error(`${source}: required motor ${jointName} is missing`);
    return motor;
  });
  const staleRequired = required.filter((motor) => motor.stale === true);
  if (staleRequired.length) {
    throw new Error(`${source}: ${staleRequired.length} required motors have stale feedback`);
  }
  const sampleAgeMs = Number(status.sample_age_ms);
  if (!Number.isFinite(sampleAgeMs) || sampleAgeMs > 500) {
    throw new Error(`${source}: sample age ${String(status.sample_age_ms ?? "missing")} ms exceeds 500 ms`);
  }
  const oldFeedback = (required.length ? required : motors).filter((motor) => {
    const ageMs = Number(motor.feedback_age_ms);
    return Number.isFinite(ageMs) && ageMs > 500;
  });
  if (oldFeedback.length) {
    throw new Error(`${source}: ${oldFeedback.length} motors have feedback older than 500 ms`);
  }
}

async function realtimeSample(timeoutMs = 10_000): Promise<DroidTelemetry> {
  let subscription: { close(): void } | null = null;
  let settled = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settled = true;
      subscription?.close();
      reject(new Error(`no authenticated Dataplane WebSocket telemetry within ${timeoutMs} ms`));
    }, timeoutMs);
    void droid.telemetry.subscribe((telemetry) => {
      settled = true;
      clearTimeout(timer);
      subscription?.close();
      resolve(telemetry);
    }, {
      onStateChange: (state, error) => {
        if (state !== "error") return;
        settled = true;
        clearTimeout(timer);
        subscription?.close();
        reject(error ?? new Error("Dataplane WebSocket entered error state"));
      },
    }).then((value) => {
      subscription = value;
      if (settled) subscription.close();
    }).catch((error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function measuredHold(telemetry: DroidTelemetry): JointTarget[] {
  const status = bridge(telemetry);
  const motors = Array.isArray(status.motors)
    ? status.motors.filter((value): value is Record<string, unknown> =>
        !!value && typeof value === "object" && !Array.isArray(value),
      )
    : [];
  const byName = new Map(motors.map((motor) => [String(motor.joint_name ?? ""), motor]));
  return requestedJoints.map((jointName) => {
    const motor = byName.get(jointName);
    if (!motor) throw new Error(`${jointName}: missing from Dataplane telemetry`);
    if (motor.connected !== true) throw new Error(`${jointName}: not connected`);
    if (motor.stale === true) throw new Error(`${jointName}: feedback is stale`);
    if (motor.fault) throw new Error(`${jointName}: fault=${String(motor.fault)}`);
    if (motor.clay_can_control === false || motor.client_can_control === false) {
      throw new Error(`${jointName}: control is not eligible`);
    }
    const ageMs = Number(motor.feedback_age_ms);
    if (Number.isFinite(ageMs) && ageMs > 250) {
      throw new Error(`${jointName}: feedback age ${ageMs.toFixed(1)} ms exceeds 250 ms`);
    }
    const displayDeg = Number(
      motor.display_pos_deg
      ?? motor.position_deg
      ?? motor.calibrated_angle_deg
      ?? motor.pos_deg,
    );
    if (!Number.isFinite(displayDeg)) throw new Error(`${jointName}: measured angle missing`);
    return { jointName, displayDeg };
  });
}

async function waitReleased(timeoutMs = 10_000): Promise<DroidTelemetry> {
  const startedAt = Date.now();
  let last = await droid.telemetry.snapshot();
  while (Date.now() - startedAt < timeoutMs) {
    const status = bridge(last);
    if (status.access_mode === "read_only" && !status.exclusive_lease_id) return last;
    await Bun.sleep(100);
    last = await droid.telemetry.snapshot();
  }
  const status = bridge(last);
  throw new Error(
    `release was not observed (phase=${String(status.control_phase ?? "unknown")}, `
    + `lease=${String(status.exclusive_lease_id ?? "none")})`,
  );
}

const initial = await droid.telemetry.snapshot();
requireHealthyReadOnly(initial, "HTTP snapshot", requestedJoints);
const realtime = await realtimeSample();
requireHealthyReadOnly(realtime, "WebSocket telemetry", requestedJoints);

if (!hil) {
  console.log(JSON.stringify({
    ok: true,
    mode: "read_only",
    http: summary(initial),
    websocket: summary(realtime),
  }, null, 2));
  process.exit(0);
}

const hold = measuredHold(initial);
const lease = await droid.control.acquire({ durationMs: 30_000, owner: "sdk-dataplane-smoke" });
try {
  const first = await droid.motion.primeAndWaitReady(hold, {
    leaseId: lease.id,
    ttlMs: 5_000,
    edgeKeepaliveMs: 1_000,
    readinessTimeoutMs: 15_000,
    pollIntervalMs: 100,
  });
  const second = await droid.motion.primeAndWaitReady(hold, {
    leaseId: lease.id,
    ttlMs: 5_000,
    edgeKeepaliveMs: 1_000,
    readinessTimeoutMs: 5_000,
    pollIntervalMs: 100,
  });
  console.log(JSON.stringify({
    ok: true,
    mode: "hil-hold-only",
    joints: requestedJoints,
    leaseMatched: first.leaseId === lease.id && second.leaseId === lease.id,
    first: {
      originSequence: first.originSequence,
      accepted: first.acceptedTargetCount,
      applied: first.appliedTargetCount,
      phase: first.phase,
    },
    second: {
      originSequence: second.originSequence,
      accepted: second.acceptedTargetCount,
      applied: second.appliedTargetCount,
      phase: second.phase,
    },
  }, null, 2));
} finally {
  await droid.control.release(lease.id);
  const released = await waitReleased();
  requireHealthyReadOnly(released, "post-release HTTP snapshot", requestedJoints);
  console.log(JSON.stringify({ released: true, final: summary(released) }, null, 2));
}
