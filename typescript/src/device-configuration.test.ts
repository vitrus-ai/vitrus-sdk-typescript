import { expect, test } from "bun:test";
import {
  DEVICE_CONFIGURATION_PATCH_SCHEMA,
  DeviceConfigurationClient,
  DeviceConfigurationConflictError,
  DeviceModelSession,
  modelBindingFromSnapshot,
} from "./device-configuration.js";

const revision = "a".repeat(64);
const snapshot = {
  document: {
    schema: "vitrus.device.v1" as const, revision,
    description: { base_urdf: "/models/r06/robot.urdf" },
    hardware: {}, calibration: { joints: { RIGHT_WRIST_B: { channel: "can0", motor_id: 7 } } },
    alignment: { joint_origins: {}, tcp_frames: {} },
  },
};

test("reads the Edge-owned active document", async () => {
  const client = new DeviceConfigurationClient({
    endpoint: "http://r05-edge:8781/",
    fetch: async (input) => {
      expect(String(input)).toBe("http://r05-edge:8781/api/device/configuration");
      return new Response(JSON.stringify(snapshot), { status: 200 });
    },
  });
  expect(await client.get()).toEqual(snapshot);
});

test("keeps authored inspection separate from the aligned control URDF", async () => {
  const requests: string[] = [];
  const client = new DeviceConfigurationClient({
    endpoint: "http://edge",
    fetch: async (input) => {
      requests.push(String(input));
      return new Response("<robot name=\"R06\"/>", { status: 200 });
    },
  });
  await expect(client.getAuthoredUrdf()).resolves.toContain("R06");
  await expect(client.getAuthoredManifest()).resolves.toContain("R06");
  await expect(client.getEffectiveUrdf()).resolves.toContain("R06");
  expect(requests).toEqual([
    "http://edge/api/device/description/base.urdf",
    "http://edge/api/device/description/manifest",
    "http://edge/api/device/description/robot.urdf",
  ]);
});

test("sends a semantic patch with If-Match and no whole-document overwrite", async () => {
  let request: Request | undefined;
  const client = new DeviceConfigurationClient({
    endpoint: "http://edge",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify(snapshot), { status: 200 });
    },
  });
  await client.patch({
    schema: DEVICE_CONFIGURATION_PATCH_SCHEMA,
    base_revision: revision,
    source: { client: "alignment-studio" },
    calibration: { joints: { RIGHT_WRIST_B: { notes: "measured" } } },
  });
  expect(request?.method).toBe("PATCH");
  expect(request?.headers.get("if-match")).toBe(revision);
  expect(await request?.json()).toEqual(expect.objectContaining({ calibration: { joints: { RIGHT_WRIST_B: { notes: "measured" } } } }));
});

test("revisions the robot-level motion profile through the same semantic patch", async () => {
  let body: unknown;
  const client = new DeviceConfigurationClient({
    endpoint: "http://edge",
    fetch: async (input, init) => {
      body = await new Request(input, init).json();
      return new Response(JSON.stringify(snapshot), { status: 200 });
    },
  });
  const profile = {
    enabled: true, preset: "smooth", x1: 0.42, y1: 0, x2: 0.58, y2: 1,
    speed_deg_s: 140, min_duration_s: 0.12, max_duration_s: 2.5,
    apply_to: ["bldc"] as Array<"bldc">,
  };
  await client.patch({
    schema: DEVICE_CONFIGURATION_PATCH_SCHEMA,
    base_revision: revision,
    source: { client: "sdk-control" },
    calibration: { metadata: { global_motion_profile: profile } },
  });
  expect(body).toEqual(expect.objectContaining({
    calibration: { metadata: { global_motion_profile: profile } },
  }));
});

test("surfaces a revision conflict so the UI must rebase", async () => {
  const client = new DeviceConfigurationClient({
    endpoint: "http://edge",
    fetch: async () => new Response(JSON.stringify(snapshot), { status: 409 }),
  });
  await expect(client.patch({
    schema: DEVICE_CONFIGURATION_PATCH_SCHEMA,
    base_revision: revision,
    calibration: { joints: { RIGHT_WRIST_B: { notes: "measured" } } },
  })).rejects.toBeInstanceOf(DeviceConfigurationConflictError);
});

test("pins control to the active Edge model and previews without a write", async () => {
  const model = {
    ...snapshot,
    active: {
      schema: "vitrus.device.active.v1" as const,
      revision,
      model_epoch: 7,
      effective_urdf_sha256: "b".repeat(64),
    },
    effective_urdf: { path: "/var/lib/vitrus/device/revisions/x/description/robot.urdf", sha256: "b".repeat(64) },
  };
  const requests: Array<{ path: string; method: string }> = [];
  const client = new DeviceConfigurationClient({
    endpoint: "http://edge",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, method: init?.method ?? "GET" });
      if (path === "/api/device/model") return new Response(JSON.stringify(model), { status: 200 });
      if (path === "/api/device/configuration/preview") {
        return new Response(JSON.stringify({
          document: model.document,
          lineage: { effective_urdf_sha256: "b".repeat(64) },
          diff: [{ path: "calibration.joints.RIGHT_WRIST_B.notes", before: null, after: "measured" }],
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const session = await DeviceModelSession.open(client);
  expect(session.binding).toEqual({ configurationRevision: revision, effectiveUrdfSha256: "b".repeat(64), modelEpoch: 7 });
  expect(modelBindingFromSnapshot(model)).toEqual(session.binding);
  const preview = await client.preview({
    schema: DEVICE_CONFIGURATION_PATCH_SCHEMA,
    base_revision: revision,
    calibration: { joints: { RIGHT_WRIST_B: { notes: "measured" } } },
  });
  expect(preview.diff).toHaveLength(1);
  expect(requests).toEqual([
    { path: "/api/device/model", method: "GET" },
    { path: "/api/device/configuration/preview", method: "POST" },
  ]);
});

test("refuses to bind control to a legacy snapshot with no model epoch", () => {
  expect(() => modelBindingFromSnapshot(snapshot)).toThrow("effective URDF SHA-256");
});
