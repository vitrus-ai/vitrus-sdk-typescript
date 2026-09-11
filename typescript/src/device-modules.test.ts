import { expect, test } from "bun:test";
import { Droid } from "./droid-live.js";

const identity = { id: "droid-1", serialNumber: "VTRS-R06", model: "R06", displayName: "R06", organizationId: "org-1", status: "online", enrollmentState: "enrolled" };

test("droid.modules normalizes the explicit Edge catalog and forwards a declared settings patch", async () => {
  const previous = globalThis.fetch;
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input)); requests.push({ url, init });
    if (url.pathname === "/v1/droids/resolve") return Response.json(identity);
    if (url.pathname === "/api/modules") return Response.json({ schema: "vitrus.modules.v1", ok: true, modules: [{ id: "thermal-camera-kb2040-mlx90640", type: "sensor.thermal_camera", display_name: "Thermal Camera", status_text: "streaming", capabilities: ["thermal_frame"], data_products: [{ id: "thermal_frame", mime_type: "application/json", mesh_topic: "vitrus/modules/thermal/frame", width: 32, height: 24 }], metrics: { fps: 4 }, settings: { thermalPalette: "iron" } }] });
    if (url.pathname === "/api/modules/config") return Response.json({ ok: true, module_id: "thermal-camera-kb2040-mlx90640", settings: JSON.parse(String(init?.body)).settings });
    return Response.json({ error: "unexpected" }, { status: 500 });
  }) as typeof globalThis.fetch;
  try {
    const droid = await Droid.connect("VTRS-R06", { apiKey: "test-key", endpoint: "https://dataplane.example", edgeModuleEndpoint: "http://r05-edge:8781" });
    const catalog = await droid.modules.list();
    expect(catalog.modules[0]).toMatchObject({ id: "thermal-camera-kb2040-mlx90640", displayName: "Thermal Camera", statusText: "streaming", dataProducts: [{ id: "thermal_frame", mimeType: "application/json", meshTopic: "vitrus/modules/thermal/frame", width: 32, height: 24 }] });
    const result = await droid.modules.configure("thermal-camera-kb2040-mlx90640", { thermalPalette: "iron" });
    expect(result).toMatchObject({ ok: true, moduleId: "thermal-camera-kb2040-mlx90640", settings: { thermalPalette: "iron" } });
    const config = requests.find(({ url }) => url.pathname === "/api/modules/config")!;
    expect(config.url.origin).toBe("http://r05-edge:8781");
    expect(JSON.parse(String(config.init?.body))).toEqual({ module_id: "thermal-camera-kb2040-mlx90640", settings: { thermalPalette: "iron" } });
  } finally { globalThis.fetch = previous; }
});

test("droid.modules never guesses that the public dataplane serves Edge modules", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(identity)) as typeof globalThis.fetch;
  try {
    const droid = await Droid.connect("VTRS-R06", { apiKey: "test-key", endpoint: "https://dataplane.example" });
    await expect(droid.modules.list()).rejects.toThrow("edgeModuleEndpoint");
  } finally { globalThis.fetch = previous; }
});
