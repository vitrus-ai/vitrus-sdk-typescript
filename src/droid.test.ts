import { afterEach, describe, expect, test } from "bun:test";
import { Droid } from "./droid.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Droid camera calibration", () => {
  test("combines VitrusOS fisheye intrinsics with Clay camera extrinsics", async () => {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/droids/resolve") {
        return jsonResponse({
          id: "droid-1",
          serialNumber: "VTRS-R06-2607-R2D2X",
          model: "R06",
          displayName: "R-06",
          organizationId: "org-1",
          status: "online",
          enrollmentState: "enrolled",
        });
      }
      if (url.pathname === "/v1/droids/cameras") {
        return jsonResponse([{
          name: "head_camera",
          fisheye: {
            calibrated: true,
            applies_to_feed: false,
            calibration_path: "/home/vitrus/VitrusOS/config/calibrations/fisheye/head_camera.npz",
            K: [[200, 0, 316], [0, 201, 233], [0, 0, 1]],
            D: [[-0.02], [-0.001], [0.003], [-0.001]],
            new_K: [[210, 0, 320], [0, 210, 240], [0, 0, 1]],
            image_size: [640, 480],
            rms: 0.16,
            checkerboard: [9, 6],
            square_size: 0.024,
          },
        }]);
      }
      if (url.pathname === "/v1/droids/description") {
        return jsonResponse({
          schema: "vitrus.droid.description.v1",
          revisionId: "revision-1",
          source: "clay",
          publishedBy: "vitrus-os",
          publishedAt: "2026-07-13T00:00:00Z",
          cameras: [{
            name: "head_camera",
            parent_link: "NECK_HEAD",
            local_origin: [0.0039, 0.0562, 0.0016],
            local_quaternion_xyzw: [0.7071, 0, 0, 0.7071],
            direction: [0, 1, 0],
            intrinsics: {
              projection: "fisheye",
              focal_length_mm: 2.1,
              fov_deg: 95,
              fps: 30,
              resolution: [1920, 1080],
            },
          }],
        });
      }
      return jsonResponse({ detail: "not found" }, 404);
    };

    const droid = await Droid.connect("VTRS-R06-2607-R2D2X", {
      apiKey: "test-key",
      endpoint: "http://runtime.test",
    });
    const calibration = await droid.camera.getCalibration("head_camera");

    expect(calibration?.calibrated).toBe(true);
    expect(calibration?.appliesToFeed).toBe(false);
    expect(calibration?.intrinsics?.matrix?.[0]).toEqual([200, 0, 316]);
    expect(calibration?.intrinsics?.distortion).toEqual([-0.02, -0.001, 0.003, -0.001]);
    expect(calibration?.intrinsics?.rectifiedMatrix?.[0]).toEqual([210, 0, 320]);
    expect(calibration?.intrinsics?.imageSize).toEqual([640, 480]);
    expect(calibration?.intrinsics?.focalLengthMm).toBe(2.1);
    expect(calibration?.intrinsics?.rmsReprojectionError).toBe(0.16);
    expect(calibration?.extrinsics?.parentFrame).toBe("NECK_HEAD");
    expect(calibration?.extrinsics?.translationM).toEqual([0.0039, 0.0562, 0.0016]);
    expect(calibration?.extrinsics?.rotationQuaternionXyzw).toEqual([0.7071, 0, 0, 0.7071]);
  });

  test("matches a VitrusOS camera alias to a manifest camera suffix", async () => {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/droids/resolve") {
        return jsonResponse({ id: "droid-1" });
      }
      if (url.pathname === "/v1/droids/cameras") {
        return jsonResponse([{ name: "right_wrist", fisheye: { calibrated: false } }]);
      }
      if (url.pathname === "/v1/droids/description") {
        return jsonResponse({
          schema: "vitrus.droid.description.v1",
          revisionId: "revision-1",
          source: "clay",
          publishedBy: "vitrus-os",
          publishedAt: "2026-07-13T00:00:00Z",
          cameras: [],
          manifest: {
            cameras: [{
              name: "right_wrist_camera",
              parent_link: "RIGHT_WRIST_B__terminal",
              local_origin: [0.09, 0.04, 0.02],
              local_quaternion_xyzw: [0.5, -0.5, -0.5, 0.5],
            }],
          },
        });
      }
      return jsonResponse({ detail: "not found" }, 404);
    };

    const droid = await Droid.connect("VTRS-R06-2607-R2D2X", {
      apiKey: "test-key",
      endpoint: "http://runtime.test",
    });
    const calibration = await droid.camera.getCalibration("right_wrist");

    expect(calibration?.calibrated).toBe(false);
    expect(calibration?.extrinsics?.cameraFrame).toBe("right_wrist_camera");
    expect(calibration?.extrinsics?.parentFrame).toBe("RIGHT_WRIST_B__terminal");
  });

  test("returns null when neither calibration nor camera description exists", async () => {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/droids/resolve") return jsonResponse({ id: "droid-1" });
      if (url.pathname === "/v1/droids/cameras") return jsonResponse([{ name: "uncalibrated" }]);
      if (url.pathname === "/v1/droids/description") {
        return jsonResponse({
          schema: "vitrus.droid.description.v1",
          revisionId: "revision-1",
          source: "clay",
          publishedBy: "vitrus-os",
          publishedAt: "2026-07-13T00:00:00Z",
        });
      }
      return jsonResponse({ detail: "not found" }, 404);
    };

    const droid = await Droid.connect("VTRS-R06-2607-R2D2X", {
      apiKey: "test-key",
      endpoint: "http://runtime.test",
    });

    expect(await droid.camera.getCalibration("uncalibrated")).toBeNull();
  });
});
