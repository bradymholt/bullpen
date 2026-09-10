import type { RunEvent } from "./types.ts";

type Item = { key: string; kind: string; label?: string; body: string };

/** Flattens raw SDKMessage events into things worth showing. */
function toItems(events: RunEvent[]): Item[] {
  const items: Item[] = [];
  for (const e of events) {
    const k = String(e.seq);
    if (e.type === "run.started") {
      items.push({ key: k, kind: "meta", body: `Started in ${e.payload.cwd}` });
    } else if (e.type === "run.interrupted") {
      items.push({ key: k, kind: "error", body: `Interrupted — ${e.payload.reason}` });
    } else if (e.type === "user.message") {
      items.push({ key: k, kind: "user", body: e.payload.text });
    } else if (e.type === "assistant") {
      for (const [i, block] of (e.payload.message?.content ?? []).entries()) {
        if (block.type === "text" && block.text.trim()) {
          items.push({ key: `${k}-${i}`, kind: "text", body: block.text });
        } else if (block.type === "thinking" && block.thinking?.trim()) {
          items.push({ key: `${k}-${i}`, kind: "thinking", body: block.thinking });
        } else if (block.type === "tool_use") {
          items.push({
            key: `${k}-${i}`,
            kind: "tool",
            label: block.name,
            body: JSON.stringify(block.input, null, 2),
          });
        }
      }
    } else if (e.type === "user") {
      for (const [i, block] of (e.payload.message?.content ?? []).entries()) {
        if (block.type !== "tool_result") continue;
        const text =
          typeof block.content === "string"
            ? block.content
            : (block.content ?? []).map((c: any) => c.text ?? "").join("");
        items.push({
          key: `${k}-${i}`,
          kind: block.is_error ? "error" : "result",
          body: text.slice(0, 4000),
        });
      }
    } else if (e.type === "result") {
      const cost = e.payload.total_cost_usd;
      items.push({
        key: k,
        kind: e.payload.is_error ? "error" : "meta",
        body: `Finished — ${e.payload.num_turns} turns${cost ? `, $${cost.toFixed(4)}` : ""}`,
      });
    }
  }
  return items;
}

const STYLES: Record<string, string> = {
  user: "border-sky-700 bg-sky-950/40",
  text: "border-neutral-700 bg-neutral-900",
  thinking: "border-violet-900 bg-violet-950/30 text-violet-300 italic",
  tool: "border-amber-900 bg-amber-950/20",
  result: "border-neutral-800 bg-neutral-900/50 text-neutral-400",
  error: "border-red-900 bg-red-950/30 text-red-300",
  meta: "border-neutral-800 bg-transparent text-neutral-500 text-xs",
};

export function Timeline({ events, partial }: { events: RunEvent[]; partial: string }) {
  const items = toItems(events);
  return (
    <div className="space-y-2">
      {items.map((it) => (
        <div key={it.key} className={`rounded border px-3 py-2 ${STYLES[it.kind] ?? STYLES.text}`}>
          {it.label && (
            <div className="mb-1 font-mono text-xs uppercase tracking-wide text-amber-500">{it.label}</div>
          )}
          <pre className="whitespace-pre-wrap break-words font-sans text-sm">{it.body}</pre>
        </div>
      ))}
      {partial && (
        <div className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm">
            {partial}
            <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-neutral-400 align-text-bottom" />
          </pre>
        </div>
      )}
    </div>
  );
}
