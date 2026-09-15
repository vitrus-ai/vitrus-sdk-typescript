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

test("complete TCP frames retain all eight fingers through 60 deg/s and reject unsupported speeds", async () => {
  const fingers = ["LEFT", "RIGHT"].flatMap(side => ["LEFT", "RIGHT"].flatMap(finger => ["A", "B"].map(axis => `${side}_GRIPPER_${finger}_FINGER_${axis}`)));
  const job: MotionJob = { job_id: "test", epoch: 1, mode: "device_ik", state: "armed", joint_names: [...Array.from({length:18}, (_,i)=>`JOINT_${i}`), ...fingers], auxiliary_joint_names: fingers, configuration_revision: "test", last_sequence: 0 };
  const sent: Record<string, unknown>[] = [];
  const session = new MotionJobSession({
    status: async () => ({ok:true, job}),
    request: async <T>(_path: string, body?: Record<string, unknown>) => { sent.push(body!); return {ok:true, job, result:{accepted:true}} as T; },
  }, job);
  const frame = (speed: number) => ({controlledChains:["LEFT_ARM", "RIGHT_ARM", "NECK"], targets:["LEFT_ARM", "RIGHT_ARM", "NECK"].map(chain=>({chain,points:[{position_m:[0,0,0] as [number,number,number]}]})), auxiliaryJointTargets:fingers.map(joint_name=>({joint_name,position_deg:0,max_torque_nm:.3,velocity_deg_s:speed}))});
  for (const speed of [20,30,60]) {
    await expect(session.updateDeviceIkFrame(frame(speed))).resolves.toMatchObject({accepted:true,clientInputSequence:expect.any(Number)});
    expect(sent.at(-1)?.auxiliary_joint_targets).toEqual(frame(speed).auxiliaryJointTargets);
  }
  for (const speed of [61,0,NaN]) await expect(session.updateDeviceIkFrame(frame(speed))).rejects.toThrow("velocity_deg_s <= 60");
  expect(sent).toHaveLength(3);
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


test("confirmed frame delivery keeps full scope and source timestamp on the correlated request", async () => {
  const job: MotionJob = { job_id: "test", epoch: 1, mode: "device_ik", state: "armed", joint_names: ["A"], configuration_revision: "test", last_sequence: 0 };
  const requests: Record<string, unknown>[] = [], published: Record<string, unknown>[] = [];
  const session = new MotionJobSession({
    status: async () => ({ ok: true, job }), supportsLatestUpdates: true,
    publishLatestUpdate: (body) => { published.push(body); return { state: "queued" }; },
    // Fixture captured from the public correlated-response projection: the
    // native command id survives, while result.input_sequence is absent.
    request: async <T>(_path: string, body?: Record<string, unknown>) => { requests.push(body!); return { ok: true, job, result: { accepted: true, command_id: 77 } } as T; },
  }, job);
  await expect(session.updateDeviceIkFrame({
    controlledChains: ["NECK"], targets: [{ chain: "NECK", points: [{ position_m: [0, 0, 0], orientation_xyzw: [0, 0, 0, 1] }] }],
    clientCreatedAtMs: 1_000, delivery: "confirmed",
  })).resolves.toEqual({ accepted: true, command_id: 77, clientInputSequence: 1 });
  expect(published).toEqual([]);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ sequence: 1, controlled_chains: ["NECK"], client_created_at_ms: 1_000, chain_targets: [{ chain: "NECK" }] });
  await session.updateDeviceIkFrame({ controlledChains: ["NECK"], targets: [{ chain: "NECK", points: [{ position_m: [0, 0, 0] }] }] });
  expect(published).toHaveLength(1);
});

