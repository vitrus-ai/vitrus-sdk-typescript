import { afterEach, describe, expect, test } from "bun:test";
import { Droid } from "./droid-live.js";

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

describe("Droid realtime and control sessions", () => {
  test("sends motion with the Golden Dora joint-target contract", async () => {
    let command: Record<string, unknown> | null = null;
    globalThis.fetch = async (input, init) => {
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
      if (url.pathname === "/v1/droids/control/joint-targets") {
        command = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ requestId: "1", status: "queued", route: "relay" });
      }
      return jsonResponse({ detail: "not found" }, 404);
    };

    const droid = await Droid.connect("VTRS-R06-2607-R2D2X", {
      apiKey: "test-key",
      endpoint: "https://relay.test",
    });
    await droid.motion.sendTargets(
      [{ jointName: "LEFT_ELBOW", displayDeg: 12, maxVelocityDegS: 30 }],
      { leaseId: "lease-1", timeoutMs: 400 },
    );

    expect(command).toMatchObject({
      schema: "vitrus.control.joint_targets",
      schema_version: "0.1.0",
      robot_id: "droid-1",
      lease_id: "lease-1",
      sequence: 1,
      ttl_ms: 400,
      safety: { requires_calibration: true, respect_limits: true },
      targets: [{ joint_name: "LEFT_ELBOW", position_deg: 12, velocity_deg_s: 30 }],
    });
  });

  test("lists registered droids using the configured API key", async () => {
    let authorization = "";
    globalThis.fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return jsonResponse([{
        id: "droid-1",
        serialNumber: "VTRS-R06-2607-R2D2X",
        model: "R06",
        displayName: "Assembly R-06",
        organizationId: "org-1",
        status: "online",
        enrollmentState: "enrolled",
      }]);
    };

    const droids = await Droid.list({ apiKey: "test-key", endpoint: "https://relay.test" });

    expect(authorization).toBe("Bearer test-key");
    expect(droids[0].serialNumber).toBe("VTRS-R06-2607-R2D2X");
  });

  test("lists robot devices from the deployed Bridge compatibility contract", async () => {
    const requestedPaths: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
      if (url.pathname === "/v1/droids") return jsonResponse({ detail: "Not Found" }, 404);
      if (url.pathname === "/devices") return jsonResponse({ devices: [
        { id: "device-r06", key: "r06-edge", name: "R-06 Factory", kind: "robot", status: "online", metadata: { serialNumber: "VTRS-R06-2607-R2D2X" } },
        { id: "device-gpu", key: "gpu-box", name: "GPU Box", kind: "computer", status: "online", metadata: {} },
      ] });
      return jsonResponse({ detail: "not found" }, 404);
    };

    const droids = await Droid.list({ apiKey: "test-key", endpoint: "https://vitrus-dataplane.onrender.com" });

    expect(requestedPaths).toEqual(["/v1/droids", "/devices"]);
    expect(droids).toHaveLength(1);
    expect(droids[0]).toMatchObject({ id: "device-r06", serialNumber: "VTRS-R06-2607-R2D2X", status: "online" });
  });

  test("uses typed media sessions and complete lease lifecycle", async () => {
    const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ method: init?.method ?? "GET", path: url.pathname, body });
      if (url.pathname === "/v1/droids/resolve") return jsonResponse({ id: "droid-1", serialNumber: "VTRS-R06-2607-R2D2X" });
      if (url.pathname === "/v1/droids/cameras/sessions" && init?.method === "POST") {
        return jsonResponse({ id: "media-1", droidId: "droid-1", camera: "head_camera", expiresAt: "2026-07-16T01:00:00Z", transport: "webrtc", route: "relay", offerUrl: "https://relay.test/offer", iceServers: [{ urls: ["turn:turn.test"] }] });
      }
      if (url.pathname === "/v1/droids/control/leases" && init?.method === "POST") return jsonResponse({ id: "lease-1", droidId: "droid-1", owner: body.owner, expiresAt: "2026-07-16T01:00:00Z" });
      if (url.pathname.endsWith("/renew")) return jsonResponse({ id: "lease-1", droidId: "droid-1", owner: "clay-test", expiresAt: "2026-07-16T01:00:10Z" });
      if (init?.method === "DELETE") return jsonResponse({ closed: true, released: true });
      return jsonResponse({ detail: "not found" }, 404);
    };

    const droid = await Droid.connect("VTRS-R06-2607-R2D2X", { apiKey: "test-key", endpoint: "https://relay.test", clientId: "clay-test" });
    const media = await droid.camera.openSession("head_camera");
    expect(media.transport).toBe("webrtc");
    expect(media.iceServers?.[0].urls).toEqual(["turn:turn.test"]);
    await droid.camera.closeSession(media.id);
    const lease = await droid.control.acquire({ durationMs: 5_000 });
    expect(lease.owner).toBe("clay-test");
    await droid.control.renew(lease.id, { durationMs: 5_000 });
    await droid.control.release(lease.id);
    expect(requests.some((request) => request.method === "DELETE" && request.path.includes("media-1"))).toBe(true);
    expect(requests.some((request) => request.method === "DELETE" && request.path.includes("lease-1"))).toBe(true);
  });

  test("filters Bridge realtime telemetry to the connected droid", async () => {
    class FakeSocket extends EventTarget {
      sent: string[] = [];
      send(value: string) { this.sent.push(value); }
      close() { this.dispatchEvent(new CloseEvent("close")); }
      emit(type: string, data?: unknown) {
        this.dispatchEvent(type === "message" ? new MessageEvent(type, { data: JSON.stringify(data) }) : new Event(type));
      }
    }
    const socket = new FakeSocket();
    globalThis.fetch = async () => jsonResponse({ id: "droid-1", serialNumber: "VTRS-R06-2607-R2D2X" });
    const droid = await Droid.connect("VTRS-R06-2607-R2D2X", {
      apiKey: "test-key",
      endpoint: "https://relay.test",
      webSocketFactory: () => socket as unknown as WebSocket,
    });
    const received: string[] = [];
    const subscription = await droid.telemetry.subscribe((telemetry) => received.push(String(telemetry.raw.robot)));
    socket.emit("open");
    socket.emit("message", { type: "droid.telemetry", droid: { id: "other", serialNumber: "VTRS-R05-2607-ABCDZ" }, telemetry: { robot: "other" } });
    socket.emit("message", { type: "droid.telemetry", droid: { id: "droid-1", serialNumber: "VTRS-R06-2607-R2D2X" }, telemetry: { schema: "vitrus.telemetry.state.v1", timestamp: "2026-07-16T00:00:00Z", robot: "R-06" } });
    expect(received).toEqual(["R-06"]);
    expect(JSON.parse(socket.sent[0])).toEqual({ type: "subscribe", topics: ["droids"] });
    subscription.close();
    expect(subscription.state).toBe("closed");
  });
});
