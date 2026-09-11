import { expect, test } from "bun:test";
import { Droid } from "./droid-live.js";
import { observeCameraFrames } from "./camera-live.js";

const jpeg = new Uint8Array([255, 216, 255, 217]);
const encoder = new TextEncoder();

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function stream(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join("")));
      controller.close();
    },
  });
}

const identity = {
  id: "droid-1",
  serialNumber: "VTRS-R06",
  model: "r06",
  displayName: null,
  organizationId: "org-1",
  status: "online",
  enrollmentState: "enrolled",
};

test("public camera methods serialize independent delivery requests and capture configuration", async () => {
  const previous = globalThis.fetch;
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname === "/v1/droids/resolve") return json(identity);
    if (url.pathname === "/v1/droids/cameras/capabilities") {
      return json({
        camera: "head_camera",
        capabilities: {
          captureProfiles: [{ width: 1280, height: 720, fourcc: "MJPG", frameIntervalsFps: [30, 15] }],
          output: { maxWidth: 1280, maxHeight: 720, qualityRange: [20, 95], maxFps: 30 },
        },
        actualSourceProfile: { width: 1280, height: 720, fps: 29.97, fourcc: "MJPG" },
        sourceProfileEpoch: 7,
      });
    }
    if (url.pathname === "/v1/droids/cameras/capture") {
      return json({
        requestId: JSON.parse(String(init?.body)).requestId,
        ok: true,
        camera: "head_camera",
        requestedProfile: { width: 1280, height: 720, fps: 30, fourcc: "MJPG" },
        actualSourceProfile: { width: 1280, height: 720, fps: 29, fourcc: "MJPG" },
        sourceProfileEpoch: 8,
        appliedAtMs: 1234,
      });
    }
    if (url.pathname === "/v1/droids/cameras/frame") {
      return json({
        camera: "head_camera", frameId: "still-1", mimeType: "image/jpeg",
        capturedAt: "2026-09-11T00:00:00Z", dataBase64: Buffer.from(jpeg).toString("base64"),
        requestedProfile: { width: 1280, height: 720, quality: 90 },
        // Bridge's first delivery deployment calls this an output profile.
        // The SDK publishes the stable actualDeliveryProfile spelling.
        outputProfile: { width: 640, height: 360, quality: 75 },
        actualSourceProfile: { width: 640, height: 360, fps: 30, fourcc: "MJPG" },
        sourceProfileEpoch: 9, resolutionLimitedBySource: true,
      });
    }
    return json({ error: `unexpected ${url.pathname}` }, 500);
  }) as typeof globalThis.fetch;
  try {
    const droid = await Droid.connect("VTRS-R06", { apiKey: "public-key" });
    const capabilities = await droid.camera.getCapabilities("head_camera");
    expect(capabilities.capabilities.captureProfiles).toEqual([{ width: 1280, height: 720, fourcc: "MJPG", frameIntervalsFps: [30, 15] }]);
    expect(capabilities.actualSourceProfile?.fps).toBe(29.97);
    const receipt = await droid.camera.configureCapture("head_camera", { width: 1280, height: 720, fps: 30, fourcc: "MJPG" });
    expect(receipt.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const frame = await droid.camera.getFrame("head_camera");
    await droid.camera.getFrame("head_camera", { requireExactResolution: true });
    expect(frame.actualDeliveryProfile).toEqual({ width: 640, height: 360, quality: 75 });
    expect(frame.resolutionLimitedBySource).toBe(true);

    const capabilityRequest = requests.find(({ url }) => url.pathname === "/v1/droids/cameras/capabilities")!.url;
    expect(capabilityRequest.searchParams.get("ref")).toBe("VTRS-R06");
    expect(capabilityRequest.searchParams.get("camera")).toBe("head_camera");
    const capture = requests.find(({ url }) => url.pathname === "/v1/droids/cameras/capture")!;
    expect(capture.url.searchParams.get("ref")).toBe("VTRS-R06");
    expect(capture.url.searchParams.get("camera")).toBe("head_camera");
    expect(JSON.parse(String(capture.init?.body))).toMatchObject({ width: 1280, height: 720, fps: 30, fourcc: "MJPG" });
    const stillRequests = requests.filter(({ url }) => url.pathname === "/v1/droids/cameras/frame").map(({ url }) => url);
    expect(stillRequests).toHaveLength(2);
    expect(Object.fromEntries(stillRequests[0].searchParams)).toMatchObject({
      ref: "VTRS-R06", camera: "head_camera", width: "1280", height: "720", quality: "90", consistency: "latest",
    });
    expect(stillRequests[0].searchParams.has("require_exact_resolution")).toBe(false);
    expect(stillRequests[1].searchParams.get("require_exact_resolution")).toBe("true");
  } finally {
    globalThis.fetch = previous;
  }
});

