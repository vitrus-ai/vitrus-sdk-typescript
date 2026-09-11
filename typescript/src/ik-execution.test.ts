import { expect, test } from "bun:test";
import { MotionJobClient } from "./motion-job.js";
import { measuredIkGoalReached, readDeviceIkExecution, type DeviceIkObservation } from "./ik-execution.js";

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
