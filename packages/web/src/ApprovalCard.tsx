import { useState } from "react";
import { api } from "./api.ts";
import type { Approval } from "./types.ts";

/** The SDK supplies a rendered prompt for some tools and nothing for others. */
function summarize(a: Approval): string {
  if (a.toolName === "AskUserQuestion") return "The agent is asking you";
  if (a.title) return a.title;
  const input = a.input as Record<string, string>;
  const subject = input.file_path ?? input.command ?? input.path ?? input.url;
  return subject ? `${a.toolName}: ${subject}` : a.toolName;
}

type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
};

/** The harness reads answers back out of the tool input, keyed by question text. */
function questionsOf(a: Approval): Question[] {
  if (a.toolName !== "AskUserQuestion") return [];
  const raw = (a.input as { questions?: unknown }).questions;
  return Array.isArray(raw) ? (raw as Question[]) : [];
}

export function ApprovalCard({ approval, onDecided }: { approval: Approval; onDecided: () => void }) {
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Record<string, string | string[]>>({});
  const questions = questionsOf(approval);
  const answered = questions.length > 0 && questions.every((q) => picked[q.question] !== undefined);

  const toggle = (q: Question, label: string) => {
    setPicked((prev) => {
      if (!q.multiSelect) return { ...prev, [q.question]: label };
      const current = Array.isArray(prev[q.question]) ? (prev[q.question] as string[]) : [];
      const next = current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label];
      return { ...prev, [q.question]: next };
    });
  };

  const isPicked = (q: Question, label: string) => {
    const value = picked[q.question];
    return Array.isArray(value) ? value.includes(label) : value === label;
  };

  const decide = async (allow: boolean) => {
    setBusy(true);
    try {
      await api.decide(approval.id, allow, undefined, allow && answered ? picked : undefined);
      onDecided();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-amber-700 bg-amber-950/30 px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-amber-500">
        {questions.length > 0 ? "Needs an answer" : "Needs approval"}
      </div>
      <div className="mt-1 font-medium">{summarize(approval)}</div>
      {approval.description && (
        <p className="mt-1 text-sm text-neutral-400">{approval.description}</p>
      )}
      {questions.length > 0 ? (
        <div className="mt-3 space-y-3">
          {questions.map((q) => (
            <div key={q.question}>
              {q.header && (
                <span className="text-xs font-medium uppercase tracking-wide text-amber-500/80">
                  {q.header}
                </span>
              )}
              <p className="text-sm text-neutral-200">{q.question}</p>
              {q.multiSelect && <p className="text-xs text-neutral-500">Pick any that apply.</p>}
              <div className="mt-1.5 space-y-1">
                {q.options.map((o) => (
                  <button
                    key={o.label}
                    onClick={() => toggle(q, o.label)}
                    className={`block w-full rounded border px-2.5 py-1.5 text-left text-sm transition ${
                      isPicked(q, o.label)
                        ? "border-amber-500 bg-amber-500/10 text-neutral-100"
                        : "border-neutral-700 hover:border-neutral-600 hover:bg-neutral-900"
                    }`}
                  >
                    {o.label}
                    {o.description && (
                      <span className="mt-0.5 block text-xs text-neutral-500">{o.description}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-neutral-950/60 p-2 text-xs text-neutral-400">
          {JSON.stringify(approval.input, null, 2)}
        </pre>
      )}
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
          disabled={busy || (questions.length > 0 && !answered)}
          className="rounded bg-amber-500 px-3 py-1.5 text-sm font-medium text-neutral-950 hover:bg-amber-400 disabled:opacity-40"
        >
          {questions.length > 0 ? "Send answers" : "Allow"}
        </button>
      </div>
    </div>
  );
}
