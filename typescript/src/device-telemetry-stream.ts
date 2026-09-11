import type { DeviceTelemetry } from "./droid.js";

export type DeviceTelemetryTransport = "edge_direct" | "realtime" | "snapshot" | "legacy";

export type DeviceTelemetryEnvelope = {
  telemetry: DeviceTelemetry;
  /** Monotonic only within one source connection/epoch. */
  sequence: number | null;
  /** Source-provided timestamp if parseable; never substituted with receive time. */
  sourceTimestampMs: number | null;
  sourceRateHz: number | null;
  droppedSourceSamples: number | null;
  receivedAtMs: number;
  transport: DeviceTelemetryTransport;
  streamEpoch: number;
};

export type DeviceTelemetryBufferStats = {
  accepted: number;
  droppedOutOfOrder: number;
  droppedSuperseded: number;
  epoch: number;
};

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timestampMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A one-slot buffer for renderers: producer updates are coalesced, never
 * queued. A newer stream epoch may restart its sequence at zero; within an
 * epoch a duplicate or older sequence is rejected deterministically.
 */
export class DeviceTelemetryLatestSampleBuffer {
  private latestValue: DeviceTelemetryEnvelope | null = null;
  private readonly statsValue: DeviceTelemetryBufferStats = {
    accepted: 0,
    droppedOutOfOrder: 0,
    droppedSuperseded: 0,
    epoch: 0,
  };

  public push(sample: DeviceTelemetryEnvelope): boolean {
    if (!Number.isFinite(sample.receivedAtMs)) throw new Error("telemetry receivedAtMs must be finite.");
    const current = this.latestValue;
    if (current && sample.streamEpoch < current.streamEpoch) {
      this.statsValue.droppedOutOfOrder += 1;
      return false;
    }
    if (current && sample.streamEpoch === current.streamEpoch) {
      if (sample.sequence !== null && current.sequence !== null && sample.sequence <= current.sequence) {
        this.statsValue.droppedOutOfOrder += 1;
        return false;
      }
      if (sample.sequence === null && current.sequence === null && sample.receivedAtMs <= current.receivedAtMs) {
        this.statsValue.droppedOutOfOrder += 1;
        return false;
      }
      this.statsValue.droppedSuperseded += 1;
    }
    this.latestValue = sample;
    this.statsValue.accepted += 1;
    this.statsValue.epoch = sample.streamEpoch;
    return true;
  }

  /** Returns and clears one latest sample for the next render frame. */
  public takeLatest(): DeviceTelemetryEnvelope | null {
    const sample = this.latestValue;
    this.latestValue = null;
    return sample;
  }

  public peekLatest(): DeviceTelemetryEnvelope | null {
    return this.latestValue;
  }

  public stats(): Readonly<DeviceTelemetryBufferStats> {
    return { ...this.statsValue };
  }
}

export function telemetryEnvelope(
  telemetry: DeviceTelemetry,
  options: Omit<DeviceTelemetryEnvelope, "telemetry" | "sequence" | "sourceTimestampMs" | "sourceRateHz" | "droppedSourceSamples"> & {
    sequence?: unknown;
    sourceTimestamp?: string | null;
    sourceRateHz?: unknown;
    droppedSourceSamples?: unknown;
  },
): DeviceTelemetryEnvelope {
  return {
    telemetry,
    sequence: finiteInteger(options.sequence),
    sourceTimestampMs: options.sourceTimestamp ? timestampMs(options.sourceTimestamp) : timestampMs(telemetry.timestamp),
    sourceRateHz: typeof options.sourceRateHz === "number" && Number.isFinite(options.sourceRateHz) && options.sourceRateHz >= 0
      ? options.sourceRateHz
      : null,
    droppedSourceSamples: finiteInteger(options.droppedSourceSamples),
    receivedAtMs: options.receivedAtMs,
    transport: options.transport,
    streamEpoch: options.streamEpoch,
  };
}
