# Architecture

## Three data planes

### Control

Leases, authorization, emergency stop, command validation and audit travel through the Vitrus Bridge. The browser never receives robot network coordinates.

Semantic effector intent travels inside the same atomic joint-target frame as
arm motion. Robot descriptions own anatomy, variables, profiles, driver scope,
and model revision; the SDK owns the versioned envelope; VitrusOS owns final
calibrated resolution. A revision mismatch, disabled effector, missing preview
joint, or unsupported command type is rejected before broker admission.

### Telemetry

One VitrusOS publisher reads the motor broker and publishes the normalized `vitrus/telemetry/state` stream used by current direct-IP clients. The SDK sends one atomic full-pose command on `vitrus/control/joint_targets`; Web clients receive a normalized snapshot/event stream through the Bridge relay. Any number of subscribers can read the same stream without multiplying hardware reads. Telemetry is sampled independently from the motor loop.

### Camera

Camera frames are bulk data. They use the camera media/frame path and are benchmarked separately from control and telemetry. A 640×480 JPEG may still take hundreds of milliseconds through a cloud Bridge because capture, encoding, upload, base64/JSON and download are all included.

## LAN mesh

When a MacBook and Raspberry Pi 5 are on the same LAN, Zenoh peer discovery can create a direct path:

```text
MacBook Python SDK ── Zenoh peer ── Raspberry Pi 5 VitrusOS
       └────────── Bridge authorization / lease bootstrap ──────────┘
```

The Bridge remains the trust and control-plane authority. After a short authorization/bootstrap exchange, native Python or edge clients use Zenoh directly. Web browsers use the Bridge transport because browser Zenoh uses a WebSocket Remote API and cannot open the native TCP peer path.

The R-05 advertises its reachable `zenohTcp` locator in the droid identity. A Python client bootstraps with the Bridge, reads that locator, and then publishes control targets directly to the LAN peer. The advertised address must be reachable from the client network; do not advertise `127.0.0.1` for a remote peer.

## Why measurements differ

- `sendTargets` measures a control command and must stay low-jitter.
- `telemetry.snapshot` measures one state snapshot, not motor-loop frequency.
- `camera.getFrame` measures a complete image round trip.

Never compare camera latency with a 50 Hz motor tick as if they were the same pipeline.
