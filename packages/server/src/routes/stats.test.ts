import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.BULLPEN_DATA = mkdtempSync(join(tmpdir(), "bullpen-test-"));

const { db } = await import("../db/index.ts");
const { agents, runs } = await import("../db/schema.ts");
const { runMigrations } = await import("../db/migrate.ts");
const { api } = await import("./api.ts");

const now = Math.floor(Date.now() / 1000);

beforeAll(() => {
  runMigrations();
  db.insert(agents).values([{ id: "busy", name: "busy" }, { id: "quiet", name: "quiet" }]).run();
  // `quiet` failed two days ago; `busy` has run many times since. Reading the
  // newest N runs would never see `quiet` at all.
  db.insert(runs).values({ id: "q1", agentId: "quiet", status: "failed", trigger: "cron", prompt: "p", startedAt: now - 172_000, costUsd: 5_000_000 }).run();
  for (let i = 0; i < 60; i++) {
    db.insert(runs).values({ id: `b${i}`, agentId: "busy", status: i === 0 ? "running" : "completed", trigger: "webhook", prompt: "p", startedAt: now - i * 60, costUsd: 250_000 }).run();
  }
});

describe("GET /stats", () => {
  it("reports each agent's newest run even when other agents have buried it", async () => {
    const s = (await (await api.request("/stats")).json()) as { latest: Record<string, { id: string; status: string }> };
    expect(s.latest.quiet).toMatchObject({ id: "q1", status: "failed" });
    expect(s.latest.busy).toMatchObject({ id: "b0", status: "running" });
  });

  it("counts active runs per agent", async () => {
    const s = (await (await api.request("/stats")).json()) as { active: Record<string, number> };
    expect(s.active).toEqual({ busy: 1 });
  });

  it("converts micro-dollar cost to dollars over the last 24h only", async () => {
    const s = (await (await api.request("/stats")).json()) as { spend24h: number; last24h: number };
    // 60 × $0.25 today; quiet's $5 was two days ago and is excluded.
    expect(s.spend24h).toBeCloseTo(15, 5);
    expect(s.last24h).toBe(60);
  });
});
