import { useState } from "react";

const field =
  "w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs outline-none placeholder:text-neutral-700 focus:border-neutral-600";
const label = "block text-[11px] font-medium uppercase tracking-wide text-neutral-500";

type Transport = "http" | "sse" | "stdio";

/** `KEY: value` or `KEY=value`, one per line; blank lines and `#` comments skipped. */
function parsePairs(text: string, sep: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = sep.exec(line);
    if (!m) throw new Error(`can't read "${line}"`);
    out[m[1]!.trim()] = m[2]!.trim();
  }
  return out;
}

/** A command line into command + args; quotes group words, nothing fancier. */
function splitCommand(text: string): { command: string; args: string[] } {
  const parts = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const clean = parts.map((p) => p.replace(/^["']|["']$/g, ""));
  const [command, ...args] = clean;
  if (!command) throw new Error("a command is needed");
  return { command, args };
}

/**
 * Builds the JSON Claude Code stores from a few fields — a URL and optional
 * headers for a remote server, a command line and optional env for a local
 * one. The raw JSON is still there for anything the fields don't cover.
 */
export function McpServerForm({
  onAdd,
  busyLabel = "Add server",
}: {
  onAdd: (name: string, config: Record<string, unknown>) => Promise<void>;
  busyLabel?: string;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<Transport>("http");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [command, setCommand] = useState("");
  const [env, setEnv] = useState("");
  const [raw, setRaw] = useState(false);
  const [json, setJson] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const build = (): Record<string, unknown> => {
    if (raw) {
      try {
        return JSON.parse(json) as Record<string, unknown>;
      } catch {
        throw new Error("Config isn’t valid JSON.");
      }
    }
    if (transport === "stdio") {
      const { command: cmd, args } = splitCommand(command);
      const e = parsePairs(env, /^([^=:]+)[=:](.*)$/);
      return { command: cmd, ...(args.length ? { args } : {}), ...(Object.keys(e).length ? { env: e } : {}) };
    }
    if (!/^https?:\/\//.test(url.trim())) throw new Error("the URL should start with https://");
    const h = parsePairs(headers, /^([^:=]+)[:=](.*)$/);
    return { type: transport, url: url.trim(), ...(Object.keys(h).length ? { headers: h } : {}) };
  };

  const ready = name.trim() && (raw ? json.trim() : transport === "stdio" ? command.trim() : url.trim());

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem]">
        <div>
          <span className={label}>Name</span>
          <input className={field} placeholder="datadog-mcp" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </div>
        {!raw && (
          <div>
            <span className={label}>Type</span>
            <select className={field} value={transport} onChange={(e) => setTransport(e.target.value as Transport)}>
              <option value="http">Remote — HTTP</option>
              <option value="sse">Remote — SSE</option>
              <option value="stdio">Local command</option>
            </select>
          </div>
        )}
      </div>

      {raw ? (
        <div>
          <span className={label}>Config (JSON)</span>
          <textarea
            className={`${field} h-24 resize-y`}
            placeholder={'{ "type": "http", "url": "https://mcp.example.com/mcp" }'}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            spellCheck={false}
          />
        </div>
      ) : transport === "stdio" ? (
        <>
          <div>
            <span className={label}>Command</span>
            <input className={field} placeholder="npx -y @playwright/mcp@latest" value={command} onChange={(e) => setCommand(e.target.value)} spellCheck={false} />
          </div>
          <div>
            <span className={label}>Environment (optional)</span>
            <textarea className={`${field} h-14 resize-y`} placeholder={"API_TOKEN=…\nONE_PER_LINE=…"} value={env} onChange={(e) => setEnv(e.target.value)} spellCheck={false} />
          </div>
        </>
      ) : (
        <>
          <div>
            <span className={label}>URL</span>
            <input className={field} placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
          </div>
          <div>
            <span className={label}>Headers (optional)</span>
            <textarea className={`${field} h-14 resize-y`} placeholder={"Authorization: Bearer …\nOne-Per-Line: …"} value={headers} onChange={(e) => setHeaders(e.target.value)} spellCheck={false} />
            <p className="mt-1 text-[11px] text-neutral-600">
              Servers that sign you in themselves (OAuth) need no header &mdash; add it, then Authorize.
            </p>
          </div>
        </>
      )}

      <div className="flex items-center gap-3">
        <button
          disabled={busy || !ready}
          onClick={async () => {
            setNote(null);
            let config: Record<string, unknown>;
            try {
              config = build();
            } catch (e) {
              setNote(e instanceof Error ? e.message : String(e));
              return;
            }
            setBusy(true);
            try {
              await onAdd(name.trim(), config);
              setName("");
              setUrl("");
              setHeaders("");
              setCommand("");
              setEnv("");
              setJson("");
            } catch (e) {
              setNote(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-900 disabled:opacity-40"
        >
          {busy ? "Adding…" : busyLabel}
        </button>
        <button onClick={() => { setRaw((r) => !r); setNote(null); }} className="text-xs text-neutral-500 hover:text-neutral-300">
          {raw ? "Use the fields" : "Paste JSON instead"}
        </button>
        {note && <span className="text-xs text-red-400">{note}</span>}
      </div>
    </div>
  );
}
