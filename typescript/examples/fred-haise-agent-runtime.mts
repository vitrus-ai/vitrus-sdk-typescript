import { FredHaiseClient } from "../src/fred-haise-client.js";

const baseUrl = process.env.FRED_AGENT_URL ?? "http://127.0.0.1:8898";
const csrf = process.env.FRED_AGENT_CSRF;
const origin = process.env.FRED_AGENT_ORIGIN ?? new URL(baseUrl).origin;
if (!csrf) throw new Error("Set FRED_AGENT_CSRF from the authorized Fred operator session");

const fred = new FredHaiseClient({ baseUrl, csrf, origin });
const discovery = await fred.discovery();
console.log("Fred agent service:", discovery.service);
console.log("Separate resources:", discovery.resources);

const task = await fred.startTask("Inspect the current workcell and report observations");
console.log("Task submission:", task);
console.log("Current task state:", await fred.currentTask());

const preview = await fred.planTrajectory({
  terminal: "LEFT_ARM_TCP",
  position_m: [0.2, -0.1, 0.3],
  orientation_xyzw: [0, 0, 0, 1],
});
console.log("Review-only plan:", preview);

// Submit only after an operator reviews this exact plan ID and hash.
// const approvalSubmission = await fred.approvePlan(preview.plan.id, preview.plan.hash);
// console.log("Submitted for validation; this does not confirm robot motion:", approvalSubmission);
