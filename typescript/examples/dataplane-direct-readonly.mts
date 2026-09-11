/**
 * Read-only public dataplane probe.  It uses no Edge address, VPN, device
 * token, lease, or motion command.  `status`, `execution`, and `feedback`
 * each wait for their correlated enrolled-Edge read result.
 */
import Vitrus from "../src/index.ts";

const apiKey = process.env.VITRUS_API_KEY?.trim();
const serial = process.env.VITRUS_DROID?.trim();
if (!apiKey) throw new Error("VITRUS_API_KEY is required");
if (!serial) throw new Error("VITRUS_DROID is required");

const droid = await Vitrus.Droid.connect(serial, { apiKey });
const [status, execution, feedback] = await Promise.all([
  droid.motion.direct.status(),
  droid.motion.direct.execution(),
  droid.motion.direct.feedback(),
]);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const job = record(status.job);
const executionRecord = record(execution);
const feedbackRecord = record(feedback);
console.log(JSON.stringify({
  ok: status.ok === true,
  droid: { id: (await droid.identity.get()).id, serialNumber: serial },
  job: {
    id: typeof job.job_id === "string" ? job.job_id : null,
    state: typeof job.state === "string" ? job.state : null,
    mode: typeof job.mode === "string" ? job.mode : null,
  },
  evidence: {
    executionOk: executionRecord.ok === true,
    feedbackOk: feedbackRecord.ok === true,
  },
}, null, 2));
