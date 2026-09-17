import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { RunEvent } from "./types.ts";

/**
 * Agents write markdown — tables especially — so the text they produce is
 * rendered. Tool input, results and metadata stay verbatim.
 */
const MARKDOWN_KINDS = new Set(["text", "user"]);

/**
 * Tool output is usually plain text, but some servers (Playwright's, say)
 * answer in Markdown. Headings, fences or bullets at line starts are the tell;
 * a bare `ls` or a stack trace has none of them.
 */
const LOOKS_LIKE_MARKDOWN = /^(#{1,6} |```|[-*] |\d+\. )/m;
const renderAsMarkdown = (it: Item) => MARKDOWN_KINDS.has(it.kind) || (it.kind === "result" && LOOKS_LIKE_MARKDOWN.test(it.body));

const MD_COMPONENTS = {
  p: (props: { children?: React.ReactNode }) => <p className="mb-2 last:mb-0" {...props} />,
  h1: (props: { children?: React.ReactNode }) => (
    <h1 className="mb-2 mt-3 text-base font-semibold first:mt-0" {...props} />
  ),
  h2: (props: { children?: React.ReactNode }) => (
    <h2 className="mb-2 mt-3 text-base font-semibold first:mt-0" {...props} />
  ),
  h3: (props: { children?: React.ReactNode }) => (
    <h3 className="mb-1.5 mt-3 text-sm font-semibold text-neutral-200 first:mt-0" {...props} />
  ),
  ul: (props: { children?: React.ReactNode }) => (
    <ul className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0" {...props} />
  ),
  ol: (props: { children?: React.ReactNode }) => (
    <ol className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0" {...props} />
  ),
  code: (props: { children?: React.ReactNode; className?: string }) =>
    props.className ? (
      <code {...props} />
    ) : (
      <code className="rounded bg-neutral-950/70 px-1 py-0.5 font-mono text-xs" {...props} />
    ),
  pre: (props: { children?: React.ReactNode }) => (
    <pre
      className="mb-2 overflow-x-auto rounded bg-neutral-950/70 p-2 font-mono text-xs last:mb-0"
      {...props}
    />
  ),
  // Tables are the main reason this exists; let a wide one scroll on its own.
  table: (props: { children?: React.ReactNode }) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-xs" {...props} />
    </div>
  ),
  th: (props: { children?: React.ReactNode }) => (
    <th className="border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-left font-medium" {...props} />
  ),
  td: (props: { children?: React.ReactNode }) => (
    <td className="border border-neutral-800 px-2 py-1 align-top" {...props} />
  ),
  a: (props: { children?: React.ReactNode; href?: string }) => (
    <a className="text-sky-400 underline" target="_blank" rel="noreferrer" {...props} />
  ),
  blockquote: (props: { children?: React.ReactNode }) => (
    <blockquote className="mb-2 border-l-2 border-neutral-700 pl-3 text-neutral-400 last:mb-0" {...props} />
  ),
  hr: () => <hr className="my-3 border-neutral-800" />,
};

type Item = { key: string; kind: string; label?: string; body: string };

/** Flattens raw SDKMessage events into things worth showing. */
function toItems(events: RunEvent[], meteredBilling: boolean): Item[] {
  const items: Item[] = [];
  for (const e of events) {
    const k = String(e.seq);
    if (e.type === "run.started") {
      // The prompt this run actually got — a typed one, or the agent's own with
      // any {{payload}} already filled in.
      const prompt = String(e.payload.prompt ?? "").trim();
      if (prompt) {
        items.push({ key: `${k}-prompt`, kind: "user", label: String(e.payload.trigger ?? "prompt"), body: prompt });
      }
      items.push({ key: k, kind: "meta", body: `Started in ${e.payload.cwd}` });
    } else if (e.type === "mcp.status") {
      const servers = e.payload.servers as { name: string; status: string; error?: string; toolCount?: number }[];
      items.push({
        key: k,
        kind: servers.some((s) => s.status === "failed" || s.status === "needs-auth") ? "error" : "meta",
        body: servers
          .map((s) => `${s.name}: ${s.status}${s.error ? ` (${s.error})` : ""}${s.toolCount != null ? ` · ${s.toolCount} tools` : ""}`)
          .join("\n"),
      });
    } else if (e.type === "approval.decided") {
      items.push({
        key: k,
        kind: "meta",
        body: `${e.payload.allow ? "Allowed" : "Denied"} ${e.payload.toolName}`,
      });
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
      // On a subscription login nothing is charged per run. The SDK still
      // reports what the tokens would have cost on the API, but a dollar figure
      // nobody is paying only confuses, so it shows on metered billing alone.
      const cost = e.payload.total_cost_usd;
      const money = cost && meteredBilling ? `, $${cost.toFixed(2)}` : "";
      items.push({
        key: k,
        kind: e.payload.is_error ? "error" : "meta",
        body: `Finished — ${e.payload.num_turns} turns${money}`,
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

export function Timeline({
  events,
  partial,
  meteredBilling = false,
}: {
  events: RunEvent[];
  partial: string;
  meteredBilling?: boolean;
}) {
  const items = toItems(events, meteredBilling);
  return (
    <div className="space-y-2">
      {items.map((it) => (
        <div key={it.key} className={`rounded border px-3 py-2 ${STYLES[it.kind] ?? STYLES.text}`}>
          {it.label && (
            <div
              className={`mb-1 font-mono text-xs uppercase tracking-wide ${
                it.kind === "user" ? "text-sky-400" : "text-amber-500"
              }`}
            >
              {it.label}
            </div>
          )}
          {renderAsMarkdown(it) ? (
            <div className="text-sm leading-relaxed">
              <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {it.body}
              </Markdown>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm">{it.body}</pre>
          )}
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