test("an execute-goal frame may carry a bounded source-age envelope only on the confirmed path", async () => {
  const left11NeckAux = [
    "LEFT_GRIPPER_LEFT_FINGER_A", "LEFT_GRIPPER_LEFT_FINGER_B",
    "LEFT_GRIPPER_RIGHT_FINGER_A", "LEFT_GRIPPER_RIGHT_FINGER_B",
  ];
  const job: MotionJob = {
    job_id: "goal", epoch: 1, mode: "device_ik", state: "armed",
    // Full shared handling scope: seven LEFT_ARM axes, four NECK axes, and
    // the four declared gripper auxiliaries carried by the same lease.
    joint_names: [
      "LEFT_SHOULDER_A", "LEFT_SHOULDER_B", "LEFT_SHOULDER_C", "LEFT_ELBOW_A",
      "LEFT_ELBOW_B", "LEFT_WRIST_A", "LEFT_WRIST_B", "NECK_A", "NECK_B", "NECK_C", "NECK_D",
      ...left11NeckAux,
    ],
    auxiliary_joint_names: left11NeckAux,
    configuration_revision: "test", last_sequence: 0,
  };
  const requests: Record<string, unknown>[] = [], published: Record<string, unknown>[] = [];
  const session = new MotionJobSession({
    status: async () => ({ ok: true, job }), supportsLatestUpdates: true,
    publishLatestUpdate: body => { published.push(body); return { state: "queued" }; },
    requestConfirmed: async <T>(_path: string, body?: Record<string, unknown>) => {
      requests.push(body!);
      return { ok: true, job, result: { accepted: true } } as T;
    },
    request: async <T>() => ({ ok: true, job, result: { accepted: true } } as T),
  }, job);
  const goal = {
    controlledChains: ["NECK"],
    targets: [{ chain: "NECK", points: [{ position_m: [0, 0, 0], orientation_xyzw: [0, 0, 0, 1] as [number, number, number, number] }] }],
    intentMode: "execute_goal" as const,
    delivery: "confirmed" as const,
    clientCreatedAtMs: 1_000,
    sourceMaxAgeMs: 2_000,
  };
  await expect(session.updateDeviceIkFrame(goal)).resolves.toMatchObject({ accepted: true, clientInputSequence: 1 });
  expect(published).toEqual([]);
  expect(requests).toEqual([expect.objectContaining({ intent_mode: "execute_goal", source_max_age_ms: 2_000, client_created_at_ms: 1_000 })]);
  await expect(session.updateDeviceIkFrame({ ...goal, delivery: "latest" })).rejects.toThrow("confirmed frame delivery");
  await expect(session.updateDeviceIkFrame({ ...goal, intentMode: "continuous_setpoint", delivery: "latest" })).resolves.toMatchObject({ clientInputSequence: 2 });
  await expect(session.updateDeviceIkFrame({ ...goal, sourceMaxAgeMs: 500 })).rejects.toThrow("501 through 2000");
  await expect(session.updateDeviceIkFrame({ ...goal, sourceMaxAgeMs: 2_001 })).rejects.toThrow("501 through 2000");
  await expect(session.updateDeviceIkFrame({ ...goal, clientCreatedAtMs: undefined })).rejects.toThrow("clientCreatedAtMs");
  const left11NeckGoal = {
    controlledChains: ["LEFT_ARM", "NECK"],
    targets: [
      { chain: "LEFT_ARM", points: [{ position_m: [0, 0, 0], orientation_xyzw: [0, 0, 0, 1] as [number, number, number, number] }] },
      { chain: "NECK", points: [{ position_m: [0, 0, 0], orientation_xyzw: [0, 0, 0, 1] as [number, number, number, number] }] },
    ],
    auxiliaryJointTargets: [
      "LEFT_GRIPPER_LEFT_FINGER_A", "LEFT_GRIPPER_LEFT_FINGER_B",
      "LEFT_GRIPPER_RIGHT_FINGER_A", "LEFT_GRIPPER_RIGHT_FINGER_B",
    ].map(joint_name => ({ joint_name, position_deg: 0, velocity_deg_s: 5, max_torque_nm: 0.05 })),
    intentMode: "execute_goal" as const,
    delivery: "confirmed" as const,
    clientCreatedAtMs: 1_000,
    sourceMaxAgeMs: 2_000,
  };
  // The SDK does not need the native config to prove serialization: this is
  // the exact complete LEFT_ARM + NECK Cartesian frame plus four static
  // declared auxiliary targets carried over the confirmed public path.
  await expect(session.updateDeviceIkFrame(left11NeckGoal)).resolves.toMatchObject({ accepted: true, clientInputSequence: 3 });
  expect(requests.at(-1)).toMatchObject({
    sequence: 3, intent_mode: "execute_goal", source_max_age_ms: 2_000,
    controlled_chains: ["LEFT_ARM", "NECK"],
    chain_targets: [{ chain: "LEFT_ARM" }, { chain: "NECK" }],
    auxiliary_joint_targets: left11NeckGoal.auxiliaryJointTargets,
  });
  const requestsBeforeInvalid = requests.length;
  await expect(session.updateDeviceIkFrame({ ...left11NeckGoal, targets: left11NeckGoal.targets.slice(0, 1) })).rejects.toThrow("every controlled chain");
  await expect(session.updateDeviceIkFrame({ ...left11NeckGoal, targets: [left11NeckGoal.targets[0]!, left11NeckGoal.targets[0]!] })).rejects.toThrow("unique subset");
  await expect(session.updateDeviceIkFrame({ ...left11NeckGoal, targets: [
    { ...left11NeckGoal.targets[0], points: [...left11NeckGoal.targets[0]!.points, left11NeckGoal.targets[0]!.points[0]!] },
    left11NeckGoal.targets[1]!,
  ] })).rejects.toThrow("every controlled chain");
  await expect(session.updateDeviceIkFrame({ ...left11NeckGoal, targets: [
    left11NeckGoal.targets[0]!, { ...left11NeckGoal.targets[1]!, chain: "RIGHT_ARM" },
  ] })).rejects.toThrow("unique subset");
  expect(requests).toHaveLength(requestsBeforeInvalid);
  // Reusing the valid frame proves rejected client-side shapes did not spend
  // a serialized input sequence (the preceding valid composite was seq=3).
  await expect(session.updateDeviceIkFrame(left11NeckGoal)).resolves.toMatchObject({ clientInputSequence: 4 });
  await expect(session.updateDeviceIkFrame({ ...goal, delivery: "latest" })).rejects.toThrow("confirmed frame delivery");
  await expect(session.updateDeviceIkFrame({ ...goal, intentMode: "continuous_setpoint", delivery: "latest" })).resolves.toMatchObject({ clientInputSequence: 5 });
  await expect(session.updateDeviceIkFrame({ ...goal, sourceMaxAgeMs: 500 })).rejects.toThrow("501 through 2000");
  await expect(session.updateDeviceIkFrame({ ...goal, sourceMaxAgeMs: 2_001 })).rejects.toThrow("501 through 2000");
  await expect(session.updateDeviceIkFrame({ ...goal, clientCreatedAtMs: undefined })).rejects.toThrow("clientCreatedAtMs");
});

