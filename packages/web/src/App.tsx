import { useEffect, useRef, useState } from "react";
import { AgentEditor } from "./AgentEditor.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { GitPanel } from "./GitPanel.tsx";
import { api } from "./api.ts";
import { Timeline } from "./Timeline.tsx";
import { useRun } from "./useRun.ts";
import type { Agent, Run, Skill } from "./types.ts";

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
  const [runMode, setRunMode] = useState("auto");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [metered, setMetered] = useState(false);
  const [skillIndex, setSkillIndex] = useState(0);
  const [liveMode, setLiveMode] = useState("auto");

  useEffect(() => {
    void api.skills().then(setSkills).catch(() => setSkills([]));
    void api
      .health()
      .then((h) => setMetered(h.claudeCredential.source === "api-key"))
      .catch(() => setMetered(false));
  }, []);
  const [error, setError] = useState<string | null>(null);

  const { run, events, partial, approvals } = useRun(view.kind === "run" ? view.id : null);
  const outputRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // A new run starts pinned to the newest output again.
  useEffect(() => {
    stickToBottom.current = true;
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [view.kind === "run" ? view.id : null]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, partial, approvals]);

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
      // A prompt typed here is a one-off: its own directory, deleted afterwards.
      const { runId } = await api.startRun(agentId, prompt.trim() || undefined, runMode, true);
      setPrompt("");
      setView({ kind: "run", id: runId });
      api.runs().then(setRuns);
    } catch (e) {
      setError(String(e));
    }
  };

  const slash = /^\/([\w-]*)$/.exec(prompt);
  const skillMatches = slash
    ? skills.filter((s) => s.name.toLowerCase().includes(slash[1]!.toLowerCase())).slice(0, 8)
    : [];
  const pickSkill = (name: string) => {
    setPrompt(`/${name} `);
    setSkillIndex(0);
  };

  // The select shows what the run is actually using, not a placeholder.
  useEffect(() => {
    if (run?.permissionMode) setLiveMode(run.permissionMode);
  }, [run?.id, run?.permissionMode]);

  const isLive = run != null && ACTIVE.has(run.status);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? "—";
  const agentOf = (id: string) => agents.find((a) => a.id === id);

  return (
    <div className="flex h-screen bg-neutral-950 font-sans text-neutral-100">
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-neutral-800 p-4">
        <h1 className="text-lg font-semibold tracking-tight">Bullpen</h1>

        <div className="mt-6 flex shrink-0 items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Agents</h2>
          <button
            onClick={() => setView({ kind: "agent", agent: null })}
            className="text-xs text-neutral-400 hover:text-neutral-100"
          >
            + New
          </button>
        </div>

        {agents.map((a) => (
          <div key={a.id} className="mt-2 shrink-0 rounded border border-neutral-800 bg-neutral-900 p-3">
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

        <h2 className="mt-6 shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-500">Runs</h2>
        {runs.map((r) => (
          <button
            key={r.id}
            onClick={() => setView({ kind: "run", id: r.id })}
            className={`mt-1 block w-full shrink-0 truncate rounded px-2 py-1.5 text-left text-xs hover:bg-neutral-900 ${
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
                <>
                  <select
                    value={liveMode}
                    onChange={(e) => {
                      const mode = e.target.value;
                      setError(null);
                      setLiveMode(mode);
                      api.setMode(run.id, mode).catch((err) => {
                        setError(String(err));
                        setLiveMode(run.permissionMode ?? "auto");
                      });
                    }}
                    title="Permission mode in force for this run"
                    className="ml-auto rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
                  >
                    <option value="supervised">supervised</option>
                    <option value="acceptEdits">auto-accept edits</option>
                    <option value="plan">plan</option>
                    <option value="auto">auto</option>
                    <option value="locked">locked</option>
                    {/* A run can only enter full access if it started there. */}
                    {run.permissionMode === "full" && <option value="full">full access</option>}
                  </select>
                  <button
                    onClick={() => api.stop(run.id)}
                    className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950"
                  >
                    Stop
                  </button>
                </>
              )}
            </header>
            <div
              ref={outputRef}
              onScroll={() => {
                const el = outputRef.current;
                if (!el) return;
                // Scrolling up parks the view; scrolling back to the bottom resumes.
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
              className="flex-1 overflow-y-auto px-6 py-4"
            >
              <Timeline events={events} partial={partial} meteredBilling={metered} />
              {approvals.length > 0 && (
                <div className="mt-3 space-y-2">
                  {approvals.map((a) => (
                    <ApprovalCard key={a.id} approval={a} onDecided={() => {}} />
                  ))}
                </div>
              )}
              {run.branch && <GitPanel runId={run.id} />}
            </div>
          </>
        )}

        {view.kind !== "agent" && (
          <div className="border-t border-neutral-800 p-4">
            {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
            {skillMatches.length > 0 && (
              <div className="mb-2 overflow-hidden rounded border border-neutral-800 bg-neutral-900">
                {skillMatches.map((s, i) => (
                  <button
                    key={s.name}
                    onMouseEnter={() => setSkillIndex(i)}
                    onClick={() => pickSkill(s.name)}
                    className={`block w-full px-3 py-1.5 text-left ${
                      i === skillIndex ? "bg-neutral-800" : "hover:bg-neutral-850"
                    }`}
                  >
                    <span className="font-mono text-xs text-neutral-200">/{s.name}</span>
                    {s.description && (
                      <span className="ml-2 text-xs text-neutral-500">
                        {s.description.length > 90 ? `${s.description.slice(0, 90)}…` : s.description}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2">
              <input
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  setSkillIndex(0);
                }}
                onKeyDown={(e) => {
                  if (skillMatches.length > 0) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setSkillIndex((i) => (i + 1) % skillMatches.length);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setSkillIndex((i) => (i - 1 + skillMatches.length) % skillMatches.length);
                      return;
                    }
                    if (e.key === "Tab" || e.key === "Enter") {
                      e.preventDefault();
                      pickSkill(skillMatches[skillIndex]!.name);
                      return;
                    }
                    if (e.key === "Escape") {
                      setPrompt("");
                      return;
                    }
                  }
                  if (e.key !== "Enter" || !prompt.trim()) return;
                  if (isLive && run) {
                    api.send(run.id, prompt.trim());
                    setPrompt("");
                  } else if (agents[0]) {
                    start(agents[0].id);
                  }
                }}
                placeholder={isLive ? "Reply to this run…" : "Prompt for a new run…"}
                className="flex-1 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-600"
              />
              {!isLive && (
                <select
                  value={runMode}
                  onChange={(e) => setRunMode(e.target.value)}
                  title="Permission mode for this run — the agent's saved mode is left alone"
                  className="shrink-0 rounded border border-neutral-800 bg-neutral-900 px-2 py-2 text-xs text-neutral-400 outline-none focus:border-neutral-600"
                >
                  <option value="auto">auto</option>
                  <option value="supervised">supervised</option>
                  <option value="acceptEdits">auto-accept edits</option>
                  <option value="plan">plan</option>
                  <option value="locked">locked</option>
                  <option value="full">full access</option>
                </select>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
