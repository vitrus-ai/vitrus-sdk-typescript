# Telemetry-to-browser visual feedback: source audit

**Scope and evidence.** This is a static source audit of the current local checkouts on 2026-09-11. It does not start, stop, or command the robot, and it makes no claim about the cadence root is measuring on r05. File-line references below are the source of the findings. The target is **at least 30 observed visual updates per second when the native source produces them**. A browser cannot truthfully meet that target by rendering invented intermediate poses.

## Root’s bounded live measurements (added after source inspection)

Root recorded the following artifacts beside this report: `mac-cadence.json`, `native-cadence.json`, and `recent-drive-summary.json`. They establish the current transport bounds, while the source audit below explains the mechanisms.

| Observation window | Result | Interpretation and limit |
|---|---:|---|
| r05 Edge stream requested at `max_hz=25` for 15 s | 349 frames, **23.3 Hz**, p95 gap 51 ms, max 72 ms | Confirms the current app request is insufficient for 30 Hz. This counts emitted stream frames; it does **not** prove 349 distinct encoder feedback changes. |
| r05 Edge stream requested at `max_hz=60` | 715 frames, **47.6 Hz**, p95 gap 31 ms, max 65 ms | There is measured stream headroom above 30 Hz. It still needs source-sequence/change analysis before it is described as 47.6-Hz physical feedback. |
| Mac direct Edge SSE at requested 25 Hz | **22.9 Hz**, p95 gap 147 ms, max 667 ms | The request cap and transport have substantial tail jitter. |
| App browser WebSocket | **25.3 Hz**, p95 gap 122 ms, max 290 ms | The local app does not add a fixed 25-Hz pose timer, but it does not eliminate upstream/transport tail gaps. |
| Current fallback payload | about **86 KB** | Even compacted from the historical full status document, degraded fallback is too large and only 4 Hz; it must stay outside the 30-Hz success metric. |
| Recent manual trace | 14 accepted targets; median 367 ms, max 1,809 ms; median RTT 347 ms, max 1,798 ms; 137 received / 17 forward starts / 119 coalesced | Motion-command transport is a separate latency bottleneck. Do not conflate its receipts, coalescing, or source-signed expiry rejections (3 at 580/699/948 ms) with telemetry visual cadence. |

The source plan below therefore proposes a measured `max_hz=60` *canary request* after review, rather than an unsupported claim that 30 is already met. It must be gated by CPU/network profiling and source-sequence provenance; the 30-Hz SLO remains the acceptance target.

## Current production visual path

```
native motor feedback -> r05 Edge `/api/state/motor/stream`
  -> dedicated SSH forward `127.0.0.1:18792 -> r05:8781`
  -> TCP Control singleton SSE pump
  -> cached payload fan-out over local browser WebSocket
  -> validate motors, update joint ref, Canvas demand invalidate
```

The local TCP Control server deliberately owns its telemetry forwarding rather than sharing Alignment Studio ports ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:41)). Status uses an independent `18795 -> r05:8775` SSH transport with `ControlMaster=no`, specifically so an unbounded Edge stream cannot delay the short broker read ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:189)). The visual state stream has its own `18792 -> r05:8781` process ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:212)); configuration still has a separately created `18791 -> r05:8781` process ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:232)). That isolation corrects the earlier shared-forward starvation failure.

There is one singleton SSE pump, started once at server boot ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:810), [server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:2541)). It parses an SSE event, serializes it once, and sends the cached string to each connected local WebSocket client ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:787)). A new browser receives the current cached payload immediately ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:2426)). The primary React client uses this local WebSocket, not a new SSE connection ([App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:1296)).

**Hard present ceiling: 25 Hz.** If no environment override supplies `max_hz`, the server appends `max_hz=25` to the r05 stream URL ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:56)). The UI documents the same 25-Hz premise and throttles React telemetry-panel state to one update per 40 ms ([App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:36)). Therefore the present source configuration cannot satisfy a minimum 30-Hz visual SLO, even if r05 can publish more often. This is the first change to make after r05 source capacity is demonstrated.

The actual 3D pose path itself has no timer cap. Each accepted WS packet updates `jointRadiansRef` and immediately calls the Canvas invalidator ([App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:1267)). The Canvas is `frameloop="demand"` ([App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:869)); the notifier calls `invalidate()` once per accepted sample ([observed-render-notifier.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/observed-render-notifier.ts:1)). This avoids synthetic motion and avoids a continuous render loop. React scene inputs are intentionally stable so high-rate panel state does not rebuild the WebGL tree ([App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:1654)).

