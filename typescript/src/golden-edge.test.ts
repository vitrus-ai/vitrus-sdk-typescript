import { describe, expect, test } from "bun:test";
import { GoldenEdgeClient, GoldenEdgeRequestTimeoutError } from "./golden-edge.js";

describe("GoldenEdgeClient", () => {
  test("publishes the canonical contract to the thin Dora gateway", async () => {
    let path = "";
    let body: Record<string, unknown> = {};
    const client = new GoldenEdgeClient({
      endpoint: "http://r-05-edge:8782/",
      robotId: "R06.cannon",
      leaseId: "lease-1",
      source: "clay",
      fetch: (async (input, init) => {
        path = new URL(String(input)).pathname;
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true, transport: "dora", stream: "joint_targets", sequence: 1 }));
      }) as typeof fetch,
    });

    await client.sendJointTargets(
      [{ joint_name: "NECK_YAW", position_deg: 5 }],
      { ttlMs: 300, sentAtMs: 1_000 },
    );

    expect(path).toBe("/api/dora/joint-targets");
    expect(body).toMatchObject({
      schema: "vitrus.control.joint_targets",
      schema_version: "0.1.0",
      robot_id: "R06.cannon",
      lease_id: "lease-1",
      sequence: 1,
      sent_at_ms: 1_000,
      deadline_ms: 1_300,
      targets: [{ joint_name: "NECK_YAW", position_deg: 5 }],
    });
  });

  test("fails closed when the gateway drops a command", async () => {
    const client = new GoldenEdgeClient({
      endpoint: "http://r-05-edge:8782",
      robotId: "R06.cannon",
      leaseId: "lease-1",
      fetch: (async () => new Response(JSON.stringify({
        ok: true,
        transport: "dora",
        stream: "joint_targets",
        dropped: "out_of_order_before_dora",
      }))) as typeof fetch,
    });

    expect(client.sendJointTargets([{ joint_name: "NECK_YAW", position_deg: 5 }]))
      .rejects.toThrow("out_of_order_before_dora");
  });

  test("submits one Cartesian point series for robot-local Vitruvian solving", async () => {
    let path = "";
    let body: Record<string, unknown> = {};
    const client = new GoldenEdgeClient({
      endpoint: "http://r-05-edge:8782",
      robotId: "R06.cannon",
      leaseId: "lease-ik",
      modelBinding: { configuration_revision: "a".repeat(64), effective_urdf_sha256: "b".repeat(64), model_epoch: 2 },
      fetch: (async (input, init) => {
        path = new URL(String(input)).pathname;
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          ok: true, accepted: true, command_id: 7, mode: "ik", chain: "LEFT_ARM",
          point_count: 2, ttl_ms: 800, alignment_profile: { id: "default" },
        }));
      }) as typeof fetch,
    });

    await client.submitIkTrajectory({
      jobId: "left-arm-session-1",
      inputSequence: 1,
      chain: "left_arm",
      controlledChains: ["left_arm", "right_arm"],
      ttlMs: 800,
      alignmentProfile: "rough-r06",
      points: [
        { positionM: [0.1, 0.2, 0.3] },
        { positionM: [0.1, 0.2, 0.35], timeMs: 400 },
      ],
    });

    expect(path).toBe("/api/dora/ik-targets");
    expect(body).toMatchObject({
      lease_id: "lease-ik", session_id: "lease-ik", job_id: "left-arm-session-1", input_sequence: 1, chain: "LEFT_ARM", controlled_chains: ["LEFT_ARM", "RIGHT_ARM"], ttl_ms: 800,
      configuration_revision: "a".repeat(64), effective_urdf_sha256: "b".repeat(64), model_epoch: 2,
      alignment_profile: "rough-r06",
      points: [{ position: [0.1, 0.2, 0.3] }, { position: [0.1, 0.2, 0.35], time_ms: 400 }],
    });
  });

  test("reads device-local IK execution evidence", async () => {
    const client = new GoldenEdgeClient({
      endpoint: "http://r-05-edge:8782", robotId: "R06.cannon", leaseId: "lease-ik",
      fetch: (async () => new Response(JSON.stringify({
        ok: true, mode: "ik", tracking: true, last_error: null,
        last_output: { command_id: 9, chain: "LEFT_ARM", lease_id: "lease-ik", writer_source: "vitrus-sdk", status: "improving", broker_accepted: 7 },
      }))) as typeof fetch,
    });
    await expect(client.ikStatus()).resolves.toMatchObject({
      last_output: { command_id: 9, broker_accepted: 7 },
    });
  });

  test("releases the same lease through the local gateway", async () => {
    let path = "";
    let body: Record<string, unknown> = {};
    const client = new GoldenEdgeClient({
      endpoint: "http://r-05-edge:8782",
      robotId: "R06.cannon",
      leaseId: "lease-1",
      fetch: (async (input, init) => {
        path = new URL(String(input)).pathname;
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          ok: true,
          transport: "dora",
          released: true,
          lease_id: "lease-1",
        }));
      }) as typeof fetch,
    });

    await client.release("lease-1");

    expect(path).toBe("/api/dora/release");
    expect(body).toEqual({ lease_id: "lease-1" });
    expect(client.release("other-lease")).rejects.toThrow("does not match");
  });

  test("renews the same lease through the local gateway", async () => {
    let path = "";
    let body: Record<string, unknown> = {};
    const client = new GoldenEdgeClient({
      endpoint: "http://r-05-edge:8782",
      robotId: "R06.cannon",
      leaseId: "lease-1",
      fetch: (async (input, init) => {
        path = new URL(String(input)).pathname;
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          ok: true, transport: "dora", renewed: true,
          lease_id: "lease-1", duration_ms: 30_000,
        }));
      }) as typeof fetch,
    });
    await client.renew("lease-1", 30_000);
    expect(path).toBe("/api/dora/renew");
    expect(body).toEqual({ lease_id: "lease-1", duration_ms: 30_000 });
  });

  test("acquires one explicit scope through the local gateway", async () => {
    let path = "";
    let body: Record<string, unknown> = {};
    const client = new GoldenEdgeClient({
      endpoint: "http://r-05-edge:8782",
      robotId: "R06.cannon",
      leaseId: "bootstrap",
      fetch: (async (input, init) => {
        path = new URL(String(input)).pathname;
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true, transport: "dora", acquired: true, lease_id: "lease-1" }));
      }) as typeof fetch,
    });
    await client.acquire("lease-1", { owner: "sdk", durationMs: 30_000, jointNames: ["SERVO_A"] });
    expect(path).toBe("/api/dora/acquire");
    expect(body).toEqual({ lease_id: "lease-1", owner: "sdk", duration_ms: 30_000, joint_names: ["SERVO_A"] });
  });

  test("reads unified cached control state outside the command path", async () => {
    let path = "";
    const client = new GoldenEdgeClient({
      endpoint: "http://r-05-edge:8782",
      robotId: "R06.cannon",
      leaseId: "lease-1",
      fetch: (async (input) => {
        path = new URL(String(input)).pathname;
        return new Response(JSON.stringify({
          ok: true,
          transport: "broker-direct",
          access_mode: "read_write",
          complete: true,
          motors: [
            { joint_name: "LEFT_WRIST_B", display_pos_deg: -20.0 },
            { joint_name: "NECK_HEAD", display_pos_deg: -10.0 },
          ],
        }));
      }) as typeof fetch,
    });

    const state = await client.controlState();
    expect(path).toBe("/api/dora/control-state");
    expect(state.complete).toBe(true);
    expect(state.motors?.map((row) => row.joint_name)).toEqual(["LEFT_WRIST_B", "NECK_HEAD"]);
  });

  test("discovers generic module products and configures declared settings", async () => {
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const client = new GoldenEdgeClient({
      endpoint: "http://r-05-edge:8781", robotId: "module-client", leaseId: "module-readonly",
      fetch: (async (input, init) => {
        const path = new URL(String(input)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
        requests.push({ path, body });
        if (path === "/api/modules") return new Response(JSON.stringify({
          ok: true, schema: "vitrus.modules.v1",
          modules: [{
            id: "thermal-camera", type: "sensor.thermal_camera", display_name: "Thermal camera", state: "ready",
            data_products: [{ id: "thermal_frame", mime_type: "application/json", url: "/api/modules/thermal-frame", width: 32, height: 24 }],
            settings: { thermalPalette: "iron" },
            settings_schema: { type: "object", properties: { thermalPalette: { type: "string", enum: ["iron", "white_hot"] } } },
            visualization: { renderer: "thermal_grid", primary_product_id: "thermal_frame", profiles: [{ id: "iron", settings: { thermalPalette: "iron" } }] },
          }],
        }));
        return new Response(JSON.stringify({ ok: true, module_id: "thermal-camera", settings: { thermalPalette: "white_hot" } }));
      }) as typeof fetch,
    });

    const catalog = await client.modules();
    expect(catalog.modules[0]).toMatchObject({
      id: "thermal-camera", type: "sensor.thermal_camera", dataProducts: [{ id: "thermal_frame", mimeType: "application/json", width: 32, height: 24 }],
      visualization: { renderer: "thermal_grid", primary_product_id: "thermal_frame" },
    });
    await expect(client.configureModule("thermal-camera", { thermalPalette: "white_hot" }))
      .resolves.toEqual({ thermalPalette: "white_hot" });
    expect(requests).toEqual([
      { path: "/api/modules" },
      { path: "/api/modules/config", body: { module_id: "thermal-camera", settings: { thermalPalette: "white_hot" } } },
    ]);
  });

  test("reports a typed local admission timeout", async () => {
    const client = new GoldenEdgeClient({
      endpoint: "http://r-05-edge:8782",
      robotId: "R06.cannon",
      leaseId: "lease-1",
      requestTimeoutMs: 5,
      fetch: ((_, init) => new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch,
    });

    try {
      await client.sendJointTargets([{ joint_name: "NECK_YAW", position_deg: 5 }]);
      throw new Error("expected local admission timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(GoldenEdgeRequestTimeoutError);
      expect(error).toMatchObject({
        code: "VITRUS_EDGE_ADMISSION_TIMEOUT",
        path: "/api/dora/joint-targets",
        timeoutMs: 5,
      });
    }
  });
});
