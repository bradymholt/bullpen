import { useState } from "react";
import { api } from "./api.ts";
import type { Approval } from "./types.ts";

/** The SDK supplies a rendered prompt for some tools and nothing for others. */
function summarize(a: Approval): string {
  if (a.title) return a.title;
  const input = a.input as Record<string, string>;
  const subject = input.file_path ?? input.command ?? input.path ?? input.url;
  return subject ? `${a.toolName}: ${subject}` : a.toolName;
}

export function ApprovalCard({ approval, onDecided }: { approval: Approval; onDecided: () => void }) {
  const [busy, setBusy] = useState(false);

  const decide = async (allow: boolean) => {
    setBusy(true);
    try {
      await api.decide(approval.id, allow);
      onDecided();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-amber-700 bg-amber-950/30 px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-amber-500">
        Needs approval
      </div>
      <div className="mt-1 font-medium">{summarize(approval)}</div>
      {approval.description && (
        <p className="mt-1 text-sm text-neutral-400">{approval.description}</p>
      )}
      <pre className="mt-2 max-h-48 overflow-auto rounded bg-neutral-950/60 p-2 text-xs text-neutral-400">
        {JSON.stringify(approval.input, null, 2)}
      </pre>
      <div className="mt-3 flex gap-2">
        {/* Deny first: an approval should not be one stray keystroke away. */}
        <button
          onClick={() => decide(false)}
          disabled={busy}
          className="rounded border border-neutral-600 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:opacity-40"
        >
          Deny
        </button>
        <button
          onClick={() => decide(true)}
          disabled={busy}
          className="rounded bg-amber-500 px-3 py-1.5 text-sm font-medium text-neutral-950 hover:bg-amber-400 disabled:opacity-40"
        >
          Allow
        </button>
      </div>
    </div>
  );
}
