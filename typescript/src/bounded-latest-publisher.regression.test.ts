import { expect, test } from "bun:test";
import { DirectMotionJobClient } from "./direct-motion";

const response = (value: Record<string, unknown>) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

test("two public latest requests may be outstanding while later samples remain latest-only", async () => {
  const updates: Array<{ sequence: number; resolve: (response: Response) => void }> = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06",
    latestOnlyUpdates: true, latestMaxInFlight: 2,
    fetch: ((input, init) => {
      if (!new URL(String(input)).pathname.endsWith("/latest")) return Promise.resolve(response({ ok: true }));
      const body = JSON.parse(String(init?.body)) as { payload: { sequence: number } };
      return new Promise<Response>((resolve) => updates.push({ sequence: body.payload.sequence, resolve }));
    }) as typeof fetch,
  });
  client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 1 });
  client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 2 });
  client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 3 });
  expect(updates.map((update) => update.sequence)).toEqual([1, 2]);
  updates[1].resolve(response({ ok: true, input_sequence: 2 }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(updates.map((update) => update.sequence)).toEqual([1, 2, 3]);
  updates[0].resolve(response({ ok: true, input_sequence: 1 }));
  updates[2].resolve(response({ ok: true, input_sequence: 3 }));
  await client.drainLatestUpdates();
});

test("concurrent delivery still never posts an aged unsent latest target", async () => {
  let now = 1_000;
  const started: number[] = [];
  const pending: Array<(response: Response) => void> = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06",
    latestOnlyUpdates: true, latestMaxInFlight: 2, latestPendingMaxAgeMs: 500, now: () => now,
    fetch: ((_input, init) => new Promise<Response>((resolve) => {
      started.push((JSON.parse(String(init?.body)) as { payload: { sequence: number } }).payload.sequence); pending.push(resolve);
    })) as typeof fetch,
  });
  client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 1 });
  client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 2 });
  client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 3 });
  expect(started).toEqual([1, 2]);
  now += 501;
  pending[0](response({ ok: true })); pending[1](response({ ok: true }));
  await client.drainLatestUpdates();
  expect(started).toEqual([1, 2]);
});

test("a late old failure is observable but cannot replace newer public receipt status", async () => {
  const pending: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
  const seen: Array<{ inputSequence: number | null; state: string }> = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06",
    latestOnlyUpdates: true, latestMaxInFlight: 2,
    onLatestUpdate: (observation) => seen.push(observation),
    fetch: (() => new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }))) as typeof fetch,
  });
  client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 1 });
  client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 2 });
  pending[1].resolve(response({ ok: true, input_sequence: 2 }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  pending[0].reject(new Error("old request failed late"));
  await client.drainLatestUpdates().catch(() => undefined);
  expect(seen).toContainEqual(expect.objectContaining({ inputSequence: 1, state: "failed" }));
  expect(client.latestUpdateStatus()).toMatchObject({ jobId: "job", inputSequence: 2, state: "queued" });
});
