# Vitrus SDK

Connect applications to Vitrus droids.

## Install

```bash
npm install vitrus
```

## Connect to a droid

```ts
import Vitrus from "vitrus";

const droid = await Vitrus.Droid.connect("VTRS-<MODEL>-<YYMM>-<UNIQUE_ID>", {
  apiKey: process.env.VITRUS_API_KEY!,
});

console.log(await droid.identity.get());
console.log(await droid.telemetry.snapshot());
```

The SDK connects to the deployed Vitrus Bridge dataplane at `https://vitrus-dataplane.onrender.com` by default. Pass `endpoint` only for local development or another Bridge deployment.

The first argument may be a serial, a display name/alias, or an object with `serialNumber`, `droidId`, or `alias`. Serial matching has priority over display-name matching in the Bridge.

## Read a camera frame

```ts
const frame = await droid.camera.getFrame("head_camera");
```

## Request motion

```ts
const lease = await droid.control.acquire({ durationMs: 5_000 });

await droid.motion.sendTargets(
  [{ jointName: "ARM_JOINT", displayDeg: 5 }],
  { leaseId: lease.id, ttlMs: 400, edgeKeepaliveMs: 1_500 },
);
```

### Semantic effectors

Effectors are discovered from the active robot description, so application
code does not depend on motor count or joint names. The R06 model exposes
`aperture` (`0` closed to `1` open) and `shape` (`-1` precision, `0` parallel,
`1` enveloping):

```ts
const effectors = await droid.effectors.list();
const right = effectors.find(({ id }) => id === "right_gripper");
if (!right?.available) throw new Error("Right effector is unavailable");

await droid.effectors.command(
  right.id,
  { aperture: 0.55, shape: 0.25 },
  { leaseId: lease.id, ttlMs: 400, maxTorqueNm: 0.25 },
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
const droid = await Vitrus.Droid.connect("VTRS-<MODEL>-<YYMM>-<UNIQUE_ID>", {
  apiKey: process.env.VITRUS_API_KEY!,
  endpoint: "https://vitrus-dataplane.onrender.com",
  edgeEndpoint: "http://r05-edge:8782",
  motionTransport: "edge",
});
```

This keeps identity and leases on the Bridge while publishing the canonical joint-target contract directly to the edge gateway. Edge mode is opt-in and does not silently retry through the Bridge, preventing duplicate motion commands when the gateway response is ambiguous.

For a Zenoh Remote API WebSocket on the edge, use the same control contract with a persistent Zenoh session:

```ts
const droid = await Vitrus.Droid.connect("VTRS-<MODEL>-<YYMM>-<UNIQUE_ID>", {
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
