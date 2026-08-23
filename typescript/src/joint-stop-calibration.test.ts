import { describe, expect, test } from "bun:test";
import { JointStopCalibrationClient } from "./joint-stop-calibration.js";

describe("JointStopCalibrationClient", () => {
  test("defaults to dry-run and sends no motor tuning or A-01 command", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new JointStopCalibrationClient({
      baseUrl: "http://r05-edge:8781/",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ ok: true, runId: "run-1", joint: "RIGHT_WRIST_B", state: "eligible", dryRun: true }));
      }) as typeof fetch,
    });

    const run = await client.autoCalibrateJoint({ joint: "RIGHT_WRIST_B" });

    expect(run.state).toBe("eligible");
    expect(requests[0].url).toBe("http://r05-edge:8781/api/calibration/joint-stop/auto");
    expect(requests[0].body).toEqual({
      joint: "RIGHT_WRIST_B",
      dry_run: true,
      auto_commit: false,
    });
  });

  test("passes Clay recording id only as opaque correlation", async () => {
    let body: Record<string, unknown> = {};
    const client = new JointStopCalibrationClient({
      baseUrl: "http://edge",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: true, runId: "run-2", joint: "RIGHT_WRIST_B", state: "preflight", dryRun: false }));
      }) as typeof fetch,
    });

    await client.start({
      joint: "RIGHT_WRIST_B",
      dryRun: false,
      evidenceSessionId: "clay-a01-session",
    });

    expect(body.evidence_session_id).toBe("clay-a01-session");
    expect(body).not.toHaveProperty("a01_recording_session_id");
    expect(body).not.toHaveProperty("profile_id");
    expect(body).not.toHaveProperty("strategy");
  });
});
