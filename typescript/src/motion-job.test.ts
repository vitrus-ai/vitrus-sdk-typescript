import { describe, expect, test } from "bun:test";
import { MotionControlError, MotionJobClient } from "./motion-job.js";

describe("MotionJobClient", () => {
  test("starts a device-side IK job without exposing a broker lease", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = new MotionJobClient({
      endpoint: "http://edge.test", robotId: "R06",
      fetch: (async (input, init) => {
        const path = new URL(String(input)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        requests.push({ path, body });
        return Response.json({ ok: true, job: { job_id: "job-1", epoch: 1, mode: "device_ik", state: "armed", joint_names: ["LEFT_SHOULDER_A"], configuration_revision: "a".repeat(64), last_sequence: 0 } });
      }) as typeof fetch,
    });
    const session = await client.startJob({ mode: "device_ik", owner: "sdk-control", jointNames: ["LEFT_SHOULDER_A"] });
    expect(session.id).toBe("job-1");
    expect(requests[0]).toMatchObject({ path: "/api/v2/motion/start", body: { robot_id: "R06", mode: "device_ik", joint_names: ["LEFT_SHOULDER_A"] } });
    expect(requests[0].body).not.toHaveProperty("lease_id");
  });

  test("sends client-side IK output only as an atomic full scope frame", async () => {
    const paths: string[] = [];
    const client = new MotionJobClient({
      endpoint: "http://edge.test", robotId: "R06",
      fetch: (async (input, init) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path.endsWith("/start")) return Response.json({ ok: true, job: { job_id: "job-1", epoch: 1, mode: "joint_trajectory", state: "armed", joint_names: ["A", "B"], configuration_revision: "a".repeat(64), last_sequence: 0 } });
        if (path.endsWith("/update")) return Response.json({ ok: true, job: { job_id: "job-1", epoch: 1, mode: "joint_trajectory", state: "running", joint_names: ["A", "B"], configuration_revision: "a".repeat(64), last_sequence: 1 }, result: { accepted: 2 } });
        return Response.json({ ok: true, stopped: true });
      }) as typeof fetch,
    });
    const session = await client.startJob({ mode: "joint_trajectory", owner: "external", jointNames: ["A", "B"] });
    await expect(session.updateJointTargets([{ joint_name: "A", position_deg: 1 }])).rejects.toThrow("immutable job scope");
    await expect(session.updateJointTargets([{ joint_name: "A", position_deg: 1 }, { joint_name: "B", position_deg: 2 }])).resolves.toEqual({ accepted: 2 });
    expect(paths).toEqual(["/api/v2/motion/start", "/api/v2/motion/update"]);
  });

  test("preserves typed server errors", async () => {
    const client = new MotionJobClient({
      endpoint: "http://edge.test", robotId: "R06",
      fetch: (async () => Response.json({ ok: false, error: "job is not active", code: "SESSION_ENDED", domain: "motion", retryable: false }, { status: 410 })) as typeof fetch,
    });
    try {
      await client.startJob({ mode: "direct_joint", owner: "sdk", jointNames: ["A"] });
      throw new Error("expected typed error");
    } catch (error) {
      expect(error).toBeInstanceOf(MotionControlError);
      expect(error).toMatchObject({ status: 410, payload: { code: "SESSION_ENDED", domain: "motion" } });
    }
  });
});
