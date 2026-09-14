import { expect, test } from "bun:test";
import { DirectMotionJobClient } from "./direct-motion";

const response = (value: Record<string, unknown>) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

test("expired auxiliary intent is removed while a fresh compatible arm fragment survives", async () => {
  let now = 1000;
  const sent: Array<Record<string, unknown>> = [];
  const release: Array<(value: Response) => void> = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test", ref: "R06",
    latestOnlyUpdates: true, latestMaxInFlight: 1, now: () => now,
    fetch: ((_url, init) => new Promise<Response>(resolve => {
      sent.push(JSON.parse(String(init?.body)).payload); release.push(resolve);
    })) as typeof fetch,
  });
  const base = { job_id: "job", epoch: 1, controlled_chains: ["left_arm"], ttl_ms: 300, intent_mode: "continuous_setpoint" };
  client.publishLatestUpdate({ ...base, sequence: 1, chain_targets: [], auxiliary_joint_targets: [{ joint: "finger", position: 0 }] });
  now = 1010;
  client.publishLatestUpdate({ ...base, sequence: 2, chain_targets: [], auxiliary_joint_targets: [{ joint: "finger", position: 1 }] });
  now = 1511;
  client.publishLatestUpdate({ ...base, sequence: 3, chain_targets: [{ chain: "left_arm", points: [{ position_m: [0.1, 0, 0] }] }] });
  release[0](response({ ok: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(sent).toHaveLength(2);
  expect(sent[1].sequence).toBe(3);
  expect(sent[1]).not.toHaveProperty("auxiliary_joint_targets");
  expect(sent[1].client_created_at_ms).toBe(1511);
  release[1](response({ ok: true }));
  await client.drainLatestUpdates();
});

test("already expired original app timestamp never becomes a new SDK request", async () => {
  let calls = 0;
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test", ref: "R06", latestOnlyUpdates: true,
    now: () => 1601,
    fetch: (async () => { calls++; return response({ ok: true }); }) as typeof fetch,
  });
  client.publishLatestUpdate({ job_id: "job", epoch: 1, sequence: 1, client_created_at_ms: 1000,
    controlled_chains: ["left_arm"], chain_targets: [{ chain: "left_arm", points: [{ position_m: [0, 0, 0] }] }] });
  await client.drainLatestUpdates();
  expect(calls).toBe(0);
  expect(client.latestUpdateStatus()?.state).toBe("failed");
});

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
  expect(seen).toContainEqual(expect.objectContaining({ inputSequence: 1, state: "receipt_unknown" }));
  expect(client.latestUpdateStatus()).toMatchObject({ jobId: "job", inputSequence: 2, state: "queued" });
});

