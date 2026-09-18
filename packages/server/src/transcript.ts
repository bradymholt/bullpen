/**
 * A run as a plain-text document — the same reading of the event log the
 * dashboard's timeline does, for a file that can be shared or pasted
 * somewhere. Plain text rather than Markdown because tool output is whatever
 * the tool printed, and a renderer would mangle half of it.
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

const RULE = "─".repeat(72);

/**
 * The server's own zone, not UTC: the container runs with a TZ set, so that is
 * the clock every timestamp an agent writes — into a report, an email, a
 * calendar event — is on. A transcript in UTC reads a day off from the run it
 * describes. The zone is named so the reading is never ambiguous, and a box
 * left on UTC still prints "UTC".
 */
const CLOCK = new Intl.DateTimeFormat("en-CA", {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false, timeZoneName: "short",
});
const stamp = (s: number) => {
  const p = Object.fromEntries(CLOCK.formatToParts(new Date(s * 1000)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${p.timeZoneName}`;
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

function indent(text: string): string {
  return text
    .replace(/\s+$/, "")
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

/** `metered`: an API key pays per token, so the cost is real; on a subscription it is left out. */
export function renderTranscript(run: RunLike, agentName: string, events: Ev[], metered = false): string {
  const out: string[] = [];
  out.push(`${agentName} — run ${run.id.slice(0, 8)}`);
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
    ["Cost", metered && run.costUsd != null && run.costUsd > 0 ? `$${(run.costUsd / 1_000_000).toFixed(2)}` : null],
  ];
  for (const [k, v] of facts) if (v) out.push(`${k}: ${v}`);
  out.push(RULE, "");

  for (const e of events) {
    const p = e.payload ?? {};
    if (e.type === "run.started") {
      const prompt = String(p.prompt ?? "").trim();
      if (prompt) out.push(`PROMPT (${p.trigger ?? "prompt"})`, indent(prompt), "");
      out.push(`[started in ${p.cwd}]`, "");
    } else if (e.type === "mcp.status") {
      const servers = (p.servers ?? []) as { name: string; status: string; error?: string; toolCount?: number }[];
      out.push(
        "[MCP: " +
          servers.map((s) => `${s.name} ${s.status}${s.error ? ` (${s.error})` : ""}${s.toolCount != null ? `, ${s.toolCount} tools` : ""}`).join("; ") +
          "]",
        "",
      );
    } else if (e.type === "approval.decided") {
      out.push(`[${p.allow ? "allowed" : "denied"} ${p.toolName}]`, "");
    } else if (e.type === "run.interrupted") {
      out.push(`[interrupted — ${p.reason}]`, "");
    } else if (e.type === "user.message") {
      out.push("YOU", indent(String(p.text ?? "")), "");
    } else if (e.type === "assistant") {
      for (const block of p.message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
          out.push(block.text.trim(), "");
        } else if (block.type === "thinking" && block.thinking?.trim()) {
          out.push("(thinking)", indent(block.thinking.trim()), "");
        } else if (block.type === "tool_use") {
          out.push(`▶ ${block.name}`, indent(clip(JSON.stringify(block.input, null, 2), 4000)), "");
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
        out.push(block.is_error ? "◀ error" : "◀ result", indent(clip(text, 4000)), "");
      }
    } else if (e.type === "artifacts") {
      out.push(`[${p.count} file${p.count === 1 ? "" : "s"} kept for download on the run page]`, "");
    } else if (e.type === "result") {
      const cost = metered && p.total_cost_usd ? `, $${Number(p.total_cost_usd).toFixed(2)}` : "";
      out.push(`[finished — ${p.num_turns} turns${cost}${p.is_error ? " — with an error" : ""}]`, "");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * A file name that says what it is and sorts by time: `agent-2026-09-16T2305-1a2b3c4d.txt`.
 * On the server's clock, like the stamps inside the file — a name an hour off
 * from its own header is how you end up looking for the wrong export.
 */
export function exportFilename(agentName: string, run: { id: string; startedAt: number }, ext: string): string {
  const slug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "run";
  const p = Object.fromEntries(CLOCK.formatToParts(new Date(run.startedAt * 1000)).map((x) => [x.type, x.value]));
  return `${slug}-${p.year}-${p.month}-${p.day}T${p.hour}${p.minute}-${run.id.slice(0, 8)}.${ext}`;
}
