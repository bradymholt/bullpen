import { afterEach, describe, expect, it, vi } from "vitest";
import { exportFilename, renderTranscript } from "./transcript.ts";

const run = {
  id: "1a2b3c4d-0000-4000-8000-000000000000",
  status: "completed",
  trigger: "manual",
  label: "acme/widgets #1",
  branch: null,
  permissionMode: "auto",
  model: null,
  startedAt: 1789600000,
  endedAt: 1789600042,
  numTurns: 2,
  costUsd: 21000,
};

describe("renderTranscript", () => {
  it("reads the event log the way the timeline does", () => {
    const txt = renderTranscript(run, "Code Review", [
      { seq: 1, ts: 1, type: "run.started", payload: { prompt: "Review the PR.", trigger: "manual", cwd: "/data/workspaces/x" } },
      { seq: 2, ts: 1, type: "mcp.status", payload: { servers: [{ name: "datadog-mcp", status: "connected", toolCount: 3 }] } },
      {
        seq: 3,
        ts: 2,
        type: "assistant",
        payload: { message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } },
      },
      { seq: 4, ts: 2, type: "user", payload: { message: { content: [{ type: "tool_result", content: "a.txt\nb.txt" }] } } },
      { seq: 5, ts: 3, type: "result", payload: { num_turns: 2, total_cost_usd: 0.021 } },
    ], true);
    expect(txt).toContain("Code Review — run 1a2b3c4d\n");
    expect(txt).toContain("Label: acme/widgets #1");
    expect(txt).toContain("Cost: $0.02");
    expect(txt).toContain("PROMPT (manual)\n    Review the PR.");
    expect(txt).toContain("[MCP: datadog-mcp connected, 3 tools]");
    expect(txt).toContain('▶ Bash\n    {\n      "command": "ls"\n    }');
    expect(txt).toContain("◀ result\n    a.txt\n    b.txt");
    expect(txt).toContain("[finished — 2 turns, $0.02]");
  });

  it("leaves money out on a subscription, where nothing is charged per run", () => {
    const txt = renderTranscript(run, "x", [{ seq: 1, ts: 3, type: "result", payload: { num_turns: 2, total_cost_usd: 0.021 } }]);
    expect(txt).not.toContain("$");
    expect(txt).toContain("[finished — 2 turns]");
  });

  it("keeps tool output verbatim, only indented", () => {
    const txt = renderTranscript(run, "x", [
      { seq: 1, ts: 1, type: "user", payload: { message: { content: [{ type: "tool_result", content: "### heading\n```js\nhi\n```" }] } } },
    ]);
    expect(txt).toContain("◀ result\n    ### heading\n    ```js\n    hi\n    ```");
  });

  it("names the file by agent, time and run", () => {
    expect(exportFilename("Code Review!", run, "txt")).toMatch(/^code-review-2026-\d\d-\d\dT\d{4}-1a2b3c4d\.txt$/);
  });
});

/**
 * The stamps have to match the clock the agent's own shell was on, or a
 * transcript reads a day off from the report the run emailed. The formatter is
 * built at module load, so each case needs a fresh import under its own TZ.
 */
describe("transcript timestamps", () => {
  // 2026-09-18 03:42:58 UTC — late the previous evening in Chicago, the case
  // where a UTC transcript and the email the run sent disagree about the date.
  const lateRun = { ...run, startedAt: 1789702978, endedAt: 1789703107 };
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  async function render(tz: string) {
    process.env.TZ = tz;
    vi.resetModules();
    const mod = await import("./transcript.ts");
    return { txt: mod.renderTranscript(lateRun, "x", []), name: mod.exportFilename("x", lateRun, "txt") };
  }

  it("stamps a run on the server's zone, not UTC", async () => {
    const { txt } = await render("America/Chicago");
    expect(txt).toContain("Started: 2026-09-17 22:42:58 CDT");
  });

  it("still says UTC on a box left on UTC", async () => {
    const { txt } = await render("UTC");
    expect(txt).toContain("Started: 2026-09-18 03:42:58 UTC");
  });

  it("names the export on the same clock as the stamps inside it", async () => {
    const { name } = await render("America/Chicago");
    expect(name).toBe("x-2026-09-17T2242-1a2b3c4d.txt");
  });
});
