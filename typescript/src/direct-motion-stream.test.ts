import { expect, test } from "bun:test";
import { DirectMotionJobClient } from "./direct-motion.js";
import { Droid } from "./droid.js";

class FakeSocket extends EventTarget {
  sent: Record<string, unknown>[] = [];
  closed = false;
  bufferedAmount = 0;
  send(raw: string) { this.sent.push(JSON.parse(raw) as Record<string, unknown>); }
  close() { this.closed = true; this.dispatchEvent(new Event("close")); }
  open() { this.dispatchEvent(new Event("open")); }
  message(value: Record<string, unknown>) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

const frame = (sequence: number, chain: string, sourceAt = 1_000) => ({
  job_id: "job", epoch: 1, sequence, client_created_at_ms: sourceAt,
  controlled_chains: ["left_arm", "right_arm"], ttl_ms: 300, intent_mode: "continuous_setpoint",
  chain_targets: [{ chain, points: [{ position_m: [sequence, 0, 0] }] }],
});

test("websocket latest transport keeps credentials out of the URL, authenticates first, and merges pending chains", async () => {
  let now = 1_000; const sockets: FakeSocket[] = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "secret-api-key", ref: "R06", clientId: "sdk-test",
    latestOnlyUpdates: true, latestTransport: "websocket", now: () => now,
    webSocketFactory: ((url) => { expect(url).toBe("wss://dataplane.example/v1/droids/motion/direct/stream?ref=R06"); const socket = new FakeSocket(); sockets.push(socket); return socket; }) as never,
  });
  client.publishLatestUpdate(frame(1, "left_arm"));
  now += 10; client.publishLatestUpdate(frame(2, "right_arm", now));
  expect(sockets).toHaveLength(1);
  expect(sockets[0].sent).toEqual([]);
  sockets[0].open();
  expect(sockets[0].sent).toEqual([{ type: "authenticate", api_key: "secret-api-key", client_id: "sdk-test" }]);
  sockets[0].message({ type: "ready" });
  expect(sockets[0].sent).toHaveLength(2);
  const sent = sockets[0].sent[1];
  expect(sent).toMatchObject({ type: "latest_update", timeout_ms: 500, payload: { sequence: 2, client_created_at_ms: 1_000 } });
  expect((sent.payload as Record<string, unknown>).chain_targets).toEqual([
    { chain: "left_arm", points: [{ position_m: [1, 0, 0] }] },
    { chain: "right_arm", points: [{ position_m: [2, 0, 0] }] },
  ]);
  sockets[0].message({ type: "receipt", request_id: sent.request_id, result: { state: "queued", input_sequence: 2 } });
  await client.drainLatestUpdates();
  expect(client.latestUpdateStatus()).toMatchObject({ state: "queued", inputSequence: 2 });
});

test("stream loss reports execution unknown, replays nothing, and a later explicit update opens a new stream", async () => {
  const sockets: FakeSocket[] = []; const observations: string[] = []; const errors: string[] = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket", now: () => 1_000,
    onLatestUpdate: (event) => { observations.push(`${event.inputSequence}:${event.state}`); if (event.error) errors.push(event.error); },
    webSocketFactory: (() => { const socket = new FakeSocket(); sockets.push(socket); return socket; }) as never,
  });
  client.publishLatestUpdate(frame(1, "left_arm")); sockets[0].open(); sockets[0].message({ type: "ready" });
  expect(sockets[0].sent).toHaveLength(2);
  sockets[0].close();
  await client.drainLatestUpdates().catch(() => undefined);
  expect(observations).toContain("1:failed");
  expect(errors).toContain("latest-update stream closed before receipt; execution unknown");
  expect(sockets[0].sent).toHaveLength(2);
  client.publishLatestUpdate(frame(2, "right_arm"));
  expect(sockets).toHaveLength(2);
  sockets[1].open(); sockets[1].message({ type: "ready" });
  expect(sockets[1].sent).toHaveLength(2);
});