test("independent live consumers send separate options without capture mutation and preserve truthful source metadata", async () => {
  const urls: URL[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const width = url.searchParams.get("width") === "640" ? 640 : 1280;
    const height = url.searchParams.get("height") === "360" ? 360 : 720;
    return new Response(stream([JSON.stringify({
      type: "frame", camera: "head_camera", frameId: `f-${width}`,
      capturedAt: "2026-09-11T00:00:00.000Z", mimeType: "image/jpeg",
      dataBase64: Buffer.from(jpeg).toString("base64"), receivedAtMs: 100,
      requestedProfile: width === 640 ? { width, height, quality: 70, maxFps: 30 } : { maxFps: 2 },
      outputProfile: { width, height, quality: width === 640 ? 70 : 90, maxFps: width === 640 ? 30 : 2 },
      actualSourceProfile: { width: 1280, height: 720, fps: 29.97, fourcc: "MJPG" },
      sourceProfileEpoch: "source-7",
    }) + "\n"]));
  };
  const low = observeCameraFrames({ endpoint: "https://public.example", apiKey: "key", ref: "VTRS-R06", camera: "head_camera", width: 640, height: 360, quality: 70, maxFps: 30, fetch: fetch as typeof globalThis.fetch, reconnect: false });
  const high = observeCameraFrames({ endpoint: "https://public.example", apiKey: "key", ref: "VTRS-R06", camera: "head_camera", width: 1280, height: 720, quality: 90, maxFps: 2, requireExactResolution: true, fetch: fetch as typeof globalThis.fetch, reconnect: false });
  const [lowFrame, highFrame] = await Promise.all([low.next(), high.next()]);
  expect(lowFrame.value?.actualDeliveryProfile).toEqual({ width: 640, height: 360, quality: 70, maxFps: 30 });
  expect(highFrame.value?.requestedProfile).toEqual({ maxFps: 2 });
  expect(highFrame.value?.actualDeliveryProfile).toEqual({ width: 1280, height: 720, quality: 90, maxFps: 2 });
  expect(highFrame.value?.actualSourceProfile).toEqual({ width: 1280, height: 720, fps: 29.97, fourcc: "MJPG" });
  expect(urls).toHaveLength(2);
  expect(Object.fromEntries(urls[0].searchParams)).toMatchObject({ ref: "VTRS-R06", camera: "head_camera", width: "640", height: "360", quality: "70", max_fps: "30" });
  expect(Object.fromEntries(urls[1].searchParams)).toMatchObject({ ref: "VTRS-R06", camera: "head_camera", width: "1280", height: "720", quality: "90", max_fps: "2", require_exact_resolution: "true" });
  expect(urls.every((url) => !url.pathname.includes("capture"))).toBe(true);
  await low.return?.();
  await high.return?.();
});

test("camera profile options reject invalid values before public I/O", async () => {
  await expect((async () => {
    const iterator = observeCameraFrames({ endpoint: "https://public.example", apiKey: "key", ref: "VTRS-R06", camera: "head_camera", maxFps: 31, reconnect: false });
    await iterator.next();
  })()).rejects.toThrow("maxFps is out of range");

  const previous = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/droids/resolve") return json(identity);
    throw new Error("must not issue a camera request");
  }) as typeof globalThis.fetch;
  try {
    const droid = await Droid.connect("VTRS-R06", { apiKey: "public-key" });
    await expect(droid.camera.configureCapture("head_camera", { width: 0, height: 720, fps: 30 })).rejects.toThrow("width is out of range");
    await expect(droid.camera.configureCapture("head_camera", { width: 640, height: 360, fps: 31 })).rejects.toThrow("fps is out of range");
  } finally {
    globalThis.fetch = previous;
  }
});
