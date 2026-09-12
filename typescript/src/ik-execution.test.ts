import { expect, test } from "bun:test";
import { MotionJobClient } from "./motion-job.js";
import { measuredIkGoalReached, measuredIkGoalStalled, readDeviceIkExecution, waitForMeasuredIkGoal, type DeviceIkExecutionReader, type DeviceIkObservation } from "./ik-execution.js";

function observed(): DeviceIkObservation {
  return { receivedAtMs: performance.now(), roundTripMs: 10, status: {
    ok: true, tracking: true, stream: { active: true }, last_output: {
      job_id: "job", input_sequence: 4, command_id: 7, solver_status: "converged",
      execution: { schema: "vitrus.ik.execution.v1", state: "settled", measured_goal_reached: true,
        feedback_fresh: true, plan_applied: true, feedback_age_ms: 20 },
    },
  } };
}
const expected = { jobId: "job", inputSequence: 4, commandId: 7 };
const responseClient = (next: () => Promise<DeviceIkExecutionStatusLike>): DeviceIkExecutionReader => ({
  request: (() => next()) as MotionJobClient["request"],
});
type DeviceIkExecutionStatusLike = DeviceIkObservation["status"];

test("matching fresh measured completion qualifies", () => expect(measuredIkGoalReached(observed(), expected)).toBe(true));
test("numerical convergence without physical evidence does not qualify", () => {
  const value = observed(); delete value.status.last_output!.execution;
  expect(measuredIkGoalReached(value, expected)).toBe(false);
});
test("stale network transit and retained observations cannot qualify", () => {
  for (const mutation of [(o: DeviceIkObservation) => o.roundTripMs = 350, (o: DeviceIkObservation) => o.receivedAtMs -= 350]) {
    const value=observed();mutation(value);expect(measuredIkGoalReached(value, expected)).toBe(false);
  }
});
test("superseded jobs, inputs, and commands cannot qualify", () => {
  for (const binding of [{...expected,jobId:"other"},{...expected,inputSequence:3},{...expected,commandId:6}]) {
    expect(measuredIkGoalReached(observed(),binding)).toBe(false);
  }
});
test("stopped, stale, unapplied, moving, and malformed proofs fail closed", () => {
  const mutations = [
    (o: DeviceIkObservation) => o.status.tracking = false,
    (o: DeviceIkObservation) => o.status.stream!.active = false,
    (o: DeviceIkObservation) => o.status.last_error = "feedback lost",
    (o: DeviceIkObservation) => o.status.last_output!.execution!.plan_applied = false,
    (o: DeviceIkObservation) => o.status.last_output!.execution!.feedback_fresh = false,
    (o: DeviceIkObservation) => o.status.last_output!.execution!.state = "moving",
    (o: DeviceIkObservation) => o.status.last_output!.execution!.feedback_age_ms = NaN,
  ];
  for (const change of mutations) { const value=observed();change(value);expect(measuredIkGoalReached(value,expected)).toBe(false); }
});
test("SDK observation uses only the read endpoint and includes transit time", async () => {
  const requests: string[]=[];
  const client=new MotionJobClient({ endpoint:"http://edge.test",robotId:"R06",fetch:(async(input,init)=>{
    requests.push(`${init?.method} ${new URL(String(input)).pathname}`);
    return Response.json(observed().status);
  }) as typeof fetch });
  const result=await readDeviceIkExecution(client);
  expect(requests).toEqual(["GET /api/dora/ik/status"]);
  expect(result.roundTripMs).toBeGreaterThanOrEqual(0);
  expect(measuredIkGoalReached(result,expected)).toBe(true);
});
test("observer returns reached from exact fresh physical evidence", async () => {
  const result = await waitForMeasuredIkGoal(responseClient(async () => observed().status), expected, { timeoutMs: 50, pollIntervalMs: 1 });
  expect(result.outcome).toBe("reached");
});
test("observer returns qualified native stalled only with exact fresh proof", async () => {
  const stalled = observed();
  stalled.status.last_output!.execution = { ...stalled.status.last_output!.execution!, state: "stalled", measured_goal_reached: false, stalled: true };
  const result = await waitForMeasuredIkGoal(responseClient(async () => stalled.status), expected, { timeoutMs: 50, pollIntervalMs: 1 });
  expect(measuredIkGoalStalled(stalled, expected)).toBe(true);
  expect(result.outcome).toBe("stalled");
});
test("stale fake stalled evidence is never classified as stalled", async () => {
  const stale = observed();
  stale.status.last_output!.execution = { ...stale.status.last_output!.execution!, state: "stalled", measured_goal_reached: false, stalled: true, feedback_age_ms: 500 };
  const result = await waitForMeasuredIkGoal(responseClient(async () => stale.status), expected, { timeoutMs: 15, pollIntervalMs: 1 });
  expect(measuredIkGoalStalled(stale, expected)).toBe(false);
  expect(result.outcome).toBe("observation_timeout");
});
test("wrong exact identity terminates rather than observing another command", async () => {
  const wrong = observed(); wrong.status.last_output!.input_sequence = 5;
  const result = await waitForMeasuredIkGoal(responseClient(async () => wrong.status), expected, { timeoutMs: 50, pollIntervalMs: 1 });
  expect(result.outcome).toBe("inactive_or_identity_mismatch");
});
test("whole deadline bounds a hung read and no later read begins", async () => {
  let calls = 0;
  const client = responseClient(async () => { calls += 1; return await new Promise<DeviceIkExecutionStatusLike>(() => {}); });
  const result = await waitForMeasuredIkGoal(client, expected, { timeoutMs: 15, pollIntervalMs: 1 });
  expect(result.outcome).toBe("observation_timeout");
  expect(calls).toBe(1);
});
test("native errors and aborts are explicit outcomes", async () => {
  const fault = observed(); fault.status.last_error = "IK_FRAME_SOLVER_NO_PROGRESS";
  expect((await waitForMeasuredIkGoal(responseClient(async () => fault.status), expected, { timeoutMs: 50 })).outcome).toBe("native_error");
  const controller = new AbortController(); controller.abort();
  expect((await waitForMeasuredIkGoal(responseClient(async () => observed().status), expected, { signal: controller.signal })).outcome).toBe("aborted");
});

test("early reached reads remove their deadline abort listener", async () => {
  let added = 0, removed = 0;
  const signal = {
    aborted: false,
    addEventListener: () => { added += 1; },
    removeEventListener: () => { removed += 1; },
  } as unknown as AbortSignal;
  const result = await waitForMeasuredIkGoal(responseClient(async () => observed().status), expected, {
    timeoutMs: 5_000, signal,
  });
  expect(result.outcome).toBe("reached");
  expect(added).toBe(1);
  expect(removed).toBe(1);
});
test("invalid expected identity performs no GET", async () => {
  let calls = 0;
  const client = responseClient(async () => { calls += 1; return observed().status; });
  await expect(waitForMeasuredIkGoal(client, { jobId: "", inputSequence: 0 }, { timeoutMs: 10 })).rejects.toThrow("expected jobId");
  expect(calls).toBe(0);
});
test("a predecessor fault with the wrong identity is not attributed to this goal", async () => {
  const prior = observed(); prior.status.last_error = "old goal fault"; prior.status.last_output!.input_sequence = 3;
  const result = await waitForMeasuredIkGoal(responseClient(async () => prior.status), expected, { timeoutMs: 50 });
  expect(result.outcome).toBe("inactive_or_identity_mismatch");
});
