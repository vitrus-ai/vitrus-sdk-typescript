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
  { leaseId: lease.id },
);
```

Control requires an authorized API key and a lease. The Vitrus service validates commands before the robot receives them.

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
  zenohTopic: "vitrus/servo/targets",
});
```

Zenoh is loaded lazily, so Bridge and Dora users do not initialize the Zenoh WASM runtime. The edge Remote API must be enabled separately; the R-05 currently exposes the native Zenoh peer/router on TCP `7447` and the existing Python Zenoh-to-motor bridge.

## License

Vitrus and its affiliates may use this SDK commercially. Other recipients may
use it only for non-commercial research. Commercial use by another organization
requires written permission from Vitrus. See [LICENSE](LICENSE).
