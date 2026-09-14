import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.BULLPEN_DATA = mkdtempSync(join(tmpdir(), "bullpen-test-"));

const started: { trigger: string; prompt: string }[] = [];
vi.mock("../runs/RunManager.ts", () => ({
  agentHasActiveRun: () => false,
  startRun: (opts: { trigger: string; prompt: string }) => {
    started.push({ trigger: opts.trigger, prompt: opts.prompt });
    return "run-1";
  },
}));

const { db } = await import("../db/index.ts");
const { runMigrations } = await import("../db/migrate.ts");
runMigrations();
const { agents } = await import("../db/schema.ts");
const { eq } = await import("drizzle-orm");
const { pollOnce } = await import("./poll.ts");

let seq = 0;
function makeAgent(over: Record<string, unknown> = {}) {
  const id = `poll-${++seq}`;
  db.insert(agents)
    .values({ id, name: id, prompt: "Saw: {{payload.status}}", pollUrl: "https://example.test/x", ...over } as never)
    .run();
  return db.select().from(agents).where(eq(agents.id, id)).get()!;
}

function respond(body: string, status = 200) {
  vi.stubGlobal("fetch", async () => new Response(body, { status }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  started.length = 0;
});

describe("poll", () => {
  it("primes on the first check instead of firing", async () => {
    respond('{"status":"green"}');
    const outcome = await pollOnce(makeAgent());
    expect(outcome).toMatchObject({ kind: "primed" });
    expect(started).toHaveLength(0);
  });

  it("stays quiet while the response is identical", async () => {
    respond('{"status":"green"}');
    const agent = makeAgent();
    await pollOnce(agent);
    const primed = db.select().from(agents).where(eq(agents.id, agent.id)).get()!;
    expect(await pollOnce(primed)).toMatchObject({ kind: "unchanged" });
    expect(started).toHaveLength(0);
  });

  it("fires once when the response changes, with the body as data", async () => {
    respond('{"status":"green"}');
    const agent = makeAgent();
    await pollOnce(agent);
    respond('{"status":"red"}');
    const primed = db.select().from(agents).where(eq(agents.id, agent.id)).get()!;
    expect(await pollOnce(primed)).toMatchObject({ kind: "changed", runId: "run-1" });
    expect(started).toEqual([{ trigger: "poll", prompt: "Saw: red" }]);
  });

  it("watches only the path it was given", async () => {
    respond('{"status":"green","noise":1}');
    const agent = makeAgent({ pollPath: "status" });
    await pollOnce(agent);
    respond('{"status":"green","noise":2}');
    const primed = db.select().from(agents).where(eq(agents.id, agent.id)).get()!;
    expect(await pollOnce(primed)).toMatchObject({ kind: "unchanged" });
    expect(started).toHaveLength(0);
  });

  it("records a failure without losing the last known state", async () => {
    respond('{"status":"green"}');
    const agent = makeAgent();
    await pollOnce(agent);
    const primed = db.select().from(agents).where(eq(agents.id, agent.id)).get()!;
    respond("boom", 500);
    expect(await pollOnce(primed)).toMatchObject({ kind: "failed" });
    const after = db.select().from(agents).where(eq(agents.id, agent.id)).get()!;
    expect(after.pollState).toBe(primed.pollState);
    expect(after.pollStatus).toMatch(/error/);
  });

  it("never polls a disabled agent", async () => {
    respond("{}");
    expect(await pollOnce(makeAgent({ enabled: false }))).toMatchObject({ kind: "skipped" });
  });
});