test("terminal cleanup closes the stream and clears an unsent update before correlated safety stop", async () => {
  const sockets: FakeSocket[] = []; const urls: string[] = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket",
    webSocketFactory: (() => { const socket = new FakeSocket(); sockets.push(socket); return socket; }) as never,
    fetch: (async (input) => { urls.push(new URL(String(input)).pathname); return Response.json({ ok: true }); }) as typeof fetch,
  });
  client.publishLatestUpdate(frame(1, "left_arm"));
  expect(sockets).toHaveLength(1);
  await client.safetyStop("test");
  expect(sockets[0].closed).toBe(true);
  expect(urls).toEqual(["/v1/droids/motion/direct/safety-stop"]);
});

test("MotionJobSession.stop closes an authenticated latest stream before its HTTP terminal command", async () => {
  const sockets: FakeSocket[] = []; const paths: string[] = [];
  const job = { job_id: "job", epoch: 1, mode: "device_ik", state: "active" as const, joint_names: ["LEFT_SHOULDER_A"], configuration_revision: "rev", last_sequence: 0 };
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket", now: () => 1_000,
    webSocketFactory: (() => { const socket = new FakeSocket(); sockets.push(socket); return socket; }) as never,
    fetch: (async (input) => {
      const path = new URL(String(input)).pathname; paths.push(path);
      if (path.endsWith("/start")) return Response.json({ ok: true, job });
      if (path.endsWith("/stop")) return Response.json({ ok: true, stopped: true, job: { ...job, state: "stopped" } });
      return Response.json({ ok: false }, { status: 500 });
    }) as typeof fetch,
  });
  const session = await client.startJob({ mode: "device_ik", owner: "test", jointNames: ["LEFT_SHOULDER_A"] });
  await session.updateDeviceIkFrame({
    controlledChains: ["left_arm"],
    targets: [{ chain: "left_arm", points: [{ position_m: [0, 0, 0] }] }],
    clientCreatedAtMs: 1_000,
  });
  sockets[0].open(); sockets[0].message({ type: "ready" });
  expect(sockets[0].sent).toHaveLength(2);
  await session.stop();
  expect(sockets[0].closed).toBe(true);
  expect(paths).toEqual(["/v1/droids/motion/direct/start", "/v1/droids/motion/direct/stop"]);
});


test("prepareLatestStream has its own readiness failure and never sends a target before ready", async () => {
  const socket = new FakeSocket();
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket",
    latestStreamReadyTimeoutMs: 100, webSocketFactory: (() => socket) as never,
  });
  const ready = client.prepareLatestStream();
  socket.open();
  expect(socket.sent).toEqual([{ type: "authenticate", api_key: "key", client_id: "direct-motion-sdk" }]);
  socket.message({ type: "error", code: "AUTH_FAILED", detail: "invalid API key" });
  await expect(ready).rejects.toThrow("invalid API key");
  expect(socket.sent).toHaveLength(1);
});

test("stream drops a latest frame when its outbound socket buffer exceeds 64 KiB", async () => {
  const socket = new FakeSocket(); const observations: string[] = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket", now: () => 1_000,
    webSocketFactory: (() => socket) as never, onLatestUpdate: (item) => observations.push(item.state),
  });
  const ready = client.prepareLatestStream(); socket.open(); socket.message({ type: "ready" }); await ready;
  socket.bufferedAmount = 65_537;
  client.publishLatestUpdate(frame(1, "left_arm"));
  await client.drainLatestUpdates().catch(() => undefined);
  expect(socket.sent).toHaveLength(1);
  expect(observations).toContain("failed");
});

