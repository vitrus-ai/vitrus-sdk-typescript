import { describe, expect, test } from "bun:test";
import { MotionControlError, MotionJobClient, MotionJobSession, type MotionJob } from "./motion-job.js";

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

test("complete TCP frames retain all eight fingers at 20/30 deg/s and reject unsupported speeds", async () => {
  const fingers = ["LEFT", "RIGHT"].flatMap(side => ["LEFT", "RIGHT"].flatMap(finger => ["A", "B"].map(axis => `${side}_GRIPPER_${finger}_FINGER_${axis}`)));
  const job: MotionJob = { job_id: "test", epoch: 1, mode: "device_ik", state: "armed", joint_names: [...Array.from({length:18}, (_,i)=>`JOINT_${i}`), ...fingers], auxiliary_joint_names: fingers, configuration_revision: "test", last_sequence: 0 };
  const sent: Record<string, unknown>[] = [];
  const session = new MotionJobSession({
    status: async () => ({ok:true, job}),
    request: async <T>(_path: string, body?: Record<string, unknown>) => { sent.push(body!); return {ok:true, job, result:{accepted:true}} as T; },
  }, job);
  const frame = (speed: number) => ({controlledChains:["LEFT_ARM", "RIGHT_ARM", "NECK"], targets:["LEFT_ARM", "RIGHT_ARM", "NECK"].map(chain=>({chain,points:[{position_m:[0,0,0] as [number,number,number]}]})), auxiliaryJointTargets:fingers.map(joint_name=>({joint_name,position_deg:0,max_torque_nm:.3,velocity_deg_s:speed}))});
  for (const speed of [20,30]) {
    await expect(session.updateDeviceIkFrame(frame(speed))).resolves.toEqual({accepted:true});
    expect(sent.at(-1)?.auxiliary_joint_targets).toEqual(frame(speed).auxiliaryJointTargets);
  }
  for (const speed of [31,0,NaN]) await expect(session.updateDeviceIkFrame(frame(speed))).rejects.toThrow("velocity_deg_s <= 30");
  expect(sent).toHaveLength(2);
});

test("a correlated continuous frame preserves an explicit ingress timestamp for Edge expiry", async () => {
  const job: MotionJob = { job_id: "test", epoch: 1, mode: "device_ik", state: "armed", joint_names: ["A"], configuration_revision: "test", last_sequence: 0 };
  const sent: Record<string, unknown>[] = [];
  const session = new MotionJobSession({
    status: async () => ({ ok: true, job }),
    request: async <T>(_path: string, body?: Record<string, unknown>) => {
      sent.push(body!);
      return { ok: true, job, result: { accepted: true } } as T;
    },
    // No latest-only publisher: this exercises the correlated path.
  }, job);
  await session.updateDeviceIkFrame({
    controlledChains: ["LEFT_ARM"],
    targets: [{ chain: "LEFT_ARM", points: [{ position_m: [0, 0, 0] }] }],
    clientCreatedAtMs: 1_000,
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ client_created_at_ms: 1_000, sequence: 1 });
  await expect(session.updateDeviceIkFrame({
    controlledChains: ["LEFT_ARM"],
    targets: [{ chain: "LEFT_ARM", points: [{ position_m: [0, 0, 0] }] }],
    clientCreatedAtMs: -1,
  })).rejects.toThrow("clientCreatedAtMs");
  expect(sent).toHaveLength(1);
});
