import Vitrus from "vitrus";

const droidSerial = process.env.VITRUS_DROID_SERIAL ?? "VTRS-R06-2607-R2D2X";
const apiKey = process.env.VITRUS_API_KEY;

if (!droidSerial || !apiKey) {
  throw new Error("Set VITRUS_DROID_SERIAL and VITRUS_API_KEY.");
}

const droid = await Vitrus.Droid.connect(droidSerial, { apiKey });
const telemetry = await droid.telemetry.snapshot();
const motors = (telemetry.raw.motors ?? []) as Array<Record<string, unknown>>;
const wrist = motors.find((motor) => motor.joint_name === "RIGHT_WRIST_B");

if (!wrist) throw new Error("RIGHT_WRIST_B is missing from VitrusOS telemetry.");
if (wrist.clay_can_control !== true) {
  throw new Error(`RIGHT_WRIST_B is not control-ready: ${String(wrist.clay_unavailable_reason ?? "unknown")}`);
}

const startDeg = Number(wrist.display_pos_deg);
if (!Number.isFinite(startDeg)) throw new Error("RIGHT_WRIST_B has no finite live position.");

const lease = await droid.control.acquire({ durationMs: 8_000 });

await droid.motion.sendTargets(
  [{ jointName: "RIGHT_WRIST_B", displayDeg: startDeg + 5 }],
  { leaseId: lease.id },
);

await new Promise<void>((resolve) => setTimeout(resolve, 2_000));

await droid.motion.sendTargets(
  [{ jointName: "RIGHT_WRIST_B", displayDeg: startDeg }],
  { leaseId: lease.id },
);

console.log(`RIGHT_WRIST_B moved from ${startDeg.toFixed(2)}° to ${(startDeg + 5).toFixed(2)}° and returned.`);
