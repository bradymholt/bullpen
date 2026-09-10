import { useEffect, useState } from "react";
import { AgentEditor } from "./AgentEditor.tsx";
import { api } from "./api.ts";
import { Timeline } from "./Timeline.tsx";
import { useRun } from "./useRun.ts";
import type { Agent, Run } from "./types.ts";

const ACTIVE = new Set(["running", "awaiting_approval"]);

const STATUS_COLOR: Record<string, string> = {
  running: "text-sky-400",
  awaiting_approval: "text-amber-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  cancelled: "text-neutral-400",
  interrupted: "text-amber-400",
};

type View = { kind: "run"; id: string } | { kind: "agent"; agent: Agent | null } | { kind: "empty" };

export function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [view, setView] = useState<View>({ kind: "empty" });
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { run, events, partial } = useRun(view.kind === "run" ? view.id : null);

  const refresh = () => {
    api.agents().then(setAgents);
    api.runs().then(setRuns);
  };
  useEffect(refresh, []);
  useEffect(() => {
    if (run && !ACTIVE.has(run.status)) api.runs().then(setRuns);
  }, [run?.status]);

  const start = async (agentId: string) => {
    setError(null);
    try {
      const { runId } = await api.startRun(agentId, prompt.trim() || undefined);
      setPrompt("");
      setView({ kind: "run", id: runId });
      api.runs().then(setRuns);
    } catch (e) {
      setError(String(e));
    }
  };

  const isLive = run != null && ACTIVE.has(run.status);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? "—";

  return (
    <div className="flex h-screen bg-neutral-950 font-sans text-neutral-100">
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-neutral-800 p-4">
        <h1 className="text-lg font-semibold tracking-tight">Bullpen</h1>

        <div className="mt-6 flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Agents</h2>
          <button
            onClick={() => setView({ kind: "agent", agent: null })}
            className="text-xs text-neutral-400 hover:text-neutral-100"
          >
            + New
          </button>
        </div>

        {agents.map((a) => (
          <div key={a.id} className="mt-2 rounded border border-neutral-800 bg-neutral-900 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-medium">{a.name}</div>
                <div className="mt-0.5 text-xs text-neutral-500">
                  {a.workspaceKind} · {a.permissionMode}
                </div>
              </div>
              <button
                onClick={() => setView({ kind: "agent", agent: a })}
                className="shrink-0 text-xs text-neutral-500 hover:text-neutral-100"
              >
                Edit
              </button>
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
            onClick={() => setView({ kind: "run", id: r.id })}
            className={`mt-1 block w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-neutral-900 ${
              view.kind === "run" && view.id === r.id ? "bg-neutral-900" : ""
            }`}
          >
            <span className={STATUS_COLOR[r.status] ?? "text-neutral-400"}>●</span>{" "}
            <span className="text-neutral-300">{agentName(r.agentId)}</span>{" "}
            <span className="text-neutral-600">{r.trigger}</span>
          </button>
        ))}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {view.kind === "agent" && (
          <div className="flex-1 overflow-y-auto">
            <AgentEditor
              agent={view.agent}
              onSaved={() => {
                refresh();
                setView({ kind: "empty" });
              }}
              onDeleted={() => {
                refresh();
                setView({ kind: "empty" });
              }}
              onCancel={() => setView({ kind: "empty" })}
            />
          </div>
        )}

        {view.kind === "empty" && (
          <div className="m-auto text-neutral-600">Select a run, or start one.</div>
        )}

        {view.kind === "run" && run && (
          <>
            <header className="flex items-center gap-3 border-b border-neutral-800 px-6 py-3">
              <span className={`text-sm font-medium ${STATUS_COLOR[run.status] ?? ""}`}>{run.status}</span>
              <span className="text-sm text-neutral-300">{agentName(run.agentId)}</span>
              {run.branch && <span className="font-mono text-xs text-neutral-500">{run.branch}</span>}
              {run.numTurns != null && <span className="text-xs text-neutral-500">{run.numTurns} turns</span>}
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

        {view.kind !== "agent" && (
          <div className="border-t border-neutral-800 p-4">
            {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
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
        )}
      </main>
    </div>
  );
}