test("bounded continuous network tolerance preserves source identity for partial continuous frames", async () => {
  const job: MotionJob = {
    job_id: "continuous", epoch: 1, mode: "device_ik", state: "active",
    joint_names: ["LEFT_SHOULDER_A", "RIGHT_SHOULDER_A"], configuration_revision: "test",
    last_sequence: 0, intent_mode: "continuous_setpoint",
  };
  const published: Record<string, unknown>[] = [];
  const session = new MotionJobSession({
    status: async () => ({ ok: true, job }), supportsLatestUpdates: true,
    continuousNetworkTolerance: { sourceMaxAgeMs: 1_200 },
    publishLatestUpdate: body => { published.push(body); return { state: "queued" }; },
    request: async <T>() => ({ ok: true, job, result: { accepted: true } } as T),
  }, job);
  const complete = {
    controlledChains: ["LEFT_ARM", "RIGHT_ARM"],
    targets: [
      { chain: "LEFT_ARM", points: [{ position_m: [0, 0, 0] as [number, number, number] }] },
      { chain: "RIGHT_ARM", points: [{ position_m: [0, 0, 0] as [number, number, number] }] },
    ],
    clientCreatedAtMs: 10_000,
  };
  await expect(session.updateDeviceIkFrame(complete)).resolves.toMatchObject({ state: "queued", clientInputSequence: 1 });
  expect(published).toEqual([expect.objectContaining({ sequence: 1, client_created_at_ms: 10_000, source_max_age_ms: 1_200 })]);
  // A continuous target may update only the chain that changed. The immutable
  // scope still goes over the wire, but no target is fabricated for RIGHT_ARM.
  await expect(session.updateDeviceIkFrame({
    ...complete, targets: complete.targets.slice(0, 1), clientCreatedAtMs: 10_001,
  })).resolves.toMatchObject({ state: "queued", clientInputSequence: 2 });
  expect(published.at(-1)).toMatchObject({
    sequence: 2, controlled_chains: ["LEFT_ARM", "RIGHT_ARM"],
    chain_targets: [{ chain: "LEFT_ARM", points: [{ position_m: [0, 0, 0] }] }],
    client_created_at_ms: 10_001, source_max_age_ms: 1_200,
  });
  await expect(session.updateDeviceIkFrame({
    ...complete,
    targets: [{ ...complete.targets[0]!, points: [complete.targets[0]!.points[0]!, complete.targets[0]!.points[0]!] }],
    clientCreatedAtMs: 10_002,
  })).rejects.toThrow("every supplied chain");
  await expect(session.updateDeviceIkFrame({ ...complete, sourceMaxAgeMs: 501, clientCreatedAtMs: undefined })).rejects.toThrow("clientCreatedAtMs");
  expect(published).toHaveLength(2);
});

