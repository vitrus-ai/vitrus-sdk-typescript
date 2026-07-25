import { describe, expect, test } from "bun:test";
import { GoldenEdgeClient } from "./golden-edge.js";

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
});