test("websocket receipt tracking permits sixteen in-flight admissions while pending intent remains merged", async () => {
  const socket = new FakeSocket();
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket", now: () => 1_000,
    webSocketFactory: (() => socket) as never,
  });
  const ready = client.prepareLatestStream(); socket.open(); socket.message({ type: "ready" }); await ready;
  for (let sequence = 1; sequence <= 17; sequence += 1) client.publishLatestUpdate(frame(sequence, sequence % 2 ? "left_arm" : "right_arm"));
  // Auth plus sixteen receipt-bound messages. The seventeenth is the sole pending merged frame.
  expect(socket.sent).toHaveLength(17);
  client.discardLatestUpdates();
});


test("Droid.connect forwards explicit latest WebSocket options to direct motion preparation", async () => {
  const originalFetch = globalThis.fetch; const socket = new FakeSocket();
  globalThis.fetch = (async () => Response.json({ id: "id", serialNumber: "VTRS-R06", model: "r06", displayName: null, organizationId: "org", status: "online", enrollmentState: "enrolled" })) as typeof fetch;
  try {
    const droid = await Droid.connect("VTRS-R06", {
      apiKey: "key", endpoint: "https://dataplane.example", clientId: "droid-sdk", directLatestOnlyUpdates: true,
      directLatestTransport: "websocket", directLatestMaxInFlight: 16, directLatestStreamReadyTimeoutMs: 100,
      directContinuousNetworkTolerance: { sourceMaxAgeMs: 1_200 },
      webSocketFactory: (() => socket) as never,
    });
    const prepared = droid.motion.direct.prepareLatestStream();
    socket.open(); socket.message({ type: "ready", serial: "VTRS-R06" });
    await prepared;
    expect(droid.motion.direct.continuousNetworkTolerance).toEqual({ sourceMaxAgeMs: 1_200 });
    expect(socket.sent).toEqual([{ type: "authenticate", api_key: "key", client_id: "droid-sdk" }]);
    droid.motion.direct.discardLatestUpdates();
  } finally { globalThis.fetch = originalFetch; }
});

test("stream coalesces opt-in telemetry so a receipt is never synchronously behind observer work", async () => {
  const control = new FakeSocket(); const telemetry = new FakeSocket(); let connections = 0; const urls: string[] = []; const samples: Array<{ sample: Record<string, unknown>; connectionEpoch: number }> = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket",
    onLatestStreamTelemetry: (sample) => samples.push(sample), webSocketFactory: ((url) => { urls.push(url); return ++connections === 1 ? control : telemetry; }) as never,
  });
  // The direct-control stream is authenticated without a telemetry
  // subscription. The telemetry-only stream authenticates separately.
  const prepared = client.prepareLatestStream(); control.open(); control.message({ type: "ready" }); await Bun.sleep(0);
  telemetry.open(); telemetry.message({ type: "ready" }); await prepared;
  expect(control.sent).toEqual([
    { type: "authenticate", api_key: "key", client_id: "direct-motion-sdk" },
  ]);
  expect(telemetry.sent).toEqual([
    { type: "authenticate", api_key: "key", client_id: "direct-motion-sdk" },
    { type: "subscribe", topics: ["telemetry"], telemetry_delivery_window: 4 },
  ]);
  expect(urls).toEqual([
    "wss://dataplane.example/v1/droids/motion/direct/stream?ref=R06",
    "wss://dataplane.example/v1/droids/motion/direct/telemetry/stream?ref=R06",
  ]);
  // This is intentionally legacy: it omits delivery-window negotiation and
  // therefore remains unacknowledged even though the SDK requested a window.
  telemetry.message({ type: "subscribed", topics: ["telemetry"] });
  telemetry.message({ type: "telemetry", serial: "R06", telemetry: { sequence: 7, timestamp: "2026-09-11T00:00:00Z" }, received_at_ms: 9_000 });
  telemetry.message({ type: "telemetry", serial: "R06", telemetry: { sequence: 8, timestamp: "2026-09-11T00:00:01Z" }, received_at_ms: 9_001 });
  expect(samples).toEqual([]);
  // Receipt handling remains synchronous and does not wait for a UI observer.
  control.message({ type: "receipt", request_id: "unrelated", result: { state: "queued" } });
  expect(samples).toEqual([]);
  await Bun.sleep(1);
  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({ connectionEpoch: 2, sample: { type: "telemetry", serial: "R06", telemetry: { sequence: 8, timestamp: "2026-09-11T00:00:01Z" }, received_at_ms: 9_001 } });
  expect(samples[0].callbackDispatchLatencyMs).toBeGreaterThanOrEqual(0);
  client.discardLatestUpdates();
});

