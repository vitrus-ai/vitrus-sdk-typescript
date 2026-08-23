import { describe, expect, test } from "bun:test";
import { EdgeControlSession } from "./edge-control-session.js";

describe("EdgeControlSession", () => {
  test("holds an atomic bimanual scope and renews before expiry", async () => {
    const routes: string[] = [];
    let now = 0;
    const session = await EdgeControlSession.acquire({
      endpoint: "http://edge.test",
      robotId: "R06",
      leaseId: "lease-bimanual",
      jointNames: ["LEFT_SHOULDER_A", "RIGHT_SHOULDER_A"],
      durationMs: 2_000,
      refreshMs: 500,
      now: () => now,
      sleep: async durationMs => { now += durationMs; },
      fetch: (async (input) => {
        const path = new URL(String(input)).pathname;
        routes.push(path);
        if (path.endsWith("/acquire")) return Response.json({ ok: true, transport: "dora", acquired: true, lease_id: "lease-bimanual" });
        if (path.endsWith("/renew")) return Response.json({ ok: true, transport: "dora", renewed: true, lease_id: "lease-bimanual", duration_ms: 2_000 });
        if (path.endsWith("/release")) return Response.json({ ok: true, transport: "dora", released: true, lease_id: "lease-bimanual" });
        return Response.json({ ok: true, transport: "dora", stream: "joint_targets", sequence: routes.length });
      }) as typeof fetch,
    });
    const admissions = await session.hold([
      { joint_name: "LEFT_SHOULDER_A", position_deg: 1 },
      { joint_name: "RIGHT_SHOULDER_A", position_deg: -1 },
    ], { durationMs: 2_100 });
    await session.release();
    expect(admissions.length).toBeGreaterThanOrEqual(5);
    expect(routes.filter(path => path.endsWith("/renew")).length).toBeGreaterThanOrEqual(2);
    expect(routes.at(0)).toBe("/api/dora/acquire");
    expect(routes.at(-1)).toBe("/api/dora/release");
  });

  test("rejects targets outside the acquired scope", async () => {
    const session = await EdgeControlSession.acquire({
      endpoint: "http://edge.test",
      robotId: "R06",
      leaseId: "lease-a",
      jointNames: ["LEFT_SHOULDER_A"],
      fetch: (async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/acquire")) return Response.json({ ok: true, transport: "dora", acquired: true, lease_id: "lease-a" });
        if (path.endsWith("/release")) return Response.json({ ok: true, transport: "dora", released: true, lease_id: "lease-a" });
        return Response.json({ ok: true, transport: "dora", stream: "joint_targets" });
      }) as typeof fetch,
    });
    await expect(session.send([{ joint_name: "RIGHT_SHOULDER_A", position_deg: 0 }]))
      .rejects.toThrow("outside the acquired Edge scope");
    await session.release();
  });
});
