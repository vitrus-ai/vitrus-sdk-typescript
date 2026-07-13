# Vitrus SDK

Connect applications to Vitrus droids.

## Install

```bash
npm install vitrus
```

## Connect to a droid

```ts
import Vitrus from "vitrus";

const droid = await Vitrus.Droid.connect("VTRS-R06-2607-R2D2X", {
  apiKey: process.env.VITRUS_API_KEY!,
});

console.log(await droid.identity.get());
console.log(await droid.telemetry.snapshot());
```

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
