import { afterEach, expect, test } from "bun:test";
import { Droid } from "./droid.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("Droid status snapshot uses the authenticated reference route and preserves the device status body", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const status = {
    schema: "vitrus.device.status.v1",
    schema_version: "1.0.0",
    timestamp: "2026-09-11T09:00:00Z",
    state: "online",
    connection: { sdk_agent: "connected" },
    safety: { state: "safe", deadman_active: false },
    control: { mode: "read_write", phase: "ready_for_realtime", lease_id: "lease-1", lease_expires_at: "2026-09-11T09:00:00.450Z" },
    robot: { joint_count: 26 },
    extensions: { vitrus_os: { global_control: "drive" } },
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (url.pathname === "/v1/droids/resolve") return Response.json({ id: "droid-1", serialNumber: "VTRS-R06" });
    if (url.pathname === "/v1/droids/status") return Response.json(status);
    return Response.json({ detail: "not found" }, { status: 404 });
  };
  const droid = await Droid.connect("VTRS-R06", { apiKey: "test-key", endpoint: "https://relay.test" });
  const observed = await droid.status.snapshot();
  expect(observed).toEqual(status);
  const request = calls.find((call) => call.url.pathname === "/v1/droids/status");
  expect(request?.url.searchParams.get("ref")).toBe("VTRS-R06");
  expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer test-key");
  // Lease expiry is preserved verbatim as observation; it is not interpreted as SDK write authority.
  expect(observed.control.lease_expires_at).toBe("2026-09-11T09:00:00.450Z");
});
