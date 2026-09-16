import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Usage, UsageWindow } from "./types.ts";

/** "1h 33m", "3d 3h" — how long until a window resets. */
function untilReset(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function WindowCard({ w }: { w: UsageWindow }) {
  const used = Math.round(w.utilization);
  const left = 100 - used;
  const reset = untilReset(w.resetsAt);
  const tone = left <= 10 ? "bg-red-400" : left <= 25 ? "bg-amber-400" : "bg-neutral-300";
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
      <div className="grid gap-6 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <div>
          <div className="text-sm font-medium text-neutral-200">{w.label}</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums">{left}%</span>
            <span className="text-sm text-neutral-500">left</span>
          </div>
          {reset && (
            <div className="mt-1 text-xs text-neutral-500" title={w.resetsAt ? new Date(w.resetsAt).toLocaleString() : undefined}>
              resets in {reset}
            </div>
          )}
        </div>
        <div className="flex flex-col justify-center gap-2">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-neutral-800" title={`${used}% used`}>
            <div className={`h-full rounded-full ${tone}`} style={{ width: `${used}%` }} />
          </div>
          <div className="flex justify-between text-xs text-neutral-500">
            <span>{used}% used</span>
            {reset && <span>↻ {reset}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function UsageView() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (fresh: boolean) => {
    setBusy(true);
    setError(null);
    api
      .usage(fresh)
      .then(setUsage)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  useEffect(() => load(false), []);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Usage</h2>
          <p className="mt-1 text-xs text-neutral-500">
            Your Claude subscription&rsquo;s rate-limit windows — the same numbers as <code>/usage</code>{" "}
            in Claude Code. Every run here draws on them.
          </p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={busy}
          title="Fetch again"
          className="shrink-0 rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-900 disabled:opacity-40"
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="mt-6 rounded border border-amber-900 bg-amber-950/30 px-4 py-3 text-sm text-amber-300">
          Couldn&rsquo;t read usage: {error}
          {/no Claude login/i.test(error) && (
            <p className="mt-1 text-xs text-amber-500/80">
              Usage needs the OAuth login Claude Code itself uses — the Keychain on a Mac, or{" "}
              <code>.credentials.json</code> in the config dir. A token from <code>claude setup-token</code> alone
              is enough to run agents but may not be enough to read usage.
            </p>
          )}
        </div>
      )}

      {usage && (
        <div className="mt-6 max-w-4xl space-y-4">
          {usage.windows.length === 0 ? (
            <p className="text-sm text-neutral-500">The account reported no rate-limit windows.</p>
          ) : (
            usage.windows.map((w) => <WindowCard key={w.key} w={w} />)
          )}
          <p className="text-xs text-neutral-600">
            Fetched {new Date(usage.fetchedAt).toLocaleTimeString()} · login from {usage.source} · cached for a
            minute.
          </p>
        </div>
      )}
    </div>
  );
}
