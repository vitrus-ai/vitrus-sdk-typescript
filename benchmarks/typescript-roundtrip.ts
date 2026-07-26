import Vitrus from "../typescript/dist/index.js";

const droidName = process.env.DROID_NAME ?? process.env.VITRUS_DROID;
const apiKey = process.env.VITRUS_API_KEY;
if (!droidName || !apiKey) throw new Error("DROID_NAME/VITRUS_DROID and VITRUS_API_KEY are required");

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};
const stats = (values: number[]) => ({
  count: values.length,
  minMs: +Math.min(...values).toFixed(2),
  p50Ms: +percentile(values, 0.5).toFixed(2),
  p95Ms: +percentile(values, 0.95).toFixed(2),
  maxMs: +Math.max(...values).toFixed(2),
});
const timed = async <T>(operation: () => Promise<T>) => {
  const start = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - start };
};

const connect = await timed(() => Vitrus.Droid.connect(droidName, { apiKey, endpoint: process.env.VITRUS_API_URL }));
const droid = connect.value;
const telemetry = await timed(() => droid.telemetry.snapshot());
const cameraList = await timed(() => droid.camera.list());
const cameras: Record<string, unknown> = {};

for (const camera of cameraList.value) {
  const name = String(camera.name ?? "");
  if (!name) continue;
  const samples: number[] = [];
  let latest: any;
  for (let index = 0; index < 5; index += 1) {
    const result = await timed(() => droid.camera.getFrame(name));
    samples.push(result.ms);
    latest = result.value;
  }
  const bytes = typeof latest?.dataBase64 === "string" ? Buffer.from(latest.dataBase64, "base64").length : null;
  cameras[name] = { stats: stats(samples), width: latest?.width ?? null, height: latest?.height ?? null, bytes };
}

console.log(JSON.stringify({
  droid: droidName,
  planes: {
    control: "Bridge authorization and leases; motion transport is selected by the client",
    telemetry: "Bridge state snapshot",
    camera: "Bridge camera frame round trip",
  },
  connectMs: +connect.ms.toFixed(2),
  telemetry: {
    ms: +telemetry.ms.toFixed(2),
    timestamp: telemetry.value.timestamp,
    jointCount: Object.keys(telemetry.value.joints ?? {}).length,
  },
  cameraList: { ms: +cameraList.ms.toFixed(2), count: cameraList.value.length },
  cameras,
}, null, 2));