## Cadence, queueing, and redundant work

| Segment | Current source behavior | Consequence for a 30-Hz observed visual target |
|---|---|---|
| Edge subscription | Default `max_hz=25`, `profile=control`; explicit URL overrides are preserved ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:56)). | **Blocking cap** at 25 Hz unless configured differently. |
| SSE reconnect | On any termination/error, reconnects after 250 ms ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:837)). | A disconnect necessarily produces a gap much larger than the 33.3-ms target; expose it as a transport outage, do not hide it with interpolation. |
| Browser WebSocket reconnect | Fixed 250-ms reconnect ([App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:1301)). | Same visible outage class. Add reconnect/gap counters to the visual diagnostic. |
| Hot fan-out | SSE pump sends directly to every `realtimeSockets` member, with no explicit latest-only outbound mailbox, buffered-byte metric, or slow-viewer policy ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:787)). | One primary client is cheap. Multiple slow clients can grow transport buffers or per-packet CPU and are presently invisible. Verify Bun WebSocket buffered-amount capability before adding a depth-one latest-only fan-out. |
| Gap filler | A 20-ms loop checks for stream silence, but performs a status GET only after 80 ms silent and no more often than every 250 ms ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:847); [realtime-fallback-policy.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/realtime-fallback-policy.ts:6)). | The normal path has no polling. During degradation its truthful maximum is 4 Hz, so it is continuity/fault indication, never 30-Hz visual feedback. The 50-Hz idle wake-up is modest but needless work; replace it with a next-deadline timer after correctness instrumentation exists. |
| HTTP status pose fallback | Browser requests fast status every 2 s; it is allowed to replace pose only after a 500-ms stream stall and only when its capture time is at least the stream receipt time ([App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:1159); [status-pose-fallback.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/status-pose-fallback.ts:13)). | Good protection against a delayed HTTP pose rewind. It is fallback only and must remain outside the 30-Hz count. |
| Status/control diagnostics | Server caches broker snapshots for 100 ms and control snapshots for 300 ms ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:892), [server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:947)). The IK trace timer runs every 100 ms only while a control WS client exists and suppresses unchanged outputs ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:471)). | Separate from the visual motor stream. Do not raise these polling rates as a response to visual latency. |
| Historical/camera/module requests | History runs on selected joint changes only ([App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:1205)); status is 2 Hz and catalogs 0.2 Hz ([App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:1168), [App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:1184)). | Not a high-rate duplicate telemetry loop. Keep their response bodies and render work isolated from pose delivery. |

## Provenance and misleading-rate issues to correct

1. **Fallback falsifies `sourceLag`.** `realtimeFallbackPacket` assigns `motor_state.ts = receivedAtMs / 1000`, i.e. the application’s receipt time, not a broker capture time ([realtime-fallback-packet.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/realtime-fallback-packet.ts:10)). The browser calculates `sourceLag` from that field and can display zero lag during a stale HTTP fallback ([App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:1286)). Its `jointAge` may still be meaningful, but the logged `sourceLag` is not. Preserve the native capture timestamp if supplied; otherwise report `sourceLag=unknown` and separately label `appReceiptAge` / `fallback`.

2. **Ordering is weaker in the active app than in the SDK utility.** The app server and browser only suppress a sequence equal to the last sequence ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:787), [App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:1224)). A lower old sequence can therefore overwrite a newer observed pose; no epoch identifies a reconnect. By contrast, the SDK’s exported `DeviceTelemetryLatestSampleBuffer` rejects older sequence values within an epoch, permits numbering to restart only on a newer epoch, and records superseded/out-of-order counts ([device-telemetry-stream.ts](/Users/lucas-vitrus/Documents/GitHub/vitrus-sdk/typescript/src/device-telemetry-stream.ts:34)). The active app bypasses that utility, so its stronger semantics do not protect the live visual path. Adopt the same envelope semantics at Edge → app → browser, using a source-provided epoch or incrementing one at each SSE reconnect.

