# Vitrus SDK

Connect applications to Vitrus devices.

## Install

```bash
npm install vitrus
```

## Connect to a device

```ts
import Vitrus from "vitrus";

const device = await Vitrus.Device.connect("VTRS-<MODEL>-<YYMM>-<UNIQUE_ID>", {
  apiKey: process.env.VITRUS_API_KEY!,
});

console.log(await device.identity.get());
console.log(await device.telemetry.snapshot());
```

The SDK connects to the deployed Vitrus Bridge dataplane at `https://vitrus-dataplane.onrender.com` by default. Pass `endpoint` only for local development or another Bridge deployment.

The first argument may be a serial, display name/alias, or an object with
`serialNumber`, `deviceId`, or `alias`. Serial matching has priority over
display-name matching in the Bridge. `Droid` and `droidId` remain compatibility
aliases; new client code should use `Device` and `deviceId`.

## Read a camera frame

```ts
const frame = await device.camera.getFrame("head_camera");
```

## Request motion

```ts
await device.control.withSession(
  { owner: "my-controller", jointNames: ["ARM_JOINT"] },
  async (session) => {
    await session.primeAndWaitReady(
      [{ jointName: "ARM_JOINT", displayDeg: measuredDeg }],
      { ttlMs: 2_000, edgeKeepaliveMs: 1_500 },
    );

    await session.sendTargets(
      [{ jointName: "ARM_JOINT", displayDeg: 5 }],
      { ttlMs: 400, edgeKeepaliveMs: 1_500 },
    );
  },
);
```

`openSession()` and `withSession()` are the normal control APIs. A session has
no arbitrary total duration: it renews its short broker lease window only when
the client is actively sending or priming commands. If the client stops being
responsive, renewal stops and VitrusOS returns to `read_only`; the robot-local
deadman and target keepalive remain independent and shorter.

## Revision-bound device model

For a migrated VitrusOS device, read the active model before solving IK or
opening a control session. The snapshot binds the installed configuration,
effective URDF and a monotonic epoch; it is not a client-side profile.

```ts
const configuration = new Vitrus.DeviceConfigurationClient({
  endpoint: "http://r05-edge:8781",
});
const model = await Vitrus.DeviceModelSession.open(configuration);

await device.control.withSession(
  {
    owner: "my-controller",
    jointNames: ["ARM_JOINT"],
    modelBinding: {
      configuration_revision: model.binding.configurationRevision,
      effective_urdf_sha256: model.binding.effectiveUrdfSha256,
      model_epoch: model.binding.modelEpoch,
    },
  },
  async (session) => session.sendTargets([
    { jointName: "ARM_JOINT", displayDeg: 0 }, // effective-URDF coordinate
  ]),
);
```

Use `configuration.preview(patch)` to inspect a semantic calibration patch
without writing, then `configuration.patch(patch)` with the snapshot revision.
After a promotion, discard the old session, refresh the model, re-solve IK, and
acquire a fresh lease. When VitrusOS enables mandatory model binding, a missing
or stale binding is rejected before motor admission.

Raw `acquire` / `renew` / `release` remain available for advanced transport
integration. Their `durationMs` is the bounded broker window, not an intended
motion or application lifetime.

### Semantic effectors

Effectors are discovered from the active robot description, so application
code does not depend on motor count or joint names. The R06 model exposes
`aperture` (`0` closed to `1` open) and `shape` (`-1` precision, `0` parallel,
`1` enveloping):

```ts
const effectors = await device.effectors.list();
const right = effectors.find(({ id }) => id === "right_gripper");
if (!right?.available) throw new Error("Right effector is unavailable");

// Inside the same control-session callback:
await device.effectors.command(
  right.id,
  { aperture: 0.55, shape: 0.25 },
  { leaseId: session.lease.id, ttlMs: 400, maxTorqueNm: 0.25 },
);
```

`maxTorqueNm` is optional. When present it must fall inside the active robot
description's torque-stop policy; VitrusOS validates it again against its local
configuration before commanding hardware.

For simultaneous arm and effector control, attach `effectorCommands` to one
`motion.sendTargets` call. This preserves one atomic latest-target frame. The
SDK includes a preview for admission, but VitrusOS verifies the effector/model
revision and resolves the calibrated motor targets again on the robot.

