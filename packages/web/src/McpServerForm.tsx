import { useState } from "react";

const field =
  "w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs outline-none placeholder:text-neutral-700 focus:border-neutral-600";

const EXAMPLE = `{ "type": "http", "url": "https://mcp.example.com/mcp" }
or
{ "command": "npx", "args": ["-y", "some-mcp-server"], "env": { "TOKEN": "..." } }`;

/** Name plus a JSON config, the same shape Claude Code stores. */
export function McpServerForm({
  onAdd,
  busyLabel = "Add server",
}: {
  onAdd: (name: string, config: Record<string, unknown>) => Promise<void>;
  busyLabel?: string;
}) {
  const [name, setName] = useState("");
  const [config, setConfig] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-1.5">
      <input className={field} placeholder="name, e.g. datadog-mcp" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
      <textarea
        className={`${field} h-24 resize-y`}
        placeholder={EXAMPLE}
        value={config}
        onChange={(e) => setConfig(e.target.value)}
        spellCheck={false}
      />
      <div className="flex items-center gap-2">
        <button
          disabled={busy || !name.trim() || !config.trim()}
          onClick={async () => {
            setNote(null);
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(config) as Record<string, unknown>;
            } catch {
              setNote("Config isn\u2019t valid JSON.");
              return;
            }
            setBusy(true);
            try {
              await onAdd(name.trim(), parsed);
              setName("");
              setConfig("");
            } catch (e) {
              setNote(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
          className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-900 disabled:opacity-40"
        >
          {busy ? "Adding\u2026" : busyLabel}
        </button>
        {note && <span className="text-xs text-red-400">{note}</span>}
      </div>
    </div>
  );
}