test("queued telemetry is discarded when the direct stream closes", async () => {
  const control = new FakeSocket(); const telemetry = new FakeSocket(); let connections = 0; const samples: Record<string, unknown>[] = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket",
    onLatestStreamTelemetry: (sample) => samples.push(sample), webSocketFactory: (() => ++connections === 1 ? control : telemetry) as never,
  });
  const prepared = client.prepareLatestStream(); control.open(); control.message({ type: "ready" }); await Bun.sleep(0); telemetry.open(); telemetry.message({ type: "ready" }); await prepared;
  telemetry.message({ type: "telemetry", serial: "R06", telemetry: { sequence: 7 } });
  client.discardLatestUpdates();
  await Bun.sleep(1);
  expect(samples).toEqual([]);
});

test("negotiated telemetry acknowledges each delivery only after its callback settles and stamps local timing", async () => {
  const control = new FakeSocket(); const telemetry = new FakeSocket(); let connections = 0;
  let resolveObserver: (() => void) | undefined;
  let monotonicNow = 10;
  const observations: Array<{ receivedAtMonotonicMs: number; callbackDispatchedAtMonotonicMs: number; callbackDispatchLatencyMs: number }> = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket",
    telemetryMonotonicNow: () => monotonicNow,
    onLatestStreamTelemetry: async (observation) => {
      observations.push(observation);
      await new Promise<void>(resolve => { resolveObserver = resolve; });
    },
    webSocketFactory: (() => ++connections === 1 ? control : telemetry) as never,
  });
  const prepared = client.prepareLatestStream(); control.open(); control.message({ type: "ready" }); await Bun.sleep(0); telemetry.open(); telemetry.message({ type: "ready" }); await prepared;
  expect(telemetry.sent[1]).toEqual({ type: "subscribe", topics: ["telemetry"], telemetry_delivery_window: 4 });
  telemetry.message({ type: "subscribed", topics: ["telemetry"], telemetry_delivery_window: 4 });
  telemetry.message({ type: "telemetry", delivery_seq: 1, telemetry: { sequence: 1 } });
  monotonicNow = 17;
  await Bun.sleep(1);
  expect(observations).toEqual([expect.objectContaining({ receivedAtMonotonicMs: 10, callbackDispatchedAtMonotonicMs: 17, callbackDispatchLatencyMs: 7 })]);
  expect(telemetry.sent).toHaveLength(2);
  resolveObserver?.();
  await Bun.sleep(1);
  expect(telemetry.sent[2]).toEqual({ type: "telemetry_ack", delivery_seq: 1 });
  client.discardLatestUpdates();
});

test("legacy telemetry remains unacknowledged when Bridge omits delivery_seq", async () => {
  const control = new FakeSocket(); const telemetry = new FakeSocket(); let connections = 0; const received: number[] = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket",
    onLatestStreamTelemetry: observation => { received.push((observation.sample.telemetry as { sequence: number }).sequence); },
    webSocketFactory: (() => ++connections === 1 ? control : telemetry) as never,
  });
  const prepared = client.prepareLatestStream(); control.open(); control.message({ type: "ready" }); await Bun.sleep(0); telemetry.open(); telemetry.message({ type: "ready" }); await prepared;
  telemetry.message({ type: "telemetry", telemetry: { sequence: 4 } });
  await Bun.sleep(1);
  expect(received).toEqual([4]);
  expect(telemetry.sent).toEqual([
    { type: "authenticate", api_key: "key", client_id: "direct-motion-sdk" },
    { type: "subscribe", topics: ["telemetry"], telemetry_delivery_window: 4 },
  ]);
  client.discardLatestUpdates();
});