3. **“delivery=N/s” is receiver delivery, not native source rate.** `TelemetryRateWindow` counts browser message arrivals over two seconds ([telemetry-rate.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/telemetry-rate.ts:1)), and the browser labels it `delivery` ([App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:1289)). This is appropriate as a local delivery metric but must never be read as CAN, broker, or Edge sample Hz. Keep it named **browser delivery Hz**, and add separately propagated native/Edge source sequence and cadence fields.

4. **The panel and the pose do not have the same cadence.** The pose ref is updated for every accepted packet; React `liveTelemetry` updates only every 40 ms ([App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:1274)). At a 30-Hz source, the model can move at 30 Hz while numeric rows visibly update at 25 Hz. Set the panel interval to at most `33` ms (or make it one latest-only requestAnimationFrame commit) and explicitly measure its commits.

5. **The camera FPS label is unrelated to joint feedback.** Camera WebRTC is requested at `fps: 30` ([App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:355)) and `FPS DISPLAY` counts decoded video frames via `requestVideoFrameCallback` ([App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:262)). It must remain a camera label; it cannot demonstrate 30-Hz motor telemetry or 3D model updates. Snapshot camera fallback is independently 4 Hz ([App.tsx](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/src/App.tsx:320)).

6. **A legacy server SSE route defeats the singleton model if used.** `/api/vitrusos/realtime/stream` opens another Edge SSE fetch for every HTTP consumer ([server.ts](/Users/lucas-vitrus/Documents/ChatGPT/Vitrus%205/tcp-pivot-control/server.ts:1817)). The current React UI uses `/realtime/ws`, so this is not currently a duplicate. Mark the SSE route diagnostic-only or make it fan out the singleton pump before adding dashboards, recorders, or additional browser consumers.

## SDK and Bridge audit

The SDK supports a public Bridge WebSocket telemetry subscription: it subscribes to the `droids` topic and invokes the listener for each matching `droid.telemetry` event ([droid.ts](/Users/lucas-vitrus/Documents/GitHub/vitrus-sdk/typescript/src/droid.ts:936), [droid.ts](/Users/lucas-vitrus/Documents/GitHub/vitrus-sdk/typescript/src/droid.ts:1139)). It applies no latest-only buffer or `requestAnimationFrame` coalescing in that subscription. The exported buffer is tested and suitable for a *future public-route visual client*, but is not wired into `Droid.telemetry.subscribe` ([device-telemetry-stream.test.ts](/Users/lucas-vitrus/Documents/GitHub/vitrus-sdk/typescript/src/device-telemetry-stream.test.ts:13)).

The public Bridge is not on the current local visual path above. If it is selected later, one source publication first sends a `droid.updated` event and then a `droid.telemetry` event ([droid_routes.py](/Users/lucas-vitrus/Documents/GitHub/vitrus-bridge/src/vitrus_bridge/droid_routes.py:437)). Its generic realtime hub sends to subscribers concurrently, avoiding serialization among browsers ([realtime.py](/Users/lucas-vitrus/Documents/GitHub/vitrus-bridge/src/vitrus_bridge/realtime.py:28)), but it has neither per-topic latest-only mailboxes nor source sequence/epoch enforcement. Do not use that route to meet the 30-Hz SLO until it carries the same envelope, drop counters, and a depth-one telemetry policy.

Bridge camera fan-out is different and already uses per-subscriber depth-one queues ([live_camera.py](/Users/lucas-vitrus/Documents/GitHub/vitrus-bridge/src/vitrus_bridge/live_camera.py:139)). Its `LatestFramePacer` applies a requested consumer `max_fps` ([live_camera.py](/Users/lucas-vitrus/Documents/GitHub/vitrus-bridge/src/vitrus_bridge/live_camera.py:191)). Do not transfer camera FPS measurements or pacing assumptions to motor state.

## Prioritized implementation plan

### P0 — make 30 Hz possible and observable

