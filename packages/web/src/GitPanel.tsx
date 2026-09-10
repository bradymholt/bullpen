import { useEffect, useState } from "react";

type GitState = { branch: string; files: { path: string; status: string }[]; diff: string };

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="max-h-96 overflow-auto rounded border border-neutral-800 bg-neutral-950 p-3 text-xs leading-relaxed">
      {diff.split("\n").map((line, i) => {
        const color = line.startsWith("+++") || line.startsWith("---")
          ? "text-neutral-500"
          : line.startsWith("+")
            ? "text-emerald-400"
            : line.startsWith("-")
              ? "text-red-400"
              : line.startsWith("@@")
                ? "text-sky-400"
                : "text-neutral-400";
        return (
          <div key={i} className={color}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

export function GitPanel({ runId }: { runId: string }) {
  const [state, setState] = useState<GitState | null>(null);
  const [message, setMessage] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    fetch(`/api/runs/${runId}/git`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setState)
      .catch(() => setState(null));

  useEffect(() => {
    void load();
  }, [runId]);

  if (!state) return null;

  const act = async (path: string, body: unknown, describe: (r: any) => string) => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/runs/${runId}/git/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      setNote(res.ok ? describe(json) : (json.error ?? "failed"));
      if (res.ok) await load();
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="flex items-center gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Changes</h3>
        <span className="font-mono text-xs text-neutral-400">{state.branch}</span>
        <span className="text-xs text-neutral-600">
          {state.files.length} file{state.files.length === 1 ? "" : "s"}
        </span>
      </div>

      {state.files.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-600">Nothing changed in the workspace.</p>
      ) : (
        <>
          <ul className="mt-2 space-y-0.5">
            {state.files.map((f) => (
              <li key={f.path} className="font-mono text-xs text-neutral-400">
                <span className="text-amber-500">{f.status}</span> {f.path}
              </li>
            ))}
          </ul>

          {state.diff && (
            <div className="mt-3">
              <DiffView diff={state.diff} />
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message"
              className="min-w-48 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm outline-none focus:border-neutral-600"
            />
            <button
              disabled={busy || !message.trim()}
              onClick={() => act("commit", { message: message.trim() }, (r) => `Committed ${r.sha.slice(0, 8)}`)}
              className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-40"
            >
              Commit
            </button>
            <button
              disabled={busy}
              onClick={() => act("push", {}, () => "Pushed")}
              className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-40"
            >
              Push
            </button>
            <button
              disabled={busy || !message.trim()}
              onClick={() => act("pr", { title: message.trim() }, (r) => `Opened #${r.number}`)}
              className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
            >
              Open PR
            </button>
          </div>
        </>
      )}

      {note && <p className="mt-2 text-xs text-neutral-400">{note}</p>}
    </div>
  );
}
