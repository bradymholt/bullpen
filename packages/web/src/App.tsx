import { useEffect, useState } from "react";

type Health = {
  ok: boolean;
  dataDir: string;
  claudeCredential: { source: string; detail: string };
};

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-8 font-sans">
      <h1 className="text-2xl font-semibold tracking-tight">Bullpen</h1>
      <p className="text-neutral-400 mt-1">Claude Code agent dashboard</p>

      <section className="mt-8 max-w-xl rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-400">Status</h2>
        {error && <p className="mt-2 text-red-400">{error}</p>}
        {!health && !error && <p className="mt-2 text-neutral-500">Checking…</p>}
        {health && (
          <dl className="mt-3 grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
            <dt className="text-neutral-500">Claude credential</dt>
            <dd className={health.ok ? "text-emerald-400" : "text-amber-400"}>
              {health.claudeCredential.source} — {health.claudeCredential.detail}
            </dd>
            <dt className="text-neutral-500">Data dir</dt>
            <dd className="text-neutral-300 font-mono text-xs">{health.dataDir}</dd>
          </dl>
        )}
      </section>
    </div>
  );
}
