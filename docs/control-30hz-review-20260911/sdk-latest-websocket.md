# SDK latest-update WebSocket staging

Staged only in `/Users/lucas-vitrus/Documents/GitHub/vitrus-sdk/typescript`; no deployment, runtime action, restart, or commit occurred.

`Droid.connect` now exposes `directLatestTransport: "websocket"`, `directLatestMaxInFlight`, `directLatestStreamReadyTimeoutMs`, and `directOnLatestStreamTelemetry`; it forwards the same stable Droid client identity and WebSocket factory to `motion.direct`. The default remains HTTP. Lifecycle start, hold, heartbeat, stop, safety stop, status, execution, and feedback retain public correlated HTTP.

A caller prepares the socket separately from a target's 500 ms source-freshness budget:

```ts
const droid = await Droid.connect(ref, {
  apiKey, directLatestOnlyUpdates: true, directLatestTransport: "websocket",
  directLatestMaxInFlight: 16,
});
await droid.motion.direct.prepareLatestStream();
```

The SDK opens `wss://<public-origin>/v1/droids/motion/direct/stream?ref=<encoded-ref>`, sends the API key only in the first `{type:"authenticate", api_key, client_id}` JSON frame, and waits for `{type:"ready"}`. It then emits `{type:"latest_update", request_id, payload, timeout_ms}`. `client_created_at_ms` remains untouched inside `payload`; existing per-chain merge and source-expiry logic still discards stale fragments before wire delivery.

WebSocket receipt capacity defaults to 16 while HTTP remains one. The local pending intent slot remains one merged, per-chain frame. Sends fail and drop if `bufferedAmount` is greater than 64 KiB. The stream has no automatic reconnect or replay: loss rejects outstanding receipt waits, drops unsent current intent, and requires a later explicit application update to make a new socket. Terminal cleanup closes the stream before correlated hold/stop/safety commands.

When `directOnLatestStreamTelemetry` is supplied, the SDK sends exactly one `{type:"subscribe",topics:["telemetry"]}` after each authenticated `{type:"ready"}`. It forwards the Bridge's latest-only `{type:"telemetry",serial,telemetry,received_at_ms}` frame to that callback. When no callback is supplied, it emits no subscribe frame.

Validation: `~/.bun/bin/bun test` completed with 118 passing tests; `./node_modules/.bin/tsc --noEmit` passed. New tests cover credential-free URL/auth-first readiness, per-chain merge, receipt semantics, lost-stream no-replay, terminal cleanup, explicit readiness auth failure, backpressure rejection, sixteen in-flight receipts, and Droid option forwarding.

Adversarial review added coverage for close during `prepareLatestStream`, delayed old-socket callbacks, and a premature ready frame. A close now rejects preparation immediately, and every socket callback is identity-checked so a stale connection cannot revive or send a target. The reviewed Bridge public stream currently matches auth/receipt/error fields, preserves payload source timestamps, and has no telemetry multiplex handler yet; telemetry subscription now follows the confirmed post-ready protocol and is tested.
