import { expect, test } from "bun:test";
import { createJointTargetsMessage } from "./contracts.js";

test("serializes a complete model binding with a control command", () => {
  const command = createJointTargetsMessage({
    robotId: "r06",
    leaseId: "lease-1",
    sequence: 1,
    sentAtMs: 100,
    modelBinding: {
      configuration_revision: "a".repeat(64),
      effective_urdf_sha256: "b".repeat(64),
      model_epoch: 3,
    },
    targets: [{ joint_name: "RIGHT_WRIST_B", position_rad: 0.25 }],
  });
  expect(command).toMatchObject({
    configuration_revision: "a".repeat(64),
    effective_urdf_sha256: "b".repeat(64),
    model_epoch: 3,
    client_sequence: 1,
    trace_id: "vitrus-sdk:lease-1:1",
    delivery: { kind: "desired_state", key: "RIGHT_WRIST_B", replace_pending: true },
  });
  expect(command).not.toHaveProperty("ttl_ms");
  expect(command).not.toHaveProperty("deadline_ms");
});

test("rejects invalid model bindings before transport", () => {
  expect(() => createJointTargetsMessage({
    robotId: "r06", leaseId: "lease-1", sequence: 1,
    modelBinding: { configuration_revision: "short", effective_urdf_sha256: "b".repeat(64), model_epoch: 1 },
    targets: [{ joint_name: "RIGHT_WRIST_B", position_rad: 0.25 }],
  })).toThrow("configuration revision");
});
