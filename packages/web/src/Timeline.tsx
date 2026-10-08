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
const LOOKS_LIKE_DIFF = /^(diff --git |@@ )/m;
const isMarkdownOutput = (text: string) => LOOKS_LIKE_MARKDOWN.test(text) && !LOOKS_LIKE_DIFF.test(text);
const renderAsMarkdown = (it: Item) => MARKDOWN_KINDS.has(it.kind) || (it.kind === "result" && isMarkdownOutput(it.body));

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

type Item = {
  key: string;
  kind: string;
  label?: string;
  body: string;
  ts?: number;
  input?: Record<string, unknown>;
  result?: { body: string; isError: boolean };
  /** Work a subagent did on the parent's behalf, nested under its Agent call. */
  sub?: boolean;
};

/** Flattens raw SDKMessage events into things worth showing. */
function toItems(events: RunEvent[], meteredBilling: boolean): Item[] {
  const items: Item[] = [];
  const calls = new Map<string, Item>();
  for (const e of events) {
    const start = items.length;
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
    } else if (e.type === "run.merged") {
      items.push({ key: k, kind: "meta", body: "Another delivery for the same thing arrived — running on the latest one" });
    } else if (e.type === "run.skipped") {
      items.push({ key: k, kind: "meta", body: "Skipped — another run was still going when the wait ended" });
    } else if (e.type === "run.restarted") {
      items.push({
        key: k,
        kind: "meta",
        body: e.payload.resumed ? "Restarted — resuming the session" : "Restarted — starting over on the original prompt",
      });
    } else if (e.type === "user.message") {
      items.push({ key: k, kind: "user", body: e.payload.text });
    } else if (e.type === "assistant") {
      for (const [i, block] of (e.payload.message?.content ?? []).entries()) {
        if (block.type === "text" && block.text.trim()) {
          items.push({ key: `${k}-${i}`, kind: "text", body: block.text });
        } else if (block.type === "thinking" && block.thinking?.trim()) {
          items.push({ key: `${k}-${i}`, kind: "thinking", body: block.thinking });
        } else if (block.type === "tool_use") {
          const call: Item = { key: `${k}-${i}`, kind: "tool", label: block.name, body: "", input: block.input ?? {} };
          calls.set(block.id, call);
          items.push(call);
        }
      }
    } else if (e.type === "user") {
      for (const [i, block] of (e.payload.message?.content ?? []).entries()) {
        if (block.type !== "tool_result") continue;
        const text =
          typeof block.content === "string"
            ? block.content
            : (block.content ?? []).map((c: any) => c.text ?? "").join("");
        const call = calls.get(block.tool_use_id);
        if (call) {
          call.result = { body: text.slice(0, 4000), isError: !!block.is_error };
          continue;
        }
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
    const sub = (e.type === "assistant" || e.type === "user") && !!e.payload.parent_tool_use_id;
    for (let i = start; i < items.length; i++) {
      items[i]!.ts = e.ts;
      items[i]!.sub = sub;
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

/** The field that says what a call is for, shown beside the tool name. */
const SUMMARY_KEYS = ["description", "file_path", "path", "skill", "url", "pattern", "query"];

/** Whole-output JSON, or JSON lines (`gh api ... ; gh api ...`), pretty-printed; anything else untouched. */
function prettyJson(text: string): string {
  const parse = (s: string) => {
    const t = s.trim();
    if (!/^[[{]/.test(t)) return null;
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      return null;
    }
  };
  return parse(text) ?? text.split("\n").map((line) => parse(line) ?? line).join("\n");
}

/** Long output starts folded so one `gh pr diff` doesn't bury the rest of the run. */
function Fold({ text, children }: { text: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n").length;
  if (lines <= 16 && text.length <= 1500) return <>{children}</>;
  return (
    <div>
      <div className={open ? undefined : "max-h-64 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"}>
        {children}
      </div>
      <button onClick={() => setOpen((v) => !v)} className="mt-1 text-xs text-neutral-500 hover:text-white">
        {open ? "Show less" : `Show all ${lines} lines`}
      </button>
    </div>
  );
}

function FieldValue({ name, value, components }: { name: string; value: unknown; components: ReturnType<typeof mdComponents> }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (name === "prompt") {
    return (
      <Fold text={text}>
        <div className="text-sm leading-relaxed text-neutral-300">
          <Markdown remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown>
        </div>
      </Fold>
    );
  }
  return (
    <Fold text={text}>
      <pre className="whitespace-pre-wrap break-words rounded bg-neutral-950/70 p-2 font-mono text-xs text-neutral-200">{text}</pre>
    </Fold>
  );
}

function ToolItem({ it, components }: { it: Item; components: ReturnType<typeof mdComponents> }) {
  const input = it.input ?? {};
  const summaryKey = SUMMARY_KEYS.find((key) => typeof input[key] === "string");
  const subagent = typeof input.subagent_type === "string" ? input.subagent_type : null;
  const summary = [subagent, summaryKey ? (input[summaryKey] as string) : null].filter(Boolean).join(" · ");
  const rest = Object.entries(input).filter(([key]) => key !== summaryKey && key !== "subagent_type");
  const flags = rest.filter(([, v]) => typeof v === "boolean" || typeof v === "number");
  const fields = rest.filter(([, v]) => typeof v !== "boolean" && typeof v !== "number");
  const result = it.result;
  const shown = result ? prettyJson(result.body) : "";
  return (
    <>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-xs uppercase tracking-wide text-amber-500">{it.label}</span>
        {summary && <span className="text-sm text-neutral-300">{summary}</span>}
        {flags.map(([key, v]) => (
          <span key={key} className="rounded bg-neutral-800 px-1.5 font-mono text-[11px] text-neutral-400">
            {key}: {String(v)}
          </span>
        ))}
      </div>
      <div className="space-y-1.5">
        {fields.map(([key, v]) => (
          <div key={key}>
            {fields.length > 1 && <div className="mb-0.5 font-mono text-[11px] text-neutral-500">{key}</div>}
            <FieldValue name={key} value={v} components={components} />
          </div>
        ))}
      </div>
      {result && (
        <div className={`mt-2 border-t pt-2 ${result.isError ? "border-red-900 text-red-300" : "border-neutral-800 text-neutral-400"}`}>
          {isMarkdownOutput(result.body) ? (
            <Fold text={result.body}>
              <div className="text-sm leading-relaxed">
                <Markdown remarkPlugins={[remarkGfm]} components={components}>{result.body}</Markdown>
              </div>
            </Fold>
          ) : (
            <Fold text={shown}>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">{shown}</pre>
            </Fold>
          )}
        </div>
      )}
    </>
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
        <div
          key={it.key}
          title={it.ts ? new Date(it.ts * 1000).toLocaleString() : undefined}
          className={`rounded border px-3 py-2 ${STYLES[it.kind] ?? STYLES.text} ${it.sub ? "ml-6" : ""}`}
        >
          {it.kind === "tool" ? <ToolItem it={it} components={components} /> : <>
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
          </>}
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