test("compatible pending chain and auxiliary fragments coalesce as current desired state without retaining an expired sibling", async () => {
  let now = 1_000;
  const bodies: Array<Record<string, unknown>> = [];
  const pending: Array<(response: Response) => void> = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06",
    latestOnlyUpdates: true, latestPendingMaxAgeMs: 500, now: () => now,
    fetch: ((_input, init) => new Promise<Response>((resolve) => {
      bodies.push((JSON.parse(String(init?.body)) as { payload: Record<string, unknown> }).payload);
      pending.push(resolve);
    })) as typeof fetch,
  });
  const frame = (sequence: number, chain: string, position: number) => ({
    job_id: "job", epoch: 1, sequence, controlled_chains: ["left_arm", "right_arm"],
    chain_targets: [{ chain, points: [{ position_m: [position, 0, 0] }] }],
    ttl_ms: 300, intent_mode: "continuous_setpoint", target_liveness_ms: 5_000,
  });
  client.publishLatestUpdate(frame(1, "left_arm", 0.1)); // dispatched
  now += 10;
  client.publishLatestUpdate(frame(2, "right_arm", 0.2)); // retained pending
  now += 10;
  client.publishLatestUpdate(frame(3, "left_arm", 0.3)); // merges with right
  pending[0](response({ ok: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(bodies).toHaveLength(2);
  expect(bodies[1].sequence).toBe(3);
  expect(bodies[1].chain_targets).toEqual([
    { chain: "right_arm", points: [{ position_m: [0.2, 0, 0] }] },
    { chain: "left_arm", points: [{ position_m: [0.3, 0, 0] }] },
  ]);
  pending[1](response({ ok: true }));
  await client.drainLatestUpdates();

  // Two pairs addressed independently while the mailbox is busy remain two
  // atomic groups in the next desired-state snapshot.
  const auxiliaryBodies: Array<Record<string, unknown>> = [];
  const auxiliaryPending: Array<(response: Response) => void> = [];
  const auxiliaryClient = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06",
    latestOnlyUpdates: true, latestPendingMaxAgeMs: 500, now: () => now,
    fetch: ((_input, init) => new Promise<Response>((resolve) => {
      auxiliaryBodies.push((JSON.parse(String(init?.body)) as { payload: Record<string, unknown> }).payload);
      auxiliaryPending.push(resolve);
    })) as typeof fetch,
  });
  const auxiliaryFrame = (sequence: number, targets: unknown[]) => ({
    job_id: "job", epoch: 1, sequence, controlled_chains: ["left_arm", "right_arm"], chain_targets: [],
    auxiliary_joint_targets: targets,
  });
  // The first request occupies the single receipt slot. The next two UI
  // events merge locally, preserving both independently keyed pairs.
  auxiliaryClient.publishLatestUpdate(auxiliaryFrame(1, [{ joint_name: "PROBE", position_deg: 0 }]));
  now += 10;
  auxiliaryClient.publishLatestUpdate(auxiliaryFrame(2, [{ joint_name: "LEFT_BASE", position_deg: 1 }, { joint_name: "RIGHT_BASE", position_deg: -1 }]));
  now += 10;
  auxiliaryClient.publishLatestUpdate(auxiliaryFrame(3, [{ joint_name: "LEFT_DISTAL", position_deg: 2 }, { joint_name: "RIGHT_DISTAL", position_deg: -2 }]));
  auxiliaryPending[0](response({ ok: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(auxiliaryBodies[1]).toMatchObject({ sequence: 3, client_created_at_ms: now });
  expect(auxiliaryBodies[1].auxiliary_joint_targets).toEqual([
    { joint_name: "LEFT_BASE", position_deg: 1 }, { joint_name: "RIGHT_BASE", position_deg: -1 },
    { joint_name: "LEFT_DISTAL", position_deg: 2 }, { joint_name: "RIGHT_DISTAL", position_deg: -2 },
  ]);
  auxiliaryPending[1](response({ ok: true }));
  await auxiliaryClient.drainLatestUpdates();

  // A retained intent retains its own source age.  A newer sibling must not
  // renew it merely by sharing the outgoing latest mailbox envelope.
  const expired: Array<Record<string, unknown>> = [];
  const release: Array<(response: Response) => void> = [];
  const second = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06",
    latestOnlyUpdates: true, latestPendingMaxAgeMs: 500, now: () => now,
    fetch: ((_input, init) => new Promise<Response>((resolve) => {
      expired.push((JSON.parse(String(init?.body)) as { payload: Record<string, unknown> }).payload);
      release.push(resolve);
    })) as typeof fetch,
  });
  second.publishLatestUpdate(frame(4, "left_arm", 0.4));
  now += 10;
  second.publishLatestUpdate(frame(5, "right_arm", 0.5));
  now += 501;
  second.publishLatestUpdate(frame(6, "left_arm", 0.6));
  release[0](response({ ok: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(expired[1].chain_targets).toEqual([{ chain: "left_arm", points: [{ position_m: [0.6, 0, 0] }] }]);
  release[1](response({ ok: true }));
  await second.drainLatestUpdates();
});

test("latest-only delivery keeps the public source deadline at 500 ms", async () => {
  let envelope: { timeout_ms: number } | undefined;
  const client = new DirectMotionJobClient({
    endpoint: "https://vitrus-dataplane.example", apiKey: "test-api-key", ref: "R06",
    latestOnlyUpdates: true, requestTimeoutMs: 20_000,
    fetch: (async (_input, init) => {
      envelope = JSON.parse(String(init?.body)) as { timeout_ms: number };
      return response({ ok: true });
    }) as typeof fetch,
  });
  client.publishLatestUpdate({
    job_id: "job", epoch: 1, sequence: 1, controlled_chains: ["left_arm"],
    chain_targets: [{ chain: "left_arm", points: [{ position_m: [0, 0, 0] }] }],
  });
  await client.drainLatestUpdates();
  expect(envelope).toEqual(expect.objectContaining({ timeout_ms: 500 }));
});

test("latest contract is recursive, retains old source age, omits expired auxiliary, and rejects future source", async () => {
  let now = 1_000;
  const bodies: Record<string, unknown>[] = []; const release: Array<(r: Response) => void> = [];
  const client = new DirectMotionJobClient({ endpoint:"https://x",apiKey:"k",ref:"r",latestOnlyUpdates:true,now:()=>now,
    fetch: ((_i, init) => new Promise<Response>(resolve => { bodies.push((JSON.parse(String(init?.body)) as any).payload); release.push(resolve); })) as typeof fetch });
  const frame=(sequence:number,chain:string, alignment:string, source:number, auxiliary?: unknown[]) => ({job_id:"j",epoch:1,sequence,controlled_chains:["l","r"],chain_targets:[{chain,points:[{position_m:[0,0,0]}]}],alignment_profile:{id:alignment},client_created_at_ms:source,...(auxiliary?{auxiliary_joint_targets:auxiliary}:{})});
  client.publishLatestUpdate(frame(1,"l","a",900,["old"]));
  now=950; client.publishLatestUpdate(frame(2,"r","b",950)); // incompatible nested alignment: replaces, never merges
  release[0](response({ok:true})); await new Promise(r=>setTimeout(r,0));
  expect(bodies[1].chain_targets).toEqual([{chain:"r",points:[{position_m:[0,0,0]}]}]);
  expect(bodies[1]).not.toHaveProperty("auxiliary_joint_targets");
  expect(bodies[1].client_created_at_ms).toBe(950);
  release[1](response({ok:true})); await client.drainLatestUpdates();
  expect(()=>client.publishLatestUpdate(frame(3,"l","a",1001))).toThrow("non-future");
});
