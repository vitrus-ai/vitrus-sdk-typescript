import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_CAMERA_FRAME_OPTIONS, Droid, DroidRequestTimeoutError } from "./droid-live.js";
import { semanticEffectorManifest } from "./effectors.test.js";

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
  test("uses the inspection-image defaults for getFrame(camera)", async () => {
    let requested: URL | null = null;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/droids/resolve") return jsonResponse({ id: "droid-1" });
      if (url.pathname === "/api/dora/cameras/frame") {
        requested = url;
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/jpeg", "x-vitrus-frame-id": "head:42", "x-vitrus-captured-at": "2026-08-27T00:00:00Z" },
        });
      }
      return jsonResponse({ detail: "not found" }, 404);
    };
    const droid = await Droid.connect("R05", { apiKey: "test-key", endpoint: "https://relay.test", edgeCameraEndpoint: "http://edge.test" });
    const frame = await droid.camera.getFrame("head_camera");
    expect(requested?.searchParams.get("width")).toBe(String(DEFAULT_CAMERA_FRAME_OPTIONS.width));
    expect(requested?.searchParams.get("height")).toBe(String(DEFAULT_CAMERA_FRAME_OPTIONS.height));
    expect(requested?.searchParams.get("quality")).toBe(String(DEFAULT_CAMERA_FRAME_OPTIONS.quality));
    expect(requested?.searchParams.get("consistency")).toBe("latest");
    expect(frame.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("opens a realtime stream without a snapshot profile", async () => {
    const calls: URL[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.pathname === "/v1/droids/resolve") return jsonResponse({ id: "droid-1" });
      if (url.pathname === "/api/dora/cameras/streams") return jsonResponse({ id: "stream-1", droidId: "droid-1", camera: "head_camera", expiresAt: "", transport: "webrtc", route: "direct", profile: "realtime", width: 640, height: 360, fps: 30 });
      if (url.pathname === "/api/dora/cameras/offer") return jsonResponse({ sdp: "answer", type: "answer", camera: "head_camera" });
      return jsonResponse({ detail: "not found" }, 404);
    };
    const droid = await Droid.connect("R05", { apiKey: "test-key", endpoint: "https://relay.test", edgeCameraEndpoint: "http://edge.test" });
    const stream = await droid.camera.openStream("head_camera");
    expect(stream.profile).toBe("realtime");
    await stream.negotiate?.({ sdp: "offer", type: "offer" });
    expect(calls.map((url) => url.pathname)).toEqual(["/v1/droids/resolve", "/api/dora/cameras/streams", "/api/dora/cameras/offer"]);
  });

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
  test("separates control-plane timeout and reports the timed-out operation", async () => {
    globalThis.fetch = ((_, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;

    try {
      await Droid.connect("VTRS-R06-2607-R2D2X", {
        apiKey: "test-key",
        endpoint: "https://relay.test",
        controlPlaneTimeoutMs: 5,
        motionAdmissionTimeoutMs: 250,
      });
      throw new Error("expected identity timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(DroidRequestTimeoutError);
      expect(error).toMatchObject({
        code: "VITRUS_REQUEST_TIMEOUT",
        operation: "GET /v1/droids/resolve",
        path: "/v1/droids/resolve",
        timeoutMs: 5,
      });
    }
  });

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
      motionTransport: "bridge",
    });
    await droid.motion.sendTargets(
      [{
        jointName: "LEFT_ELBOW",
        displayDeg: 12,
        maxVelocityDegS: 30,
        maxAccelerationDegS2: 120,
        maxTorqueNm: 0.25,
      }],
      { leaseId: "lease-1", ttlMs: 400, edgeKeepaliveMs: 1_500 },
    );

    expect(command).toMatchObject({
      schema: "vitrus.control.joint_targets",
      schema_version: "0.1.0",
      robot_id: "droid-1",
      lease_id: "lease-1",
      sequence: 1,
      ttl_ms: 400,
      edge_keepalive_ms: 1_500,
      safety: { requires_calibration: true, respect_limits: true },
      targets: [{
        joint_name: "LEFT_ELBOW",
        position_deg: 12,
        velocity_deg_s: 30,
        eased_max_velocity_deg_s: 30,
        eased_max_accel_deg_s: 120,
        max_torque_nm: 0.25,
      }],
    });

    await expect(droid.motion.sendTargets(
      [{ jointName: "LEFT_ELBOW", displayDeg: 12 }],
      { leaseId: "lease-1", ttlMs: 400, edgeKeepaliveMs: 15_001 },
    )).rejects.toThrow("edgeKeepaliveMs must be an integer between 1 and 15000 ms");
  });

  test("sends a discovered semantic effector through the direct SDK API", async () => {
    let command: Record<string, unknown> | null = null;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/droids/resolve") {
        return jsonResponse({
          id: "droid-1",
          serialNumber: "VTRS-R06-2607-R2D2X",
          model: "R06",
          organizationId: "org-1",
          status: "online",
          enrollmentState: "enrolled",
        });
      }
      if (url.pathname === "/v1/droids/description") {
        return jsonResponse({
          schema: "vitrus.droid.description.v1",
          revisionId: "description-7",
          manifest: semanticEffectorManifest,
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
    await droid.effectors.command(
      "right_gripper",
      { aperture: 0.5, shape: 1 },
      { leaseId: "lease-1", ttlMs: 400, maxTorqueNm: 0.2 },
    );

    expect(command).toMatchObject({
      semantic_effectors: {
        schema: "vitrus.control.effectors.v1",
        description_revision_id: "description-7",
        commands: [{
          effector_id: "right_gripper",
          model_id: "r06.opposed_serial_digits",
          model_revision: "1.0.0",
          command_type: "aperture_shape",
          values: { aperture: 0.5, shape: 1 },
          limits: { max_torque_nm: 0.2 },
        }],
      },
      targets: [
        { joint_name: "LEFT_A", percent: 70 },
        { joint_name: "LEFT_B", percent: 30 },
        { joint_name: "RIGHT_A", percent: 30 },
        { joint_name: "RIGHT_B", percent: 70 },
      ],
    });
  });

  test("primes an aligned hold and waits for the exact Edge lease to accept it", async () => {
    let telemetryPolls = 0;
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
      if (url.pathname === "/v1/droids/control/joint-targets") {
        return jsonResponse({ requestId: "hold-1", status: "queued", route: "relay" });
      }
      if (url.pathname === "/v1/droids/telemetry") {
        telemetryPolls += 1;
        const ready = telemetryPolls > 1;
        return jsonResponse({
          schema: "vitrus.motor_bridge.realtime.v1",
          timestamp: new Date().toISOString(),
          access_mode: "read_write",
          control_phase: ready ? "ready_for_realtime" : "holding_current_pose",
          exclusive_lease_id: "lease-1",
          motors: [{
            joint_name: "RIGHT_WRIST_B",
            accepted_origin_sequence: ready ? 1 : null,
            applied_origin_sequence: ready ? 1 : null,
          }],
          // The deployed Dataplane also retains an older raw copy. Root is
          // authoritative and must be recognized without motor_bridge nesting.
          raw: {
            access_mode: "read_write",
            control_phase: ready ? "ready_for_realtime" : "holding_current_pose",
          },
        });
      }
      return jsonResponse({ detail: "not found" }, 404);
    };

    const droid = await Droid.connect("VTRS-R06-2607-R2D2X", {
      apiKey: "test-key",
      endpoint: "https://relay.test",
      motionTransport: "bridge",
    });
    const ready = await droid.motion.primeAndWaitReady(
      [{ jointName: "RIGHT_WRIST_B", displayDeg: -28.2 }],
      {
        leaseId: "lease-1",
        ttlMs: 5_000,
        edgeKeepaliveMs: 1_000,
        readinessTimeoutMs: 1_000,
        pollIntervalMs: 10,
      },
    );

    expect(ready).toMatchObject({
      phase: "ready_for_realtime",
      leaseId: "lease-1",
      acceptedTargetCount: 1,
      appliedTargetCount: 1,
      originSequence: 1,
      admission: { status: "queued", route: "relay" },
    });
    expect(telemetryPolls).toBe(2);
  });

  test("sends one aligned hold while Edge owns local keepalive", async () => {
    let targetAdmissions = 0;
    let telemetryPolls = 0;
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
      if (url.pathname === "/v1/droids/control/joint-targets") {
        targetAdmissions += 1;
        return jsonResponse({ requestId: `hold-${targetAdmissions}`, status: "queued", route: "relay" });
      }
      if (url.pathname === "/v1/droids/telemetry") {
        telemetryPolls += 1;
        const ready = telemetryPolls >= 3;
        return jsonResponse({
          schema: "vitrus.motor_bridge.realtime.v1",
          timestamp: new Date().toISOString(),
          access_mode: ready ? "read_write" : "read_only",
          control_phase: ready ? "ready_for_realtime" : "read_only",
          exclusive_lease_id: ready ? "lease-1" : null,
          motors: [{
            joint_name: "RIGHT_WRIST_B",
            accepted_origin_sequence: ready ? 1 : null,
            applied_origin_sequence: ready ? 1 : null,
          }],
        });
      }
      return jsonResponse({ detail: "not found" }, 404);
    };

    const droid = await Droid.connect("VTRS-R06-2607-R2D2X", {
      apiKey: "test-key",
      endpoint: "https://relay.test",
      motionTransport: "bridge",
    });
    const ready = await droid.motion.primeAndWaitReady(
      [{ jointName: "RIGHT_WRIST_B", displayDeg: -28.2 }],
      {
        leaseId: "lease-1",
        ttlMs: 5_000,
        edgeKeepaliveMs: 50,
        readinessTimeoutMs: 1_000,
        pollIntervalMs: 10,
      },
    );

    expect(targetAdmissions).toBe(1);
    expect(telemetryPolls).toBeGreaterThanOrEqual(3);
    expect(ready.originSequence).toBe(1);
    expect(ready.acceptedTargetCount).toBe(1);
    expect(ready.appliedTargetCount).toBe(1);
  });

  test("continues bounded Edge priming after one transient readiness observation failure", async () => {
    let controlStateReads = 0;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/droids/resolve") {
        return jsonResponse({ id: "droid-1", serialNumber: "VTRS-R06-2607-R2D2X", model: "R06", displayName: "R-06", organizationId: "org-1", status: "online", enrollmentState: "enrolled" });
      }
      if (url.pathname === "/api/dora/joint-targets") {
        return jsonResponse({ ok: true, transport: "broker-direct", stream: "joint_targets", sdkSequence: 1 });
      }
      if (url.pathname === "/api/dora/control-heartbeat") {
        return jsonResponse({ ok: true, transport: "broker-direct", lease_id: "lease-1", hold_active: true });
      }
      if (url.pathname === "/api/dora/control-state") {
        controlStateReads += 1;
        if (controlStateReads === 1) return jsonResponse({ ok: false, error: "timed out" }, 400);
        return jsonResponse({
          ok: true, transport: "broker-direct", access_mode: "read_write", control_phase: "ready_for_realtime", exclusive_lease_id: "lease-1",
          motors: [{ joint_name: "RIGHT_WRIST_B", accepted_origin_sequence: 1, applied_origin_sequence: 1 }],
        });
      }
      return jsonResponse({ detail: `not found: ${url.pathname}` }, 404);
    };

    const droid = await Droid.connect("VTRS-R06-2607-R2D2X", {
      apiKey: "test-key", endpoint: "https://relay.test", edgeEndpoint: "http://edge.test:8782", motionTransport: "edge", motionAdmissionTimeoutMs: 1_000,
    });
    const ready = await droid.motion.primeAndWaitReady(
      [{ jointName: "RIGHT_WRIST_B", displayDeg: -28.2 }],
      { leaseId: "lease-1", ttlMs: 5_000, edgeKeepaliveMs: 1_000, readinessTimeoutMs: 1_000, pollIntervalMs: 10 },
    );

    expect(ready).toMatchObject({ phase: "ready_for_realtime", leaseId: "lease-1", acceptedTargetCount: 1, appliedTargetCount: 1 });
    expect(controlStateReads).toBe(2);
  });

  test("sends motion through the explicit local Golden Edge transport", async () => {
    const requestedPaths: string[] = [];
    let activeEdgeLeaseId = "";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      requestedPaths.push(url.pathname);
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
      if (url.pathname === "/api/dora/joint-targets") {
        const command = JSON.parse(String(init?.body)) as { sequence: number };
        return jsonResponse({ ok: true, transport: "dora", stream: "joint_targets", sequence: command.sequence });
      }
      if (url.pathname === "/api/dora/control-heartbeat") {
        return jsonResponse({ ok: true, transport: "dora", lease_id: activeEdgeLeaseId, hold_active: true });
      }
      if (url.pathname === "/api/dora/control-state") {
        return jsonResponse({
          ok: true,
          transport: "broker-direct",
          access_mode: "read_write",
          control_phase: "ready_for_realtime",
          exclusive_lease_id: activeEdgeLeaseId,
          motors: [{ joint_name: "NECK_HEAD", accepted_origin_sequence: 3, applied_origin_sequence: 3 }],
        });
      }
      if (url.pathname === "/api/dora/acquire") {
        const acquireBody = JSON.parse(String(init?.body)) as { lease_id: string };
        const leaseId = String(acquireBody.lease_id);
        activeEdgeLeaseId = leaseId;
        return jsonResponse({ ok: true, transport: "dora", acquired: true, lease_id: leaseId });
      }
      if (url.pathname === "/api/dora/release") {
        return jsonResponse({ ok: true, transport: "dora", released: true, lease_id: "lease-1" });
      }
      if (url.pathname === "/api/motor-bridge/status") {
        return jsonResponse({
          access_mode: "read_write",
          control_phase: "ready_for_realtime",
          global_control: "drive",
          motors: [{ joint_name: "NECK_HEAD", display_pos_deg: 5, feedback_generation: 7 }],
        });
      }
      if (url.pathname.includes("/v1/droids/control/leases/") && init?.method === "DELETE") {
        return jsonResponse({ released: true });
      }
      return jsonResponse({ detail: "unexpected bridge request" }, 500);
    };

    const droid = await Droid.connect("VTRS-R06-2607-R2D2X", {
      apiKey: "test-key",
      endpoint: "https://relay.test",
      edgeEndpoint: "http://r06-edge:8782",
      edgeTelemetryUrl: "http://r06-edge:8775/api/motor-bridge/status?fast=1",
      motionTransport: "edge",
      controlTransport: "edge",
    });
    const lease = await droid.control.acquire({ durationMs: 30_000, owner: "test", jointNames: ["NECK_HEAD"] });
    const result = await droid.motion.sendTargets(
      [{ jointName: "NECK_HEAD", displayDeg: 5 }],
      { leaseId: lease.id, timeoutMs: 250 },
    );
    const second = await droid.motion.sendTargets(
      [{ jointName: "NECK_HEAD", displayDeg: 6 }],
      { leaseId: lease.id, timeoutMs: 250 },
    );
    const primed = await droid.motion.primeAndWaitReady(
      [{ jointName: "NECK_HEAD", displayDeg: 6 }],
      { leaseId: lease.id, ttlMs: 5_000, edgeKeepaliveMs: 1_000, readinessTimeoutMs: 100, pollIntervalMs: 10 },
    );
    const telemetry = await droid.telemetry.snapshot();
    await droid.control.release(lease.id);

    expect(result).toMatchObject({ status: "acknowledged", route: "local", requestId: "1" });
    expect(second.requestId).toBe("2");
    expect(primed).toMatchObject({ phase: "ready_for_realtime", acceptedTargetCount: 1, appliedTargetCount: 1, originSequence: 3 });
    expect(telemetry.joints.NECK_HEAD?.feedback_generation).toBe(7);
    expect(requestedPaths).toEqual([
      "/v1/droids/resolve",
      "/api/dora/acquire",
      "/api/dora/joint-targets",
      "/api/dora/joint-targets",
      "/api/dora/joint-targets",
      "/api/dora/control-heartbeat",
      "/api/dora/control-state",
      "/api/motor-bridge/status",
      "/api/dora/release",
    ]);
  });

  test("publishes motion through a persistent Zenoh session", async () => {
    const published: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    let opens = 0;
    globalThis.fetch = async (input) => {
      if (new URL(String(input)).pathname === "/v1/droids/resolve") {
        return jsonResponse({ id: "droid-1", serialNumber: "VTRS-R06-2607-R2D2X" });
      }
      return jsonResponse({ detail: "unexpected bridge request" }, 500);
    };

    const droid = await Droid.connect("VTRS-R06-2607-R2D2X", {
      apiKey: "test-key",
      endpoint: "https://relay.test",
      motionTransport: "zenoh",
      zenohEndpoint: "ws://r05-edge:7448",
      zenohSessionFactory: async () => {
        opens += 1;
        return {
          put: async (topic, payload) => published.push({ topic, payload: JSON.parse(payload) }),
          close: async () => undefined,
        };
      },
    });

    const first = await droid.motion.sendTargets([{ jointName: "NECK_HEAD", displayDeg: 5 }], { leaseId: "lease-1" });
    const second = await droid.motion.sendTargets([{ jointName: "NECK_HEAD", displayDeg: 6 }], { leaseId: "lease-1" });

    expect(opens).toBe(1);
    expect(first).toMatchObject({ status: "acknowledged", route: "local", requestId: "1" });
    expect(second.requestId).toBe("2");
    expect(published).toHaveLength(2);
    expect(published[0]).toMatchObject({
      topic: "vitrus/control/joint_targets",
      payload: {
        type: "clay_joint_targets",
        lease_id: "lease-1",
        sequence: 1,
        targets: [{ joint_name: "NECK_HEAD", display_deg: 5 }],
      },
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
    await expect(droid.control.acquire({ durationMs: 30_001 })).rejects.toThrow(
      "durationMs must be an integer in [1000, 30000]",
    );
    await expect(droid.control.renew(lease.id, { durationMs: 999 })).rejects.toThrow(
      "durationMs must be an integer in [1000, 30000]",
    );
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
    const received: Array<{ robot: string; phase: unknown; motors: number }> = [];
    const subscription = await droid.telemetry.subscribe((telemetry) => received.push({
      robot: String(telemetry.raw.robot),
      phase: telemetry.motorBridge?.control_phase,
      motors: Array.isArray(telemetry.motorBridge?.motors) ? telemetry.motorBridge.motors.length : 0,
    }));
    socket.emit("open");
    socket.emit("message", { type: "droid.telemetry", droid: { id: "other", serialNumber: "VTRS-R05-2607-ABCDZ" }, telemetry: { robot: "other" } });
    socket.emit("message", { type: "droid.telemetry", droid: { id: "droid-1", serialNumber: "VTRS-R06-2607-R2D2X" }, telemetry: {
      schema: "vitrus.motor_bridge.realtime.v1",
      timestamp: "2026-07-16T00:00:00Z",
      robot: "R-06",
      access_mode: "read_only",
      control_phase: "read_only",
      motors: [{ joint_name: "RIGHT_WRIST_B" }],
    } });
    expect(received).toEqual([{ robot: "R-06", phase: "read_only", motors: 1 }]);
    expect(JSON.parse(socket.sent[0])).toEqual({ type: "subscribe", topics: ["droids"] });
    subscription.close();
    expect(subscription.state).toBe("closed");
  });
});
