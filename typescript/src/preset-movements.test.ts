import { afterEach, describe, expect, test } from "bun:test";
import { Droid } from "./droid-live.js";
import { presetDefinitionsFromDescription, presetInstancesFromDescription, type DroidDescription } from "./droid.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("preset movement discovery", () => {
  test("parses preset instances and input bindings from droid description", () => {
    const description = {
      schema: "vitrus.droid.description.v1",
      revisionId: "rev-1",
      source: "clay",
      publishedBy: "vitrus-os",
      publishedAt: "2026-07-26T00:00:00Z",
      manifest: {
        mechanisms: [
          {
            type: "multi_axis_effector",
            id: "right-gripper-2d",
            gripper_group: "RIGHT_GRIPPER",
            preset: {
              preset_id: "two_axis_gripper",
              instance_id: "right-gripper-2d",
              label: "Right gripper 2D",
              color: "#F97316",
              target_type: "gripper",
              target_id: "RIGHT_GRIPPER",
              variables: {
                a_closure: { type: "number", default: 50, min: 0, max: 100, step: 0.1 },
              },
              input_bindings: [
                { input: "quest_thumbstick_x", variable_id: "a_closure", mode: "rate" },
              ],
            },
            channels: [
              { id: "a_closure", input: "quest_thumbstick_x", mode: "rate", drivers: [] },
            ],
          },
        ],
      },
    } as unknown as DroidDescription;

    const [preset] = presetInstancesFromDescription(description);
    expect(preset).toMatchObject({
      presetId: "two_axis_gripper",
      instanceId: "right-gripper-2d",
      label: "Right gripper 2D",
      color: "#F97316",
      targetType: "gripper",
      targetId: "RIGHT_GRIPPER",
    });
    expect(preset.variables.a_closure.default).toBe(50);
    expect(preset.inputBindings?.[0]).toMatchObject({
      input: "quest_thumbstick_x",
      variableId: "a_closure",
      mode: "rate",
    });
  });

  test("discovers typed definitions and controls a preset motion run", async () => {
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ path: url.pathname, body });
      if (url.pathname === "/v1/droids/resolve") return new Response(JSON.stringify({ id: "droid-1" }), { status: 200 });
      if (url.pathname === "/v1/droids/description") {
        return new Response(JSON.stringify({
          schema: "vitrus.droid.description.v1",
          revisionId: "rev-2",
          source: "clay",
          publishedBy: "vitrus-os",
          publishedAt: "2026-07-26T00:00:00Z",
          presetDefinitions: [{
            definitionId: "dual-motor-dual-finger-gripper",
            version: "1.0.0",
            label: "Dual gripper",
            artifactHash: "sha256:test",
            actuatorSlots: [
              { id: "finger_a", label: "Finger A", kind: "servo", commandModes: ["position"], feedback: ["position", "torque", "temperature"] },
              { id: "finger_b", label: "Finger B", kind: "servo", commandModes: ["position"], feedback: ["position", "torque", "temperature"] },
            ],
            inputs: { a_closure_pct: { type: "number", default: 50, min: 0, max: 100 } },
            outputs: [{ id: "contact_a", label: "Contact A", type: "boolean" }],
          }],
          presets: [{
            presetId: "dual-motor-dual-finger-gripper",
            instanceId: "r06-right-gripper",
            definitionId: "dual-motor-dual-finger-gripper",
            definitionVersion: "1.0.0",
            artifactHash: "sha256:test",
            gripperGroup: "RIGHT_GRIPPER",
            variables: {},
            channels: [],
            actuatorBindings: { finger_a: "RIGHT_GRIPPER_A", finger_b: "RIGHT_GRIPPER_B" },
            available: true,
          }],
        }), { status: 200 });
      }
      if (url.pathname === "/v1/droids/preset-motions/runs") {
        return new Response(JSON.stringify({ runId: "run-1", instanceId: "r06-right-gripper", definitionId: "dual-motor-dual-finger-gripper", definitionVersion: "1.0.0", artifactHash: "sha256:test", status: "running" }), { status: 200 });
      }
      if (url.pathname.endsWith("/inputs")) {
        return new Response(JSON.stringify({ runId: "run-1", instanceId: "r06-right-gripper", definitionId: "dual-motor-dual-finger-gripper", definitionVersion: "1.0.0", artifactHash: "sha256:test", status: "running", sequence: 1, inputs: body?.inputs ?? {}, outputs: {}, actuators: {} }), { status: 200 });
      }
      if (url.pathname.endsWith("/stop")) {
        return new Response(JSON.stringify({ runId: "run-1", instanceId: "r06-right-gripper", definitionId: "dual-motor-dual-finger-gripper", definitionVersion: "1.0.0", artifactHash: "sha256:test", status: "stopped" }), { status: 200 });
      }
      if (url.pathname.endsWith("/run-1")) {
        return new Response(JSON.stringify({ runId: "run-1", instanceId: "r06-right-gripper", definitionId: "dual-motor-dual-finger-gripper", definitionVersion: "1.0.0", artifactHash: "sha256:test", status: "running", sequence: 1, inputs: { a_closure_pct: 50 }, outputs: {}, actuators: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
    };

    const droid = await Droid.connect("R06", { apiKey: "test-key", endpoint: "http://runtime.test" });
    const definitions = await droid.presets.definitions();
    expect(definitions[0]).toMatchObject({
      definitionId: "dual-motor-dual-finger-gripper",
      artifactHash: "sha256:test",
    });
    expect(definitions[0]?.actuatorSlots[0]).toMatchObject({ kind: "servo", commandModes: ["position"] });

    const run = await droid.presets.start("r06-right-gripper", { inputs: { a_closure_pct: 50 } });
    expect(run.status).toBe("running");
    await droid.presets.setInputs(run.runId, { a_closure_pct: 75 }, { sequence: 1 });
    expect((requests.find((request) => request.path.endsWith("/inputs"))?.body?.inputs as Record<string, unknown>).a_closure_pct).toBe(75);
    expect((await droid.presets.state(run.runId)).sequence).toBe(1);
    expect((await droid.presets.stop(run.runId)).status).toBe("stopped");
  });

  test("parses definitions from a legacy manifest", () => {
    const definitions = presetDefinitionsFromDescription({
      schema: "vitrus.droid.description.v1",
      revisionId: "rev-legacy",
      source: "clay",
      publishedBy: "vitrus-os",
      publishedAt: "2026-07-26T00:00:00Z",
      manifest: {
        preset_motion_definitions: [{
          definition_id: "four-wheel-mobile-base",
          version: "1.0.0",
          artifact_hash: "sha256:base",
          actuator_slots: [{ id: "front_left", label: "Front left", kind: "bldc", command_modes: ["velocity"], feedback: ["velocity", "torque", "temperature"] }],
          inputs: {},
          outputs: [],
        }],
      },
    });
    expect(definitions[0]).toMatchObject({ definitionId: "four-wheel-mobile-base", artifactHash: "sha256:base" });
    expect(definitions[0]?.actuatorSlots[0]?.kind).toBe("bldc");
  });
});