New anatomies add a versioned `semantic_effector` command model to the robot
manifest. They do not require a new transport contract; a new command type
only requires matching SDK preview and VitrusOS resolver adapters.

Control requires an authorized API key and a lease. The Vitrus service validates commands before the robot receives them.

`ttlMs` is the WAN admission deadline. `edgeKeepaliveMs` is a separate,
explicitly bounded window (maximum 1500 ms) in which a compatible VitrusOS
edge may refresh an admitted positional target locally. Release, E-stop, lease
expiry, or keepalive expiry still cuts the edge to `read_only`.

The default Web/JS control path is the authenticated Bridge. The Bridge and the VitrusOS relay use Zenoh behind the API boundary, so browser clients never need robot IPs or Zenoh endpoints.

For low-latency local control, configure the Golden Edge gateway explicitly:

```ts
const device = await Vitrus.Device.connect("VTRS-<MODEL>-<YYMM>-<UNIQUE_ID>", {
  apiKey: process.env.VITRUS_API_KEY!,
  endpoint: "https://vitrus-dataplane.onrender.com",
  edgeEndpoint: "http://r05-edge:8782",
  motionTransport: "edge",
});
```

This keeps identity and leases on the Bridge while publishing the canonical joint-target contract directly to the edge gateway. Edge mode is opt-in and does not silently retry through the Bridge, preventing duplicate motion commands when the gateway response is ambiguous.

For a Zenoh Remote API WebSocket on the edge, use the same control contract with a persistent Zenoh session:

```ts
const device = await Vitrus.Device.connect("VTRS-<MODEL>-<YYMM>-<UNIQUE_ID>", {
  apiKey: process.env.VITRUS_API_KEY!,
  endpoint: "https://vitrus-dataplane.onrender.com",
  motionTransport: "zenoh",
  zenohEndpoint: "ws://r05-edge:7448",
  zenohTopic: "vitrus/control/joint_targets",
});
```

Zenoh is loaded lazily, so Bridge and Dora users do not initialize the Zenoh WASM runtime. The edge Remote API must be enabled separately; the R-05 currently exposes the native Zenoh peer/router on TCP `7447` and the existing Python Zenoh-to-motor bridge.

## License

Vitrus and its affiliates may use this SDK commercially. Other recipients may
use it only for non-commercial research. Commercial use by another organization
requires written permission from Vitrus. See [LICENSE](LICENSE).

### Continuous TCP targets over the public dataplane

For an enrolled device whose Bridge supports `/v1/droids/motion/direct/latest`,
opt in with `Droid.connect(ref, { apiKey, directLatestOnlyUpdates: true,
directOnLatestUpdate: observation => { /* store receipt or delivery error */ } })`.
The TCP control app enables this with `VITRUS_DIRECT_LATEST_ONLY=1`.

`updateDeviceIkFrame` then returns after local mailbox admission. The SDK keeps
one request in flight and replaces the unsent pending frame with the newest
frame. A public HTTP 202 receipt is queue admission, not native application.
Correlate the SDK input sequence and native command ID with execution and fresh
encoder feedback before asserting motion. Observe asynchronous errors through
`directOnLatestUpdate` or `droid.motion.direct.latestUpdateStatus()`.

The SDK stamps creation time; the Bridge rejects targets older than 500 ms or
more than 100 ms in the future, and expires queued updates by the same source
deadline. Keep the client clock synchronized. Native sequence checks reject
reordering; Hold/Stop discard unsent local targets and retain priority in the
public queue. This mode does not retry a motion through another route.

On updated r05-edge, successive single-point TCP targets are interpolated from
the current Cartesian reference with smoothstep translation and shortest-arc
quaternion interpolation. The native joint tracker additionally enforces its
velocity, acceleration and jerk limits. Unchanged arm targets retain their
existing interpolation curve. Missing intermediate packets are not replayed.
A target that cannot fit the bounded native TTL is rejected; it does not extend
its own deadline. The first target still uses the measured hold and native joint
shaping; this is not a collision-free trajectory planner.

Positions are in metres and quaternions are XYZW. For a 10 mm Y offset use
`0.010`, not `10`. Local interpolation improves motion continuity but cannot
remove network delay or guarantee the rate at which new operator goals arrive.