test("sequenced telemetry remains legacy until this socket confirms the requested delivery window", async () => {
  const control = new FakeSocket(); const telemetry = new FakeSocket(); let connections = 0; const received: number[] = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket",
    onLatestStreamTelemetry: observation => { received.push((observation.sample.telemetry as { sequence: number }).sequence); },
    webSocketFactory: (() => ++connections === 1 ? control : telemetry) as never,
  });
  const prepared = client.prepareLatestStream(); control.open(); control.message({ type: "ready" }); await Bun.sleep(0); telemetry.open(); telemetry.message({ type: "ready" }); await prepared;
  telemetry.message({ type: "subscribed", topics: ["telemetry"], telemetry_delivery_window: 3 });
  telemetry.message({ type: "telemetry", delivery_seq: 1, telemetry: { sequence: 1 } });
  await Bun.sleep(1);
  expect(received).toEqual([1]);
  expect(telemetry.sent).toHaveLength(2);
  client.discardLatestUpdates();
});

test("telemetry delivery negotiation is reset on a replacement socket", async () => {
  const control = new FakeSocket(); const first = new FakeSocket(); const replacement = new FakeSocket(); let connections = 0;
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket",
    onLatestStreamTelemetry: () => undefined,
    webSocketFactory: (() => [control, first, replacement][connections++]!) as never,
  });
  const prepared = client.prepareLatestStream(); control.open(); control.message({ type: "ready" }); await Bun.sleep(0); first.open(); first.message({ type: "ready" }); await prepared;
  first.message({ type: "subscribed", topics: ["telemetry"], telemetry_delivery_window: 4 });
  first.message({ type: "telemetry", delivery_seq: 1, telemetry: { sequence: 1 } });
  await Bun.sleep(1);
  expect(first.sent[2]).toEqual({ type: "telemetry_ack", delivery_seq: 1 });
  first.close();
  const replacementReady = client.prepareLatestStream(); await Bun.sleep(0); replacement.open(); replacement.message({ type: "ready" }); await replacementReady;
  replacement.message({ type: "telemetry", delivery_seq: 1, telemetry: { sequence: 2 } });
  await Bun.sleep(1);
  // The second socket did not echo the requested window, so it cannot inherit
  // the first socket's negotiation or ACK its sequenced legacy frame.
  expect(replacement.sent).toEqual([
    { type: "authenticate", api_key: "key", client_id: "direct-motion-sdk" },
    { type: "subscribe", topics: ["telemetry"], telemetry_delivery_window: 4 },
  ]);
  client.discardLatestUpdates();
});

test("sequenced telemetry preserves ACK order when an advisory observer fails", async () => {
  const control = new FakeSocket(); const telemetry = new FakeSocket(); let connections = 0; const delivered: number[] = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket",
    onLatestStreamTelemetry: observation => {
      const sequence = (observation.sample.telemetry as { sequence: number }).sequence;
      delivered.push(sequence);
      if (sequence === 1) throw new Error("observer-only failure");
    },
    webSocketFactory: (() => ++connections === 1 ? control : telemetry) as never,
  });
  const prepared = client.prepareLatestStream(); control.open(); control.message({ type: "ready" }); await Bun.sleep(0); telemetry.open(); telemetry.message({ type: "ready" }); await prepared;
  telemetry.message({ type: "subscribed", topics: ["telemetry"], telemetry_delivery_window: 4 });
  telemetry.message({ type: "telemetry", delivery_seq: 1, telemetry: { sequence: 1 } });
  telemetry.message({ type: "telemetry", delivery_seq: 2, telemetry: { sequence: 2 } });
  await Bun.sleep(3);
  expect(delivered).toEqual([1, 2]);
  expect(telemetry.sent.slice(2)).toEqual([
    { type: "telemetry_ack", delivery_seq: 1 },
    { type: "telemetry_ack", delivery_seq: 2 },
  ]);
  client.discardLatestUpdates();
});

