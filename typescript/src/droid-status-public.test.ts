import { afterEach, expect, test } from "bun:test";
import Vitrus, { Droid } from "./index.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("public index Droid facade forwards the typed readonly status snapshot", async () => {
  const status = {
    schema: "vitrus.device.status.v1",
    schema_version: "1.0.0",
    timestamp: "2026-09-11T09:00:00Z",
    control: { mode: "read_only", phase: "read_only", lease_id: null },
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/droids/resolve") return Response.json({ id: "droid-1", serialNumber: "VTRS-R06" });
    if (url.pathname === "/v1/droids/status") return Response.json(status);
    return Response.json({ detail: "not found" }, { status: 404 });
  };
  const droid = await Droid.connect("VTRS-R06", { apiKey: "test-key", endpoint: "https://relay.test" });
  expect(await droid.status.snapshot()).toEqual(status);
  expect(Vitrus.Droid).toBe(Droid);
});
