import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { Timeline } from "./Timeline.tsx";
import { useRun } from "./useRun.ts";
import type { Agent, Run } from "./types.ts";

const ACTIVE = new Set(["running", "awaiting_approval"]);

const STATUS_COLOR: Record<string, string> = {
  running: "text-sky-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  cancelled: "text-neutral-400",
  interrupted: "text-amber-400",
};

export function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const { run, events, partial } = useRun(selected);

  const refresh = () => {
    api.agents().then(setAgents);
    api.runs().then(setRuns);
  };
  useEffect(refresh, []);
  useEffect(() => {
    if (run && !ACTIVE.has(run.status)) refresh();
  }, [run?.status]);

  const start = async (agentId: string) => {
    const { runId } = await api.startRun(agentId, prompt.trim() || undefined);
    setPrompt("");
    setSelected(runId);
    api.runs().then(setRuns);
  };

  const isLive = run != null && ACTIVE.has(run.status);

  return (
    <div className="flex h-screen bg-neutral-950 font-sans text-neutral-100">
      <aside className="w-80 shrink-0 overflow-y-auto border-r border-neutral-800 p-4">
        <h1 className="text-lg font-semibold tracking-tight">Bullpen</h1>

        <h2 className="mt-6 text-xs font-medium uppercase tracking-wide text-neutral-500">Agents</h2>
        {agents.map((a) => (
          <div key={a.id} className="mt-2 rounded border border-neutral-800 bg-neutral-900 p-3">
            <div className="font-medium">{a.name}</div>
            <div className="mt-0.5 text-xs text-neutral-500">
              {a.workspaceKind} · {a.permissionMode}
            </div>
            <button
              onClick={() => start(a.id)}
              className="mt-2 rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 hover:bg-white"
            >
              Run
            </button>
          </div>
        ))}

        <h2 className="mt-6 text-xs font-medium uppercase tracking-wide text-neutral-500">Runs</h2>
        {runs.map((r) => (
          <button
            key={r.id}
            onClick={() => setSelected(r.id)}
            className={`mt-1 block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-neutral-900 ${
              selected === r.id ? "bg-neutral-900" : ""
            }`}
          >
            <span className={STATUS_COLOR[r.status] ?? "text-neutral-400"}>●</span>{" "}
            <span className="font-mono">{r.id.slice(0, 8)}</span>{" "}
            <span className="text-neutral-500">{r.trigger}</span>
          </button>
        ))}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {!run && (
          <div className="m-auto text-neutral-600">Select a run, or start one.</div>
        )}
        {run && (
          <>
            <header className="flex items-center gap-3 border-b border-neutral-800 px-6 py-3">
              <span className={`text-sm font-medium ${STATUS_COLOR[run.status] ?? ""}`}>{run.status}</span>
              <span className="font-mono text-xs text-neutral-500">{run.id}</span>
              {run.numTurns != null && (
                <span className="text-xs text-neutral-500">{run.numTurns} turns</span>
              )}
              {isLive && (
                <button
                  onClick={() => api.stop(run.id)}
                  className="ml-auto rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950"
                >
                  Stop
                </button>
              )}
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              <Timeline events={events} partial={partial} />
            </div>
          </>
        )}

        <div className="border-t border-neutral-800 p-4">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !prompt.trim()) return;
              if (isLive && run) {
                api.send(run.id, prompt.trim());
                setPrompt("");
              } else if (agents[0]) {
                start(agents[0].id);
              }
            }}
            placeholder={isLive ? "Reply to this run…" : "Prompt for a new run…"}
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-600"
          />
        </div>
      </main>
    </div>
  );
}