test("telemetry delivery window is bounded before opening a socket", () => {
  expect(() => new DirectMotionJobClient({ endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", telemetryDeliveryWindow: 0 })).toThrow("[1, 8]");
  expect(() => new DirectMotionJobClient({ endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", telemetryDeliveryWindow: 9 })).toThrow("[1, 8]");
});

test("terminal cleanup rejects a pending prepare immediately and stale socket callbacks cannot revive it", async () => {
  const first = new FakeSocket();
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket",
    latestStreamReadyTimeoutMs: 10_000, webSocketFactory: (() => first) as never,
  });
  const prepared = client.prepareLatestStream();
  client.discardLatestUpdates();
  await expect(prepared).rejects.toThrow("closed by client");
  // A browser may deliver a queued event after close; it cannot authenticate or dispatch work.
  first.open(); first.message({ type: "ready" });
  expect(first.sent).toEqual([]);
});

test("late ready from a dead socket cannot send or replace a newly prepared stream", async () => {
  const sockets: FakeSocket[] = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket", now: () => 1_000,
    webSocketFactory: (() => { const socket = new FakeSocket(); sockets.push(socket); return socket; }) as never,
  });
  client.publishLatestUpdate(frame(1, "left_arm")); sockets[0].open(); sockets[0].close();
  client.publishLatestUpdate(frame(2, "right_arm"));
  expect(sockets).toHaveLength(2);
  sockets[0].message({ type: "ready" });
  expect(sockets[0].sent).toHaveLength(1);
  sockets[1].open(); sockets[1].message({ type: "ready" });
  expect(sockets[1].sent).toHaveLength(2);
  client.discardLatestUpdates();
});

test("ready received before the initial auth frame is an explicit authentication failure", async () => {
  const socket = new FakeSocket();
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket",
    webSocketFactory: (() => socket) as never,
  });
  const prepared = client.prepareLatestStream();
  socket.message({ type: "ready" });
  await expect(prepared).rejects.toThrow("before authentication");
  expect(socket.closed).toBe(true);
});

test("a mailbox receipt may arrive after source admission TTL without renewing the wire deadline", async () => {
  const socket = new FakeSocket();
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket", now: () => 1_000,
    webSocketFactory: (() => socket) as never,
  });
  const prepared = client.prepareLatestStream(); socket.open(); socket.message({ type: "ready" }); await prepared;
  client.publishLatestUpdate(frame(1, "left_arm"));
  const sent = socket.sent[1];
  expect(sent.timeout_ms).toBe(500);
  await Bun.sleep(600);
  socket.message({ type: "receipt", request_id: sent.request_id, result: { state: "queued", command_id: 3 } });
  await client.drainLatestUpdates();
  expect(client.latestUpdateStatus()).toMatchObject({ state: "queued", receipt: { command_id: 3 } });
});

test("an absent receipt becomes an explicit unknown-execution observation after the separate receipt budget", async () => {
  const socket = new FakeSocket(); const observations: string[] = [];
  const client = new DirectMotionJobClient({
    endpoint: "https://dataplane.example", apiKey: "key", ref: "R06", latestOnlyUpdates: true, latestTransport: "websocket", now: () => 1_000,
    webSocketFactory: (() => socket) as never, onLatestUpdate: (item) => { if (item.error) observations.push(item.error); },
  });
  const prepared = client.prepareLatestStream(); socket.open(); socket.message({ type: "ready" }); await prepared;
  client.publishLatestUpdate(frame(1, "left_arm"));
  await client.drainLatestUpdates().catch(() => undefined);
  expect(observations).toContain("latest-update receipt unconfirmed after 2000 ms; execution unknown");
});
