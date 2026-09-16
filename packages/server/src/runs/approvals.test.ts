import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.BULLPEN_DATA = mkdtempSync(join(tmpdir(), "bullpen-test-"));

const { db } = await import("../db/index.ts");
const { agents, approvals, runs } = await import("../db/schema.ts");
const { runMigrations } = await import("../db/migrate.ts");
const { decideApproval, makeCanUseTool, pendingApprovals } = await import("./approvals.ts");

beforeAll(() => {
  runMigrations();
  db.insert(agents).values({ id: "a1", name: "test" }).run();
  db.insert(runs).values({ id: "r1", agentId: "a1", status: "running", trigger: "manual", prompt: "p" }).run();
});

function options(overrides: Record<string, unknown> = {}) {
  return {
    signal: new AbortController().signal,
    toolUseID: "tu-1",
    requestId: "req-1",
    ...overrides,
  } as never;
}

describe("approvals", () => {
  it("expires an unanswered prompt instead of holding the run open", async () => {
    const canUseTool = makeCanUseTool("r1", () => {}, 20);
    const decision = await canUseTool("Bash", { command: "ls" }, options({ toolUseID: "tu-timeout" }));

    expect(decision).toMatchObject({ behavior: "deny" });
    expect((decision as { message: string }).message).toContain("denied");
    expect(pendingApprovals("r1")).toHaveLength(0);
  });

  it("does not expire a prompt that was answered in time", async () => {
    const canUseTool = makeCanUseTool("r1", () => {}, 5_000);
    const decision = canUseTool("Write", { file_path: "/tmp/y" }, options({ toolUseID: "tu-fast" }));
    const [row] = pendingApprovals("r1");
    expect(decideApproval(row!.id, true)).toBe(true);
    expect(await decision).toEqual({ behavior: "allow" });
  });

  it("records a pending row and resolves once decided", async () => {
    const canUseTool = makeCanUseTool("r1", () => {});
    const decision = canUseTool("Write", { file_path: "/tmp/x" }, options());

    const [row] = pendingApprovals("r1");
    expect(row?.toolName).toBe("Write");

    expect(decideApproval(row!.id, true)).toBe(true);
    expect(await decision).toEqual({ behavior: "allow" });
    expect(pendingApprovals("r1")).toHaveLength(0);
  });

  it("passes the deny reason back to the model", async () => {
    const canUseTool = makeCanUseTool("r1", () => {});
    const decision = canUseTool("Bash", { command: "rm -rf /" }, options());
    const [row] = pendingApprovals("r1");

    decideApproval(row!.id, false, "absolutely not");
    expect(await decision).toEqual({ behavior: "deny", message: "absolutely not" });
  });

  it("refuses to decide the same approval twice", async () => {
    const canUseTool = makeCanUseTool("r1", () => {});
    const decision = canUseTool("Write", { file_path: "/tmp/y" }, options());
    const [row] = pendingApprovals("r1");

    expect(decideApproval(row!.id, true)).toBe(true);
    expect(decideApproval(row!.id, false)).toBe(false);
    await decision;
  });

  it("denies rather than hanging when the run is aborted", async () => {
    const abort = new AbortController();
    const canUseTool = makeCanUseTool("r1", () => {});
    const decision = canUseTool("Bash", { command: "sleep 999" }, options({ signal: abort.signal }));

    abort.abort();
    const result = await decision;
    expect(result).toMatchObject({ behavior: "deny" });
    expect(pendingApprovals("r1")).toHaveLength(0);
  });

  it("reports a row whose resolver died with a previous process as undecidable", () => {
    db.insert(approvals)
      .values({ id: "orphan", runId: "r1", requestId: "req-x", toolName: "Write", input: {} })
      .run();
    expect(decideApproval("orphan", true)).toBe(false);
    expect(pendingApprovals("r1")).toHaveLength(0);
  });

  it("returns false for an unknown id", () => {
    expect(decideApproval("nope", true)).toBe(false);
  });
});
