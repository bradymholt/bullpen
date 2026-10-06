import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

process.env.BULLPEN_DATA = mkdtempSync(join(tmpdir(), "bullpen-test-"));

const { db } = await import("../db/index.ts");
const { agents, runs } = await import("../db/schema.ts");
const { runMigrations } = await import("../db/migrate.ts");
const { config } = await import("../config.ts");
const { setWorkspaceRetentionHours } = await import("../env.ts");
const { sweepMergedClones, sweepWorkspaces } = await import("./RunManager.ts");

runMigrations();
const now = Math.floor(Date.now() / 1000);

function run(id: string, fields: { status?: string; endedAt?: number; branch?: string }) {
  const path = join(config.workspacesDir, id);
  mkdirSync(path, { recursive: true });
  db.insert(runs)
    .values({ id, agentId: "a1", status: fields.status ?? "completed", trigger: "manual", prompt: "p", workspacePath: path, endedAt: fields.endedAt, branch: fields.branch })
    .run();
  return path;
}

beforeEach(() => {
  db.delete(runs).run();
  db.delete(agents).run();
  db.insert(agents).values({ id: "a1", name: "sweeper", workspaceKind: "ephemeral", workspaceConfig: { kind: "ephemeral" } }).run();
  setWorkspaceRetentionHours(24);
});

describe("sweepWorkspaces", () => {
  it("removes a completed fresh directory only once the retention window has passed", () => {
    const old = run("old", { endedAt: now - 25 * 3600 });
    const recent = run("recent", { endedAt: now - 3600 });
    expect(sweepWorkspaces()).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("keeps clones regardless of age", () => {
    const clone = run("clone", { endedAt: now - 999 * 3600, branch: "bullpen/x/clone" });
    expect(sweepWorkspaces()).toBe(0);
    expect(existsSync(clone)).toBe(true);
  });

  it("keeps runs that did not complete for the longer failed-run window", () => {
    const recent = run("failed-recent", { status: "failed", endedAt: now - 99 * 3600 });
    const old = run("failed-old", { status: "failed", endedAt: now - 8 * 24 * 3600 });
    const interrupted = run("interrupted-old", { status: "interrupted", endedAt: now - 8 * 24 * 3600 });
    expect(sweepWorkspaces()).toBe(2);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(interrupted)).toBe(false);
  });

  it("never sweeps a failure sooner than a success", () => {
    setWorkspaceRetentionHours(10 * 24);
    const failed = run("failed-9d", { status: "failed", endedAt: now - 9 * 24 * 3600 });
    expect(sweepWorkspaces()).toBe(0);
    expect(existsSync(failed)).toBe(true);
  });

  it("leaves active and queued runs alone", () => {
    const active = run("running", { status: "running", endedAt: now - 99 * 24 * 3600 });
    const queued = run("queued", { status: "queued" });
    expect(sweepWorkspaces()).toBe(0);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(queued)).toBe(true);
  });

  it("with retention 0, anything completed is due but failures still wait", () => {
    setWorkspaceRetentionHours(0);
    const path = run("zero", { endedAt: now });
    const failed = run("zero-failed", { status: "failed", endedAt: now });
    expect(sweepWorkspaces()).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(failed)).toBe(true);
  });
});

describe("sweepMergedClones", () => {
  it("removes an aged clone only once its pull request is closed", async () => {
    const merged = run("merged", { endedAt: now - 25 * 3600, branch: "bullpen/x/merged" });
    const open = run("open", { endedAt: now - 25 * 3600, branch: "bullpen/x/open" });
    const unpulled = run("unpulled", { endedAt: now - 25 * 3600, branch: "bullpen/x/unpulled" });
    const recent = run("recent-merged", { endedAt: now - 3600, branch: "bullpen/x/recent" });
    const states: Record<string, "open" | "closed" | "none"> = {
      "bullpen/x/merged": "closed",
      "bullpen/x/open": "open",
      "bullpen/x/unpulled": "none",
      "bullpen/x/recent": "closed",
    };
    const asked: string[] = [];
    const lookup = async (_cwd: string, branch: string) => {
      asked.push(branch);
      return states[branch]!;
    };
    expect(await sweepMergedClones(lookup)).toBe(1);
    expect(existsSync(merged)).toBe(false);
    expect(existsSync(open)).toBe(true);
    expect(existsSync(unpulled)).toBe(true);
    expect(existsSync(recent)).toBe(true);

    asked.length = 0;
    expect(await sweepMergedClones(lookup)).toBe(0);
    expect(asked).toEqual(["bullpen/x/open"]);
  });

  it("keeps a clone when the lookup fails", async () => {
    const clone = run("lookup-fails", { endedAt: now - 25 * 3600, branch: "bullpen/x/fails" });
    expect(await sweepMergedClones(async () => { throw new Error("no token"); })).toBe(0);
    expect(existsSync(clone)).toBe(true);
  });
});
