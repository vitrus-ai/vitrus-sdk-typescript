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

## Read camera calibration

```ts
const calibration = await droid.camera.getCalibration("head_camera");

if (calibration) {
  console.log(calibration.calibrated);
  console.log(calibration.intrinsics?.matrix);
  console.log(calibration.intrinsics?.distortion);
  console.log(calibration.intrinsics?.rectifiedMatrix);
  console.log(calibration.extrinsics?.parentFrame);
  console.log(calibration.extrinsics?.translationM);
  console.log(calibration.extrinsics?.rotationQuaternionXyzw);
}
```

`getCalibration()` combines the live VitrusOS camera calibration with the camera
entry in the active Clay robot description. When available, intrinsics include
the calibrated `K`, fisheye `D`, rectified `new_K`, image size, reprojection
error, and checkerboard metadata. Extrinsics include the parent robot frame,
translation in meters, and XYZW quaternion. Fields that have not been published
by VitrusOS are left undefined. The method returns `null` when no calibration or
camera-description metadata exists.

## Request motion

```ts
const lease = await droid.control.acquire({ durationMs: 5_000 });

await droid.motion.sendTargets(
  [{ jointName: "ARM_JOINT", displayDeg: 5 }],
  { leaseId: lease.id },
);
```

Control requires an authorized API key and a lease. The Vitrus service validates commands before the robot receives them.

## License

Vitrus and its affiliates may use this SDK commercially. Other recipients may
use it only for non-commercial research. Commercial use by another organization
requires written permission from Vitrus. See [LICENSE](LICENSE).
