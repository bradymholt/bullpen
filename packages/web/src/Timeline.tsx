import { useState } from "react";
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

/**
 * Links in agent and tool output are written relative to the workspace —
 * Playwright's "[Screenshot](.bullpen/out/x.png)" — and the browser would
 * resolve them against the page URL, which the SPA answers with itself. Into
 * .bullpen/out they become artifact downloads; other relative paths become
 * plain text, since nothing they could point at is reachable.
 */
function artifactHref(runId: string | undefined, href: string | undefined): string | null {
  if (!href) return null;
  if (/^(https?:|mailto:|#)/i.test(href)) return href;
  const m = /^(?:\.\/)?\.bullpen\/out\/(.+)$/.exec(href);
  if (m && runId) return `/api/runs/${runId}/artifacts/${m[1]!.split("/").map(encodeURIComponent).join("/")}`;
  return null;
}

function mdComponents(runId: string | undefined) {
  return {
    ...MD_COMPONENTS,
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      const to = artifactHref(runId, href);
      if (!to) return <span className="text-neutral-300">{children}</span>;
      const download = to.startsWith("/api/");
      return (
        <a href={to} target={download ? undefined : "_blank"} rel="noreferrer" download={download || undefined} className="underline decoration-neutral-600 hover:text-white">
          {children}
        </a>
      );
    },
    img: ({ src, alt }: { src?: string; alt?: string }) => {
      const to = artifactHref(runId, src);
      if (!to) return <span className="text-neutral-500">[image: {alt || src}]</span>;
      // Ask for the inline disposition: a screenshot here is meant to be looked at.
      return <img src={to.startsWith("/api/") ? `${to}?inline=1` : to} alt={alt ?? ""} className="my-2 max-h-96 rounded border border-neutral-800" />;
    },
  };
}

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
      // Rendered by McpStatusItem: one summary line, the full list on demand.
      items.push({ key: k, kind: "mcp", body: JSON.stringify(e.payload.servers ?? []) });
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

type McpServer = { name: string; status: string; error?: string; toolCount?: number };

/** Twenty connectors with their auth state is noise on every run; the counts are the signal. */
function McpStatusItem({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  const servers = JSON.parse(body) as McpServer[];
  const by = (s: string) => servers.filter((x) => x.status === s).length;
  const failed = by("failed");
  const needsAuth = by("needs-auth");
  const parts = [
    `${by("connected")} connected`,
    needsAuth ? `${needsAuth} need auth` : null,
    by("pending") ? `${by("pending")} pending` : null,
    failed ? `${failed} failed` : null,
  ].filter(Boolean);
  const tone = failed ? "border-red-900 bg-red-950/30 text-red-300" : needsAuth ? "border-amber-900/60 bg-amber-950/10 text-amber-400/90" : "border-neutral-800 text-neutral-500";
  return (
    <div className={`rounded border px-3 py-2 text-xs ${tone}`}>
      <button onClick={() => setOpen((v) => !v)} className="hover:text-white">
        {open ? "\u25be" : "\u25b8"} MCP: {parts.join(" \u00b7 ")}
      </button>
      {open && (
        <ul className="mt-1.5 space-y-0.5 font-mono">
          {servers.map((s) => (
            <li key={s.name} className={s.status === "connected" ? "text-neutral-400" : s.status === "failed" ? "text-red-300" : "text-amber-400/90"}>
              {s.name}: {s.status}
              {s.error ? ` (${s.error})` : ""}
              {s.toolCount != null ? ` \u00b7 ${s.toolCount} tools` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
  runId,
}: {
  events: RunEvent[];
  partial: string;
  meteredBilling?: boolean;
  /** Lets relative links into .bullpen/out resolve to this run's downloads. */
  runId?: string;
}) {
  const components = mdComponents(runId);
  const items = toItems(events, meteredBilling);
  return (
    <div className="space-y-2">
      {items.map((it) => it.kind === "mcp" ? <McpStatusItem key={it.key} body={it.body} /> : (
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
              <Markdown remarkPlugins={[remarkGfm]} components={components}>
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
