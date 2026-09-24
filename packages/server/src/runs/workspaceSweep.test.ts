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
const { sweepWorkspaces } = await import("./RunManager.ts");

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

  it("keeps failed runs and clones regardless of age", () => {
    const failed = run("failed", { status: "failed", endedAt: now - 99 * 3600 });
    const clone = run("clone", { endedAt: now - 99 * 3600, branch: "bullpen/x/clone" });
    expect(sweepWorkspaces()).toBe(0);
    expect(existsSync(failed)).toBe(true);
    expect(existsSync(clone)).toBe(true);
  });

  it("with retention 0, anything completed is due", () => {
    setWorkspaceRetentionHours(0);
    const path = run("zero", { endedAt: now });
    expect(sweepWorkspaces()).toBe(1);
    expect(existsSync(path)).toBe(false);
  });
});