1. **Prove native/Edge source capacity first.** Root’s live measurement should capture source sequence/capture time, Edge SSE receipt/publish time, and the emitted count for at least a bounded motion-free interval and an active safe canary. If native feedback or Edge production is below 30 Hz, improve that producer before changing browser rendering.
2. **Raise the app request ceiling only after step 1.** Run a bounded source/config canary at `max_hz=60` (the measured request that produced 47.6 emitted frames/s), retain `profile=control`, and change `TELEMETRY_PANEL_INTERVAL_MS` to `33` or an rAF latest-only commit. Keep 60 only if CPU/network and source-sequence instrumentation pass; otherwise choose the lowest request that continuously satisfies the SLO. This is source/config work, not a physical control change.
3. **Add a versioned telemetry envelope to the one active stream.** Required fields: `source_epoch`, monotonic `source_seq`, native `captured_at` when known, Edge/app receipt monotonic time, `transport`, `fallback`, and counters for source/app/browser drops. Reject duplicate and lower `(epoch, seq)` values. Increment epoch on an app SSE reconnect only if Edge cannot supply it. Preserve raw motor rows and measured values.
4. **Correct freshness labels.** Never synthesize native `ts` from app receipt in a fallback. Render `nativeAge=unknown` when source provenance is absent. Present four separate values: native source Hz, Edge→app delivery Hz, app→browser delivery Hz, and rendered visual Hz.

### P1 — bound queues and reduce avoidable work

5. Keep exactly one r05 SSE subscriber in TCP Control. Replace/retire the per-request legacy `/realtime/stream` relay before any new consumer uses it.
6. Implement a tested latest-only outbound mailbox per browser WebSocket, with a bounded buffered-byte/slow-client disconnect policy supported by Bun’s API. Count `superseded_for_client` rather than claiming all source frames rendered.
7. Replace the 20-ms gap-filler polling loop with deadline scheduling: next check at `latestReceipt + 80 ms`, next allowed fallback at `lastFallback + 250 ms`. Preserve its 4-Hz degraded ceiling.
8. Keep the 2-Hz status, 10-Hz conditional IK diagnostic, catalog polling, history, and camera transport out of the pose performance budget. Profile browser main-thread time separately before changing any of them.

### P2 — public SDK/Bridge parity, only when that route is used

9. Wire the SDK `DeviceTelemetryLatestSampleBuffer` (or its tested semantics) into public telemetry consumers, draining one latest sample per render frame. Add source epoch/sequence to Bridge telemetry publication and avoid emitting `droid.updated` on every telemetry-only sample.
10. Give Bridge’s generic telemetry topic a depth-one latest-only policy and delivery/drop diagnostics; retain the existing camera-specific policy separately.

## Proposed acceptance SLO and test plan

Define success only for a continuous healthy-source interval. Do not count fallback packets, HTTP status snapshots, camera frames, or interpolated render frames as source updates.

| Metric | Acceptance target | Instrumentation point |
|---|---:|---|
| Native/Edge distinct source samples | >= 30.0 Hz over 30 s | source epoch/sequence at r05 producer and Edge SSE event |
| Edge SSE → TCP Control accepted samples | >= 30.0 Hz; p95 inter-arrival <= 40 ms | app SSE parser, before fan-out |
| TCP Control → browser accepted samples | >= 30.0 Hz; p95 added transport lag <= 15 ms on local Mac | WS envelope app receipt/browser receipt |
| Observed 3D render commits | >= 30.0 Hz; p95 accepted-packet-to-render <= 33 ms | `invalidate` paired with rAF/renderer frame observation |
| End-to-end observed visual age | p95 <= 100 ms, max <= 150 ms during the 30-s canary | native capture time to browser render; label unknown if clocks/provenance are unavailable |
| Queue loss | zero unaccounted drops; any latest-only supersession separately counted | app fan-out and browser buffer counters |
| Degraded path | shown as degraded within 150 ms; never reported as 30-Hz source | fallback envelope and UI diagnostic |

Tests to add before activation: (a) 31 ordered frames at 33.3 ms produce 30-Hz panel and render measurements; (b) duplicate/lower sequence and late old-epoch frame cannot move the pose backward; (c) reconnect accepts a reset sequence only with a new epoch; (d) a missing native timestamp stays unknown through fallback; (e) a slow browser sees latest frame plus a counted supersession without affecting a fast browser; (f) legacy SSE route cannot create another upstream subscription.

## Offline validation performed

`/Users/lucas-vitrus/.bun/bin/bun test src/observed-render-notifier.test.ts src/telemetry-rate.test.ts src/realtime-fallback-policy.test.ts src/realtime-fallback-packet.test.ts src/status-pose-fallback.test.ts`

Result: **11 passed, 0 failed**. These validate the existing demand invalidate, browser delivery-rate window, bounded fallback policy, compact fallback projection, and status-vs-stream ordering rule. They do not demonstrate a 30-Hz native, Edge, transport, or GPU result.
