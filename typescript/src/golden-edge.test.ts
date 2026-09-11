import { describe, expect, test } from "bun:test";
import { GoldenEdgeClient, GoldenEdgeRequestTimeoutError } from "./golden-edge.js";

describe("GoldenEdgeClient", () => {
  test("keeps the Window receiver when using the ambient browser fetch", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Can only call Window.fetch on instances of Window");
      return Promise.resolve(new Response(JSON.stringify({ ok: true, transport: "dora", stream: "joint_targets" })));
    }) as typeof fetch;
    try {
      const client = new GoldenEdgeClient({
        endpoint: "http://r-05-edge:8782", robotId: "R06.cannon", leaseId: "lease-1",
      });
      await expect(client.health()).resolves.toMatchObject({ ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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

  test("rejects a false HTTP acknowledgement when the broker deadman is active", async () => {
    const client = new GoldenEdgeClient({
      endpoint: "http://r-05-edge:8782", robotId: "R06.cannon", leaseId: "lease-1",
      fetch: (async () => new Response(JSON.stringify({
        ok: true, transport: "dora", stream: "joint_targets", sequence: 9,
        broker: { access_mode: "read_write", deadman: { active: true }, plan: { active: false }, rejected: [] },
      }))) as typeof fetch,
    });
    expect(client.sendJointTargets([{ joint_name: "LEFT_SHOULDER_C", position_deg: -12 }]))
      .rejects.toThrow("deadman is active");
  });

  test("accepts broker evidence only when the robot-local plan is active", async () => {
    const client = new GoldenEdgeClient({
      endpoint: "http://r-05-edge:8782", robotId: "R06.cannon", leaseId: "lease-1",
      fetch: (async () => new Response(JSON.stringify({
        ok: true, transport: "dora", stream: "joint_targets", sequence: 10,
        broker: { access_mode: "read_write", deadman: { active: false }, plan: { active: true }, rejected: [] },
      }))) as typeof fetch,
    });
    await expect(client.sendJointTargets([{ joint_name: "LEFT_SHOULDER_C", position_deg: -12 }]))
      .resolves.toMatchObject({ sequence: 10 });
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

  test("treats release of a superseded lease as an idempotent no-op", async () => {
    const client = new GoldenEdgeClient({
      endpoint: "http://r-05-edge:8782", robotId: "R06.cannon", leaseId: "lease-old",
      fetch: (async () => new Response(JSON.stringify({
        ok: true, transport: "dora", released: false, superseded: true, lease_id: "lease-old",
      }))) as typeof fetch,
    });
    await expect(client.release("lease-old")).resolves.toMatchObject({ superseded: true });
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
