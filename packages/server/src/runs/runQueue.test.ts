import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

process.env.BULLPEN_DATA = mkdtempSync(join(tmpdir(), "bullpen-test-"));

const { db } = await import("../db/index.ts");
const { agents, runs } = await import("../db/schema.ts");
const { runMigrations } = await import("../db/migrate.ts");
const { QUEUE_DEPTH, QueueFullError, cancelQueued, drainQueue, requestRun } = await import("./RunManager.ts");

runMigrations();
const agent = () => db.select().from(agents).all()[0]!;

beforeEach(() => {
  db.delete(runs).run();
  db.delete(agents).run();
  db.insert(agents).values({ id: "q1", name: "queuer", concurrency: "queue", workspaceKind: "scratch", workspaceConfig: { kind: "scratch" } }).run();
  // Something is already running, so every request below must queue rather than start.
  db.insert(runs).values({ id: "active", agentId: "q1", status: "running", trigger: "manual", prompt: "p" }).run();
});

describe("queue concurrency", () => {
  it("parks a request as a queued row with its payload spooled, while a run is active", () => {
    const r = requestRun({ agent: agent() as never, trigger: "webhook", prompt: "hello", rawPayload: '{"a":1}', label: "x #1" });
    expect(r.queued).toBe(true);
    const row = db.select().from(runs).all().find((x) => x.id === r.runId)!;
    expect(row).toMatchObject({ status: "queued", prompt: "hello", label: "x #1" });
    expect(existsSync(join(process.env.BULLPEN_DATA!, "queue", `${r.runId}.json`))).toBe(true);
  });

  it("drains oldest first, exactly one at a time, handing the spooled payload to the starter", () => {
    const first = requestRun({ agent: agent() as never, trigger: "webhook", prompt: "one", rawPayload: "P1" }).runId;
    const second = requestRun({ agent: agent() as never, trigger: "webhook", prompt: "two", rawPayload: "P2" }).runId;
    // The active run finishes; make the order unambiguous.
    db.delete(runs).where(eq(runs.id, "active")).run();
    db.update(runs).set({ startedAt: 100 }).where(eq(runs.id, first)).run();
    db.update(runs).set({ startedAt: 200 }).where(eq(runs.id, second)).run();

    const started: { id: string; prompt?: string; rawPayload?: string }[] = [];
    drainQueue("q1", (opts, id) => {
      started.push({ id, prompt: opts.prompt, rawPayload: opts.rawPayload });
      db.update(runs).set({ status: "running" }).where(eq(runs.id, id)).run();
      return id;
    });
    // Only the oldest starts; the second waits for it, and its spool is what the starter got.
    expect(started).toEqual([{ id: first, prompt: "one", rawPayload: "P1" }]);
    expect(db.select().from(runs).all().find((r) => r.id === second)?.status).toBe("queued");
    expect(existsSync(join(process.env.BULLPEN_DATA!, "queue", `${first}.json`))).toBe(false);
  });

  it("refuses beyond the depth cap rather than queuing forever", () => {
    for (let i = 0; i < QUEUE_DEPTH; i++) requestRun({ agent: agent() as never, trigger: "cron" });
    expect(() => requestRun({ agent: agent() as never, trigger: "cron" })).toThrow(QueueFullError);
  });

  it("cancels a queued run by deleting it, and refuses to touch a live one", () => {
    const { runId } = requestRun({ agent: agent() as never, trigger: "manual" });
    expect(cancelQueued(runId)).toBe(true);
    expect(db.select().from(runs).all().some((r) => r.id === runId)).toBe(false);
    expect(cancelQueued("active")).toBe(false);
  });
});
