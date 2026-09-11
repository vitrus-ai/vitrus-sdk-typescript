import { afterEach, describe, expect, test } from "bun:test";
import Vitrus, { Device, Droid, type DeviceIdentity, type DeviceTelemetry } from "./index.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("device-first public API", () => {
  test("exposes Device as the canonical name without breaking Droid clients", () => {
    expect(Device).toBe(Droid);
    expect(Vitrus.Device).toBe(Device);
    expect(Vitrus.Droid).toBe(Device);
  });

  test("accepts deviceId and preserves the legacy wire query", async () => {
    let requested: URL | null = null;
    globalThis.fetch = async (input) => {
      requested = new URL(String(input));
      return new Response(JSON.stringify({
        id: "device-1",
        serialNumber: "VTRS-R06-2607-R2D2X",
        model: "R06",
        displayName: "R06",
        organizationId: "org-1",
        status: "online",
        enrollmentState: "enrolled",
      } satisfies DeviceIdentity), { status: 200, headers: { "content-type": "application/json" } });
    };

    const device = await Device.connect(
      { deviceId: "device-1" },
      { apiKey: "test-key", endpoint: "https://relay.test" },
    );
    expect((await device.identity.get()).id).toBe("device-1");
    expect(requested?.searchParams.get("droid_id")).toBe("device-1");
  });

  test("exports canonical Device telemetry types", () => {
    const telemetry: DeviceTelemetry = {
      schema: "vitrus.device.telemetry.v1",
      timestamp: "2026-08-24T00:00:00.000Z",
      raw: {},
    };
    expect(telemetry.schema).toContain("device");
  });
});
