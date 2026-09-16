import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

process.env.BULLPEN_DATA = mkdtempSync(join(tmpdir(), "bullpen-test-"));

const { db } = await import("../db/index.ts");
const { agents, spaceSecrets, webhookDeliveries } = await import("../db/schema.ts");
const { runMigrations } = await import("../db/migrate.ts");
const { api } = await import("./api.ts");

runMigrations();

const SECRET = "shared-org-webhook-secret";

/** Every case here is one the filters reject, so no run is ever started. */
function post(space: string, event: string, payload: unknown, secret = SECRET) {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return api.request(`/hooks/space/${space}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sig,
      "x-github-event": event,
      "x-github-delivery": crypto.randomUUID(),
    },
    body,
  });
}

beforeEach(() => {
  db.delete(agents).run();
  db.delete(webhookDeliveries).run();
  db.delete(spaceSecrets).run();
  db.insert(agents).values([
    {
      id: "a1", name: "Reviewer", space: "work", enabled: true,
      trigger: "webhook", webhookMode: "github", webhookSecret: SECRET,
      filters: [{ path: "action", op: "in", values: ["review_requested"] }],
    },
    {
      id: "a2", name: "Dependabot", space: "work", enabled: true,
      trigger: "webhook", webhookMode: "github", webhookSecret: SECRET,
      filters: [{ path: "action", op: "in", values: ["opened"] }],
    },
    {
      id: "a3", name: "Elsewhere", space: "personal", enabled: true,
      trigger: "webhook", webhookMode: "github", webhookSecret: SECRET,
      filters: [{ path: "action", op: "in", values: ["closed"] }],
    },
  ]).run();
});

describe("POST /hooks/space/:space", () => {
  it("401s on a space with no agents, without revealing that it is empty", async () => {
    const res = await post("ghost", "pull_request", { action: "closed" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("401s when the secret matches nobody in the space", async () => {
    expect((await post("work", "pull_request", { action: "closed" }, "wrong")).status).toBe(401);
  });

  it("consults every agent in the space and nobody outside it", async () => {
    const res = await post("work", "pull_request", { action: "closed" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ran: unknown[]; skipped: { agentId: string }[] };
    expect(body.ran).toEqual([]);
    expect(body.skipped.map((s) => s.agentId).sort()).toEqual(["a1", "a2"]);
  });

  it("verifies against the space secret when one is set, not each agent's", async () => {
    const shared = "the-space-owns-this-secret";
    db.insert(spaceSecrets).values({ space: "work", secret: shared }).run();
    // Agents keep their own, different secrets; the space secret is what counts.
    db.update(agents).set({ webhookSecret: "a1-private-secret-value" }).run();

    const good = await post("work", "pull_request", { action: "closed" }, shared);
    expect(good.status).toBe(202);
    const body = (await good.json()) as { skipped: { agentId: string; reason: string }[] };
    expect(body.skipped.map((s) => s.agentId).sort()).toEqual(["a1", "a2"]);
    expect(body.skipped.every((s) => s.reason.includes("filter"))).toBe(true);

    expect((await post("work", "pull_request", { action: "closed" }, SECRET)).status).toBe(401);
  });

  it("answers a ping without consulting filters", async () => {
    expect((await post("work", "ping", { zen: "hello" })).status).toBe(200);
  });

  it("records a dropped delivery per agent so the miss is visible", async () => {
    await post("work", "pull_request", { action: "closed" });
    const rows = db.select().from(webhookDeliveries).all();
    expect(rows.filter((r) => r.agentId === "a1")).toHaveLength(1);
    expect(rows.filter((r) => r.agentId === "a2")).toHaveLength(1);
    expect(rows.every((r) => r.accepted === false)).toBe(true);
  });
});
