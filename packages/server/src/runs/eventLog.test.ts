import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.BULLPEN_DATA = mkdtempSync(join(tmpdir(), "bullpen-test-"));

const { db } = await import("../db/index.ts");
const { agents, runs } = await import("../db/schema.ts");
const { runMigrations } = await import("../db/migrate.ts");
const { appendEvent, eventsSince } = await import("./eventLog.ts");

beforeAll(() => {
  runMigrations();
  db.insert(agents).values({ id: "a1", name: "test" }).run();
  for (const id of ["r1", "r2"]) {
    db.insert(runs).values({ id, agentId: "a1", status: "running", trigger: "manual", prompt: "p" }).run();
  }
});

describe("event log", () => {
  it("numbers events from 1 and increments per run", () => {
    appendEvent("r1", "assistant", { n: 1 });
    appendEvent("r1", "assistant", { n: 2 });
    appendEvent("r1", "result", { n: 3 });
    expect(eventsSince("r1", 0).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("keeps seq independent per run", () => {
    appendEvent("r2", "assistant", { n: 1 });
    expect(eventsSince("r2", 0).map((e) => e.seq)).toEqual([1]);
  });

  it("replays only what a reconnecting client is missing", () => {
    const tail = eventsSince("r1", 1);
    expect(tail.map((e) => e.seq)).toEqual([2, 3]);
    expect(tail.map((e) => e.type)).toEqual(["assistant", "result"]);
  });

  it("returns nothing when the client is already current", () => {
    expect(eventsSince("r1", 3)).toEqual([]);
  });

  it("round-trips the payload", () => {
    appendEvent("r2", "system", { subtype: "init", session_id: "s-1" });
    expect(eventsSince("r2", 1)[0]?.payload).toEqual({ subtype: "init", session_id: "s-1" });
  });
});
