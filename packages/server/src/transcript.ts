/**
 * A run as a Markdown document — the same reading of the event log the
 * dashboard's timeline does, for a file that can be shared or pasted
 * somewhere. Raw events are the other export; this one is for people.
 */

type Ev = { seq: number; ts: number; type: string; payload: any };

type RunLike = {
  id: string;
  status: string;
  trigger: string;
  startedAt: number;
  label?: string | null;
  branch?: string | null;
  permissionMode?: string | null;
  model?: string | null;
  endedAt?: number | null;
  numTurns?: number | null;
  costUsd?: number | null;
};

const stamp = (s: number) => new Date(s * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

function fence(text: string, lang = ""): string {
  // A fence longer than any run of backticks inside keeps the block intact.
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text.replace(/\s+$/, "")}\n${f}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

export function renderTranscript(run: RunLike, agentName: string, events: Ev[]): string {
  const out: string[] = [];
  out.push(`# ${agentName} — run ${run.id.slice(0, 8)}`);
  out.push("");
  const facts: [string, string | null][] = [
    ["Status", run.status],
    ["Trigger", run.trigger],
    ["Label", run.label ?? null],
    ["Branch", run.branch ?? null],
    ["Model", run.model ?? null],
    ["Permission mode", run.permissionMode ?? null],
    ["Started", stamp(run.startedAt)],
    ["Ended", run.endedAt ? stamp(run.endedAt) : null],
    ["Turns", run.numTurns != null ? String(run.numTurns) : null],
    ["Cost", run.costUsd != null && run.costUsd > 0 ? `$${(run.costUsd / 1_000_000).toFixed(2)} at API rates` : null],
  ];
  for (const [k, v] of facts) if (v) out.push(`- **${k}:** ${v}`);
  out.push("");

  for (const e of events) {
    const p = e.payload ?? {};
    if (e.type === "run.started") {
      const prompt = String(p.prompt ?? "").trim();
      if (prompt) {
        out.push(`## Prompt (${p.trigger ?? "prompt"})`, "", prompt, "");
      }
      out.push(`_Started in \`${p.cwd}\`_`, "");
    } else if (e.type === "mcp.status") {
      const servers = (p.servers ?? []) as { name: string; status: string; error?: string; toolCount?: number }[];
      out.push(
        "_MCP: " +
          servers.map((s) => `${s.name} ${s.status}${s.error ? ` (${s.error})` : ""}${s.toolCount != null ? `, ${s.toolCount} tools` : ""}`).join("; ") +
          "_",
        "",
      );
    } else if (e.type === "approval.decided") {
      out.push(`_${p.allow ? "Allowed" : "Denied"} ${p.toolName}_`, "");
    } else if (e.type === "run.interrupted") {
      out.push(`> **Interrupted** — ${p.reason}`, "");
    } else if (e.type === "user.message") {
      out.push("## You", "", String(p.text ?? ""), "");
    } else if (e.type === "assistant") {
      for (const block of p.message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
          out.push(block.text.trim(), "");
        } else if (block.type === "thinking" && block.thinking?.trim()) {
          out.push("<details><summary>Thinking</summary>", "", block.thinking.trim(), "", "</details>", "");
        } else if (block.type === "tool_use") {
          out.push(`**${block.name}**`, "", fence(clip(JSON.stringify(block.input, null, 2), 4000), "json"), "");
        }
      }
    } else if (e.type === "user") {
      for (const block of p.message?.content ?? []) {
        if (block.type !== "tool_result") continue;
        const text =
          typeof block.content === "string"
            ? block.content
            : ((block.content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("");
        if (!text.trim()) continue;
        out.push(block.is_error ? "**Tool error**" : "Tool result", "", fence(clip(text, 4000)), "");
      }
    } else if (e.type === "result") {
      const cost = p.total_cost_usd ? `, ~$${Number(p.total_cost_usd).toFixed(2)} at API rates` : "";
      out.push(`_Finished — ${p.num_turns} turns${cost}${p.is_error ? " — with an error" : ""}_`, "");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** A file name that says what it is and sorts by time: `agent-2026-09-16T2305-1a2b3c4d.md`. */
export function exportFilename(agentName: string, run: { id: string; startedAt: number }, ext: string): string {
  const slug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "run";
  const when = new Date(run.startedAt * 1000).toISOString().slice(0, 16).replace(":", "");
  return `${slug}-${when}-${run.id.slice(0, 8)}.${ext}`;
}
