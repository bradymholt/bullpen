import { describe, expect, it } from "vitest";
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
    const md = renderTranscript(run, "Code Review", [
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
    ]);
    expect(md).toContain("# Code Review — run 1a2b3c4d");
    expect(md).toContain("- **Label:** acme/widgets #1");
    expect(md).toContain("- **Cost:** $0.02 at API rates");
    expect(md).toContain("## Prompt (manual)\n\nReview the PR.");
    expect(md).toContain("_MCP: datadog-mcp connected, 3 tools_");
    expect(md).toContain("**Bash**\n\n```json\n{\n  \"command\": \"ls\"\n}\n```");
    expect(md).toContain("Tool result\n\n```\na.txt\nb.txt\n```");
    expect(md).toContain("_Finished — 2 turns, ~$0.02 at API rates_");
  });

  it("fences text that itself contains fences", () => {
    const md = renderTranscript(run, "x", [
      { seq: 1, ts: 1, type: "user", payload: { message: { content: [{ type: "tool_result", content: "```js\nhi\n```" }] } } },
    ]);
    expect(md).toContain("````\n```js\nhi\n```\n````");
  });

  it("names the file by agent, time and run", () => {
    expect(exportFilename("Code Review!", run, "md")).toMatch(/^code-review-2026-\d\d-\d\dT\d{4}-1a2b3c4d\.md$/);
  });
});