test("a bounded continuous auxiliary-only frame accepts a declared auxiliary pair", async () => {
  const job: MotionJob = {
    job_id: "auxiliary", epoch: 1, mode: "device_ik", state: "active",
    joint_names: ["LEFT_SHOULDER_A", "LEFT_GRIPPER_A", "LEFT_GRIPPER_B"],
    auxiliary_joint_names: ["LEFT_GRIPPER_A", "LEFT_GRIPPER_B"],
    configuration_revision: "test", last_sequence: 0, intent_mode: "continuous_setpoint",
  };
  const published: Record<string, unknown>[] = [];
  const session = new MotionJobSession({
    status: async () => ({ ok: true, job }), supportsLatestUpdates: true,
    continuousNetworkTolerance: { sourceMaxAgeMs: 1_500 },
    publishLatestUpdate: body => { published.push(body); return { state: "queued" }; },
    request: async <T>() => ({ ok: true, job, result: { accepted: true } } as T),
  }, job);
  const auxiliaryJointTargets = ["LEFT_GRIPPER_A", "LEFT_GRIPPER_B"].map(joint_name => ({
    joint_name, position_deg: 1, velocity_deg_s: 5, max_torque_nm: .2,
  }));
  await expect(session.updateDeviceIkFrame({
    controlledChains: ["LEFT_ARM", "RIGHT_ARM", "NECK"], targets: [], auxiliaryJointTargets,
    clientCreatedAtMs: 10_000,
  })).resolves.toMatchObject({ state: "queued", clientInputSequence: 1 });
  expect(published[0]).toMatchObject({
    controlled_chains: ["LEFT_ARM", "RIGHT_ARM", "NECK"], chain_targets: [],
    auxiliary_joint_targets: auxiliaryJointTargets, source_max_age_ms: 1_500,
  });
  const pair = auxiliaryJointTargets.slice(0, 1);
  await expect(session.updateDeviceIkFrame({
    controlledChains: ["LEFT_ARM", "RIGHT_ARM", "NECK"], targets: [],
    auxiliaryJointTargets: pair, clientCreatedAtMs: 10_001,
  })).resolves.toMatchObject({ state: "queued", clientInputSequence: 2 });
  expect(published).toHaveLength(2);
  expect(published[1]).toMatchObject({ auxiliary_joint_targets: pair });
});

test("an HTTP 200 heartbeat reporting a terminal job fails closed but preserves stop confirmation", async () => {
  const active: MotionJob = { job_id: "terminal", epoch: 2, mode: "device_ik", state: "active", joint_names: ["A"], configuration_revision: "test", last_sequence: 0 };
  let updates = 0, stops = 0;
  const session = new MotionJobSession({
    status: async () => ({ ok: true, job: active }),
    request: async <T>(path: string) => {
      if (path.endsWith("heartbeat")) return { ok: true, job: { ...active, state: "stopped" as const, terminal_reason: "native_liveness_expired" } } as T;
      if (path.endsWith("stop")) {
        stops += 1;
        return { ok: true, stopped: true, job: { ...active, state: "stopped" as const } } as T;
      }
      updates += 1;
      return { ok: true, job: active, result: { accepted: true } } as T;
    },
  }, active);
  await session.heartbeat().then(
    () => { throw new Error("expected terminal heartbeat"); },
    (error: unknown) => expect(error).toMatchObject({ payload: { code: "MOTION_SESSION_TERMINAL", retryable: false } }),
  );
  await expect(session.updateJointTargets([{ joint_name: "A", position_deg: 1 }])).rejects.toThrow("terminal state");
  expect(updates).toBe(0);
  await expect(session.stop("terminal_heartbeat_release")).resolves.toBeUndefined();
  expect(stops).toBe(1);
});
