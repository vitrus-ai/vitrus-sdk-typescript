import { afterEach, describe, expect, test } from "bun:test";
import { Droid } from "./droid.js";
import { DEVICE_STATUS_SCHEMA, normalizeDeviceStatus, type DeviceStatus } from "./device-status.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fixture(): DeviceStatus {
  return {
    schema: DEVICE_STATUS_SCHEMA,
    schema_version: "1.0.0",
    device_id: "11111111-1111-4111-8111-111111111111",
    serial_number: "VTRS-R06-2607-R2D2X",
    model: "R06",
    timestamp: "2026-08-25T20:00:00Z",
    sequence: 7,
    state: "online",
    connection: { sdk_agent: "connected", bridge: "connected", edge_local: true, last_connected_at: "2026-08-25T19:59:58Z" },
    safety: { state: "safe", estop: false, deadman_active: false, deadman_latched: false, faults: [] },
    control: { mode: "read_only", phase: "read_only", owner: null, lease_id: null, lease_expires_at: null },
    robot: {
      description_revision: `sha256:${"1".repeat(64)}`,
      configuration_revision: `sha256:${"2".repeat(64)}`,
      calibration_revision: `sha256:${"3".repeat(64)}`,
      joint_count: 26,
      available_joint_count: 26,
    },
    telemetry: { schema: "vitrus.telemetry.state.v1", sequence: 9, sampled_at: "2026-08-25T20:00:00Z", age_ms: 12.5, complete: true, stale: false },
    components: { motor_broker: { state: "ok" }, sdk_agent: { state: "ok" } },
    errors: [],
    extensions: { vitrus_os: { release: "test" } },
  };
}

describe("device status contract", () => {
  test("accepts one strict SDK status", () => {
    expect(normalizeDeviceStatus(fixture())).toEqual(fixture());
  });

  test("accepts additive fields without weakening known fields", () => {
    const value = { ...fixture(), future_field: { enabled: true } };
    expect(normalizeDeviceStatus(value).schema).toBe(DEVICE_STATUS_SCHEMA);
  });

  test("rejects unsupported majors and invalid timestamps", () => {
    expect(() => normalizeDeviceStatus({ ...fixture(), schema_version: "2.0.0" })).toThrow("unsupported");
    expect(() => normalizeDeviceStatus({ ...fixture(), timestamp: "not-a-time" })).toThrow("RFC3339");
  });

  test("rejects impossible authority combinations", () => {
    expect(() => normalizeDeviceStatus({
      ...fixture(),
      control: { mode: "read_write", phase: "ready_for_realtime", owner: null, lease_id: null, lease_expires_at: null },
    })).toThrow("requires owner");
    expect(() => normalizeDeviceStatus({
      ...fixture(),
      control: { mode: "read_only", phase: "read_only", owner: "old", lease_id: "old", lease_expires_at: "2026-08-25T20:01:00Z" },
    })).toThrow("cannot expose write authority");
  });

  test("rejects invalid telemetry and counts", () => {
    expect(() => normalizeDeviceStatus({ ...fixture(), robot: { ...fixture().robot, available_joint_count: 27 } })).toThrow("cannot exceed");
    expect(() => normalizeDeviceStatus({ ...fixture(), robot: { ...fixture().robot, configuration_revision: "sha256:not-a-hash" } })).toThrow("SHA-256");
    expect(() => normalizeDeviceStatus({ ...fixture(), telemetry: { ...fixture().telemetry, age_ms: Number.NaN } })).toThrow("finite");
  });

  test("reads the same canonical status from the Edge endpoint", async () => {
    const status = fixture();
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/droids/resolve") {
        return new Response(JSON.stringify({ id: status.device_id, serialNumber: status.serial_number }), { status: 200 });
      }
      if (url.pathname === "/v1/device/status") {
        return new Response(JSON.stringify(status), { status: 200 });
      }
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
    };
    const device = await Droid.connect(status.serial_number, {
      apiKey: "test-key",
      endpoint: "https://bridge.test",
      edgeStatusUrl: "http://edge.test/v1/device/status",
    });
    expect(await device.status.snapshot()).toEqual(status);
  });
});
