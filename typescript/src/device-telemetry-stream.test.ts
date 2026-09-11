import { describe, expect, test } from "bun:test";

import {
  DeviceTelemetryLatestSampleBuffer,
  telemetryEnvelope,
} from "./device-telemetry-stream.js";
import type { DeviceTelemetry } from "./droid.js";

function telemetry(timestamp = "2026-08-24T00:00:00.000Z"): DeviceTelemetry {
  return { schema: "vitrus.telemetry.state.v1", timestamp, joints: {}, raw: {} };
}

describe("DeviceTelemetryLatestSampleBuffer", () => {
  test("keeps only the latest ordered sample in one stream epoch", () => {
    const buffer = new DeviceTelemetryLatestSampleBuffer();
    expect(buffer.push(telemetryEnvelope(telemetry(), {
      sequence: 4, receivedAtMs: 100, transport: "realtime", streamEpoch: 1,
    }))).toBe(true);
    expect(buffer.push(telemetryEnvelope(telemetry(), {
      sequence: 5, receivedAtMs: 101, transport: "realtime", streamEpoch: 1,
    }))).toBe(true);
    expect(buffer.takeLatest()?.sequence).toBe(5);
    expect(buffer.takeLatest()).toBeNull();
    expect(buffer.stats()).toEqual({ accepted: 2, droppedOutOfOrder: 0, droppedSuperseded: 1, epoch: 1 });
  });

  test("rejects duplicate and out-of-order sequences", () => {
    const buffer = new DeviceTelemetryLatestSampleBuffer();
    buffer.push(telemetryEnvelope(telemetry(), { sequence: 4, receivedAtMs: 100, transport: "edge_direct", streamEpoch: 2 }));
    expect(buffer.push(telemetryEnvelope(telemetry(), { sequence: 4, receivedAtMs: 101, transport: "edge_direct", streamEpoch: 2 }))).toBe(false);
    expect(buffer.push(telemetryEnvelope(telemetry(), { sequence: 3, receivedAtMs: 102, transport: "edge_direct", streamEpoch: 2 }))).toBe(false);
    expect(buffer.peekLatest()?.sequence).toBe(4);
    expect(buffer.stats().droppedOutOfOrder).toBe(2);
  });

  test("permits a reconnect epoch to restart sequence numbering", () => {
    const buffer = new DeviceTelemetryLatestSampleBuffer();
    buffer.push(telemetryEnvelope(telemetry(), { sequence: 30, receivedAtMs: 100, transport: "realtime", streamEpoch: 3 }));
    expect(buffer.push(telemetryEnvelope(telemetry(), { sequence: 0, receivedAtMs: 101, transport: "realtime", streamEpoch: 4 }))).toBe(true);
    expect(buffer.peekLatest()?.streamEpoch).toBe(4);
    expect(buffer.peekLatest()?.sequence).toBe(0);
  });

  test("does not replace a new connection with a late prior-epoch sample", () => {
    const buffer = new DeviceTelemetryLatestSampleBuffer();
    buffer.push(telemetryEnvelope(telemetry(), { sequence: 1, receivedAtMs: 100, transport: "realtime", streamEpoch: 4 }));
    expect(buffer.push(telemetryEnvelope(telemetry(), { sequence: 99, receivedAtMs: 101, transport: "realtime", streamEpoch: 3 }))).toBe(false);
    expect(buffer.peekLatest()?.streamEpoch).toBe(4);
  });

  test("carries source rate and source-drop counters without inventing values", () => {
    const envelope = telemetryEnvelope(telemetry(), {
      sequence: 1,
      sourceRateHz: 99.5,
      droppedSourceSamples: 3,
      receivedAtMs: 100,
      transport: "edge_direct",
      streamEpoch: 1,
    });
    expect(envelope.sourceRateHz).toBe(99.5);
    expect(envelope.droppedSourceSamples).toBe(3);
  });
});
