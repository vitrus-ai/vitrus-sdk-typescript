import { describe, expect, test } from "bun:test";
import {
  createEffectorCommand,
  effectorsFromManifest,
  resolveEffectorCommand,
} from "./effectors.js";

export const semanticEffectorManifest = {
  mechanisms: [{
    type: "semantic_effector",
    id: "right_gripper",
    label: "Right gripper",
    controller_side: "right",
    available: true,
    safety: { torque_stop_nm: { default: 0.25, min: 0.05, max: 0.45, step: 0.01 } },
    input_bindings: [
      { input: "quest_thumbstick_y", variable_id: "aperture", mode: "rate", invert: true },
      { input: "quest_thumbstick_x", variable_id: "shape", mode: "rate" },
    ],
    command_model: {
      schema: "vitrus.effector.model.v1",
      model_id: "r06.opposed_serial_digits",
      revision: "1.0.0",
      anatomy: "opposed_serial_digits",
      command_type: "aperture_shape",
      variables: {
        aperture: { type: "number", default: 0.5, min: 0, max: 1 },
        shape: { type: "number", default: 0, min: -1, max: 1 },
      },
      drivers: [
        { role: "left_proximal", joint_name: "LEFT_A", zero_percent: 0, one_percent: 100 },
        { role: "left_distal", joint_name: "LEFT_B", zero_percent: 0, one_percent: 100 },
        { role: "right_proximal", joint_name: "RIGHT_A", zero_percent: 100, one_percent: 0 },
        { role: "right_distal", joint_name: "RIGHT_B", zero_percent: 100, one_percent: 0 },
      ],
      shape_profiles: { negative: "precision", neutral: "parallel", positive: "enveloping" },
      profiles: {
        parallel: { keyframes: [
          { aperture: 0, roles: { left_proximal: 0, left_distal: 0, right_proximal: 0, right_distal: 0 } },
          { aperture: 1, roles: { left_proximal: 1, left_distal: 1, right_proximal: 1, right_distal: 1 } },
        ] },
        precision: { keyframes: [
          { aperture: 0, roles: { left_proximal: 0.2, left_distal: 0, right_proximal: 0.2, right_distal: 0 } },
          { aperture: 1, roles: { left_proximal: 1, left_distal: 1, right_proximal: 1, right_distal: 1 } },
        ] },
        enveloping: { keyframes: [
          { aperture: 0, roles: { left_proximal: 0, left_distal: 0, right_proximal: 0, right_distal: 0 } },
          { aperture: 0.5, roles: { left_proximal: 0.7, left_distal: 0.3, right_proximal: 0.7, right_distal: 0.3 } },
          { aperture: 1, roles: { left_proximal: 1, left_distal: 1, right_proximal: 1, right_distal: 1 } },
        ] },
      },
    },
  }],
};

const manifest = semanticEffectorManifest;

describe("semantic effectors", () => {
  test("discovers a versioned anatomy and its Quest bindings", () => {
    const [instance] = effectorsFromManifest(manifest);
    expect(instance.id).toBe("right_gripper");
    expect(instance.model.commandType).toBe("aperture_shape");
    expect(instance.inputBindings.map((binding) => binding.variableId)).toEqual(["aperture", "shape"]);
  });

  test("resolves aperture and shape into every anatomy driver", () => {
    const [instance] = effectorsFromManifest(manifest);
    const command = createEffectorCommand(instance, { aperture: 0.5, shape: 1 });
    const targets = resolveEffectorCommand(instance, command);
    expect(targets).toHaveLength(4);
    expect(targets.find((target) => target.role === "left_proximal")?.percent).toBe(70);
    expect(targets.find((target) => target.role === "left_distal")?.percent).toBe(30);
    expect(targets.find((target) => target.role === "right_proximal")?.percent).toBe(30);
    expect(targets.find((target) => target.role === "right_distal")?.percent).toBe(70);
  });

  test("fails closed on a stale model revision", () => {
    const [instance] = effectorsFromManifest(manifest);
    const command = { ...createEffectorCommand(instance, { aperture: 0.5, shape: 0 }), modelRevision: "old" };
    expect(() => resolveEffectorCommand(instance, command)).toThrow("EFFECTOR_MODEL_MISMATCH");
  });

  test("carries a robot-bounded dynamic torque stop", () => {
    const [instance] = effectorsFromManifest(manifest);
    const command = createEffectorCommand(instance, { aperture: 0.5, shape: 0 }, { maxTorqueNm: 0.2 });
    expect(command.limits).toEqual({ maxTorqueNm: 0.2 });
    expect(instance.torqueStop).toEqual({ defaultNm: 0.25, minNm: 0.05, maxNm: 0.45, stepNm: 0.01 });
    expect(() => resolveEffectorCommand(instance, { ...command, limits: { maxTorqueNm: 0.8 } })).toThrow("EFFECTOR_TORQUE_STOP_OUT_OF_RANGE");
  });
});
