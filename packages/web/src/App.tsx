import { useEffect, useRef, useState } from "react";
import { AgentEditor } from "./AgentEditor.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { GitPanel } from "./GitPanel.tsx";
import { api } from "./api.ts";
import { DeliveryList } from "./DeliveryList.tsx";
import { Timeline } from "./Timeline.tsx";
import { useRun } from "./useRun.ts";
import type { Agent, Delivery, Run, Skill } from "./types.ts";

const ACTIVE = new Set(["running", "awaiting_approval"]);

function Stat({ label, value, tone = "" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex items-baseline gap-2 rounded border border-neutral-800 bg-neutral-900/40 px-3 py-1.5">
      <span className={`text-base font-semibold ${tone || "text-neutral-100"}`}>{value}</span>
      <span className="truncate text-xs text-neutral-500">{label}</span>
    </div>
  );
}

function HomeSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0">
      <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-neutral-600">{hint}</p>}
      <div className="mt-2 space-y-1">{children}</div>
    </section>
  );
}

function RailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">{title}</h3>
      <div className="mt-2 space-y-1.5">{children}</div>
    </section>
  );
}

function RailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-neutral-500">{label}</span>
      <span className="min-w-0 truncate text-right text-neutral-300" title={String(value)}>
        {value}
      </span>
    </div>
  );
}

/** An agent can carry several triggers at once, so this is a list, not a label. */
function triggersOf(a: Agent): string[] {
  const out: string[] = [];
  if (a.cron) out.push(`cron ${a.cron}${a.cronTimezone ? ` · ${a.cronTimezone}` : ""}`);
  if (a.pollUrl) out.push("poll");
  if (a.webhookSecret) out.push(`webhook · ${a.webhookMode}`);
  return out.length > 0 ? out : ["manual only"];
}

/** Stored records still carry the pre-rename spellings; only the display changes. */
function workspaceKindLabel(kind: string): string {
  return kind === "persistent" ? "scratch" : kind === "git" ? "clone" : kind;
}

function workspaceSummary(a: Agent): string {
  const ws = a.workspaceConfig;
  if (ws.kind === "ephemeral") return "fresh directory per run";
  if (ws.kind === "existing") return ws.path;
  if (ws.kind === "clone" || ws.kind === "git") return ws.repoUrl;
  return "scratch directory";
}

const chipClass = (selected: boolean) =>
  `rounded px-2 py-0.5 text-xs transition ${
    selected ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"
  }`;

function SpaceChip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} className={chipClass(selected)}>
      {label}
    </button>
  );
}

/**
 * A tagged union rather than `string | null` so that "no space" is a bucket you
 * can select, not the absence of a selection — an agent with a null space is
 * otherwise reachable from nowhere once the roster remembers a space.
 */
type SpaceFilter = { kind: "all" } | { kind: "unassigned" } | { kind: "space"; name: string };

const SPACE_KEY = "bullpen.space";

function loadSpaceFilter(): SpaceFilter {
  try {
    const raw = localStorage.getItem(SPACE_KEY);
    if (!raw) return { kind: "all" };
    const parsed = JSON.parse(raw) as SpaceFilter;
    if (parsed?.kind === "all" || parsed?.kind === "unassigned") return { kind: parsed.kind };
    if (parsed?.kind === "space" && typeof parsed.name === "string") {
      return { kind: "space", name: parsed.name };
    }
  } catch {
    // Private windows and blocked site data throw rather than returning null.
  }
  return { kind: "all" };
}

/** Coarse on purpose: "when did this last do anything" reads better than a date. */
function ago(epochSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(epochSeconds * 1000).toLocaleDateString();
}

const STATUS_COLOR: Record<string, string> = {
  running: "text-sky-400",
  awaiting_approval: "text-amber-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  cancelled: "text-neutral-400",
  interrupted: "text-amber-400",
};

type View =
  | { kind: "run"; id: string }
  /** The agent's own page: what it is, and everything it has run. */
  | { kind: "detail"; id: string }
  /** `seed` prefills a brand-new agent from an existing one. */
  | { kind: "edit"; agent: Agent | null; seed?: Agent }
  /** The roster at a glance, outside any one agent. */
  | { kind: "home" };

function viewToPath(v: View): string {
  if (v.kind === "detail") return `/agents/${v.id}`;
  if (v.kind === "run") return `/runs/${v.id}`;
  if (v.kind === "edit") return v.agent ? `/agents/${v.agent.id}/edit` : "/agents/new";
  return "/";
}

/**
 * The edit view holds a whole agent, which a cold load doesn't have yet, so an
 * edit URL lands on the agent page and `editId` upgrades it once agents arrive.
 */
function pathToView(path: string): { view: View; editId?: string } {
  const p = path.replace(/\/+$/, "") || "/";
  if (p === "/agents/new") return { view: { kind: "edit", agent: null } };
  let m = /^\/runs\/([\w-]+)$/.exec(p);
  if (m) return { view: { kind: "run", id: m[1]! } };
  m = /^\/agents\/([\w-]+)\/edit$/.exec(p);
  if (m) return { view: { kind: "detail", id: m[1]! }, editId: m[1]! };
  m = /^\/agents\/([\w-]+)$/.exec(p);
  if (m) return { view: { kind: "detail", id: m[1]! } };
  return { view: { kind: "home" } };
}

export function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [route] = useState(() => pathToView(location.pathname));
  const [view, setViewState] = useState<View>(route.view);
  const [pendingEdit, setPendingEdit] = useState<string | null>(route.editId ?? null);

  const setView = (next: View) => {
    setViewState(next);
    setPendingEdit(null);
    const path = viewToPath(next);
    if (path !== location.pathname) history.pushState(null, "", path);
  };
  const [prompt, setPrompt] = useState("");
  const [runMode, setRunMode] = useState("auto");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [metered, setMetered] = useState(false);
  const [skillIndex, setSkillIndex] = useState(0);
  const [liveMode, setLiveMode] = useState("auto");
  const [space, setSpace] = useState<SpaceFilter>(loadSpaceFilter);
  const [editingSpace, setEditingSpace] = useState<string | null>(null);
  const [spaceDraft, setSpaceDraft] = useState("");
  const [spaceError, setSpaceError] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [upcoming, setUpcoming] = useState<{ agentId: string; at: string }[]>([]);

  // Back and forward are the browser's, so the view follows the URL rather than
  // the other way round.
  useEffect(() => {
    const onPop = () => {
      const next = pathToView(location.pathname);
      setViewState(next.view);
      setPendingEdit(next.editId ?? null);
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!pendingEdit) return;
    const match = agents.find((a) => a.id === pendingEdit);
    if (match) {
      setViewState({ kind: "edit", agent: match });
      setPendingEdit(null);
    }
  }, [pendingEdit, agents]);

  const detailId = view.kind === "detail" ? view.id : null;
  useEffect(() => setPromptOpen(false), [detailId]);

  // Refetched when runs change so a delivery that just fired shows up without a reload.
  useEffect(() => {
    if (detailId === null) return setDeliveries([]);
    void api.deliveries(detailId).then(setDeliveries).catch(() => setDeliveries([]));
  }, [detailId, runs]);

  useEffect(() => {
    try {
      localStorage.setItem(SPACE_KEY, JSON.stringify(space));
    } catch {
      // Not worth surfacing: the filter just won't survive a reload.
    }
  }, [space]);

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

  const positionedFor = useRef<string | null>(null);

  // Position once per run, and only once its status is known: a live run opens
  // pinned to the newest output, a finished one at the start of the session.
  useEffect(() => {
    const id = view.kind === "run" ? view.id : null;
    if (id === null) {
      positionedFor.current = null;
      return;
    }
    if (!run || run.id !== id || positionedFor.current === id) return;
    positionedFor.current = id;
    const live = ACTIVE.has(run.status);
    stickToBottom.current = live;
    const el = outputRef.current;
    if (el) el.scrollTop = live ? el.scrollHeight : 0;
  }, [view, run]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, partial, approvals]);

  const refresh = () => {
    api.agents().then(setAgents);
    api.runs().then(setRuns);
    api
      .scheduleAll()
      .then(setUpcoming)
      .catch(() => setUpcoming([]));
  };
  useEffect(refresh, []);
  useEffect(() => {
    if (run && !ACTIVE.has(run.status)) api.runs().then(setRuns);
  }, [run?.status]);

  /**
   * `oneOff` is a prompt typed into the bar: its own directory, deleted after.
   * Running an agent from its card uses the workspace it was configured with.
   */
  const start = async (agentId: string, oneOff = false) => {
    setError(null);
    try {
      const { runId } = await api.startRun(
        agentId,
        oneOff ? prompt.trim() || undefined : undefined,
        oneOff ? runMode : undefined,
        oneOff,
      );
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
  // Finished but still attached: replying continues the same session rather
  // than starting a fresh run with none of its context.
  const canReply = run != null && (isLive || run.resumable === true);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? "—";
  const spaces = [...new Set(agents.map((a) => a.space).filter((sp): sp is string => !!sp))].sort();
  const hasUnassigned = agents.some((a) => !a.space);
  // A remembered space that no longer exists (renamed, or its last agent
  // deleted) shows everything rather than an empty roster.
  const active: SpaceFilter =
    (space.kind === "space" && !spaces.includes(space.name)) ||
    (space.kind === "unassigned" && !hasUnassigned)
      ? { kind: "all" }
      : space;
  const visibleAgents =
    active.kind === "all"
      ? agents
      : active.kind === "unassigned"
        ? agents.filter((a) => !a.space)
        : agents.filter((a) => a.space === active.name);

  /** `to === null` unassigns every member, which is how a space is removed. */
  async function moveSpace(from: string, to: string | null) {
    if (to === from) return setEditingSpace(null);
    if (to !== null && to.length === 0) return;
    setSpaceError(null);
    try {
      await api.renameSpace(from, to);
      // Follow the agents so they don't vanish from under the selection.
      setSpace(to === null ? { kind: "unassigned" } : { kind: "space", name: to });
      setEditingSpace(null);
      refresh();
    } catch (e) {
      setSpaceError(e instanceof Error ? e.message : String(e));
    }
  }

  // The home view answers "what needs me", scoped to the space you are in so it
  // agrees with the roster beside it.
  const scopedIds = new Set(visibleAgents.map((a) => a.id));
  const scopedRuns = runs.filter((r) => scopedIds.has(r.agentId));
  const awaiting = scopedRuns.filter((r) => r.status === "awaiting_approval");
  const running = scopedRuns.filter((r) => r.status === "running");
  // `runs` arrives newest first, so the first hit per agent is its latest run.
  const latestByAgent = new Map<string, Run>();
  for (const r of scopedRuns) if (!latestByAgent.has(r.agentId)) latestByAgent.set(r.agentId, r);
  const failing = visibleAgents.filter((a) => latestByAgent.get(a.id)?.status === "failed");
  const dayAgo = Date.now() / 1000 - 86400;
  const recentRuns = scopedRuns.filter((r) => r.startedAt >= dayAgo);
  const runsToday = recentRuns.length;
  const paused = visibleAgents.filter((a) => !a.enabled);
  // Only real money on an API key; a subscription reports cost that never bills.
  const spendToday = recentRuns.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const scopedUpcoming = upcoming.filter((u) => scopedIds.has(u.agentId));

  const selectedAgentId =
    view.kind === "detail"
      ? view.id
      : view.kind === "run"
        ? (run?.agentId ?? null)
        : view.kind === "edit"
          ? (view.agent?.id ?? null)
          : null;
  const detailAgent = view.kind === "detail" ? agents.find((a) => a.id === view.id) : undefined;
  const agentRuns = detailAgent ? runs.filter((r) => r.agentId === detailAgent.id) : [];
  const agentOf = (id: string) => agents.find((a) => a.id === id);

  return (
    <div className="flex h-screen bg-neutral-950 font-sans text-neutral-100">
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-neutral-800 p-4">
        <button
          onClick={() => setView({ kind: "home" })}
          className="flex shrink-0 items-center gap-2 text-left"
          title="Roster overview"
        >
          <img src="/favicon.svg" alt="" className="h-9 w-9" />
          <h1 className="text-lg font-semibold tracking-tight hover:text-white">Bullpen</h1>
        </button>

        {spaces.length > 0 && (
          <div className="mt-4 flex shrink-0 flex-wrap gap-1">
            <SpaceChip
              label="All"
              selected={active.kind === "all"}
              onClick={() => setSpace({ kind: "all" })}
            />
            {spaces.map((sp) =>
              active.kind === "space" && active.name === sp ? (
                <span key={sp} className={`group inline-flex items-center ${chipClass(true)}`}>
                  {sp}
                  {editingSpace !== sp && (
                    <button
                      onClick={() => {
                        setSpaceDraft(sp);
                        setEditingSpace(sp);
                      }}
                      title={`Rename or empty "${sp}"`}
                      className="max-w-0 overflow-hidden text-neutral-500 opacity-0 transition-all duration-150 hover:text-neutral-100 focus:ml-1 focus:max-w-5 focus:opacity-100 group-hover:ml-1 group-hover:max-w-5 group-hover:opacity-100"
                    >
                      &#9998;
                    </button>
                  )}
                </span>
              ) : (
                <SpaceChip
                  key={sp}
                  label={sp}
                  selected={false}
                  onClick={() => setSpace({ kind: "space", name: sp })}
                />
              ),
            )}
            {hasUnassigned && (
              <SpaceChip
                label="Unassigned"
                selected={active.kind === "unassigned"}
                onClick={() => setSpace({ kind: "unassigned" })}
              />
            )}
          </div>
        )}

        {active.kind === "space" && editingSpace === active.name && (
          <div className="mt-2 shrink-0 text-xs">
            <div className="flex flex-col gap-1">
              <input
                autoFocus
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-neutral-500"
                value={spaceDraft}
                onChange={(e) => setSpaceDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void moveSpace(active.name, spaceDraft.trim());
                  if (e.key === "Escape") setEditingSpace(null);
                }}
              />
              <div className="flex gap-2">
                <button
                  onClick={() => void moveSpace(active.name, spaceDraft.trim())}
                  className="text-neutral-300 hover:text-neutral-100"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setEditingSpace(null);
                    setSpaceError(null);
                  }}
                  className="text-neutral-500 hover:text-neutral-300"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (
                      confirm(
                        `Move ${visibleAgents.length} agent(s) out of "${active.name}"? The space disappears.`,
                      )
                    ) {
                      void moveSpace(active.name, null);
                    }
                  }}
                  className="ml-auto text-red-400 hover:text-red-300"
                >
                  Unassign all
                </button>
              </div>
              {spaceError && <span className="text-red-400">{spaceError}</span>}
            </div>
          </div>
        )}

        <div className="mt-6 flex shrink-0 items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Agents</h2>
          <button
            onClick={() => setView({ kind: "edit", agent: null })}
            className="text-xs text-neutral-400 hover:text-neutral-100"
          >
            + New
          </button>
        </div>

        {visibleAgents.map((a) => {
          const mine = runs.filter((r) => r.agentId === a.id);
          const live = mine.filter((r) => ACTIVE.has(r.status)).length;
          // The list arrives newest first, so the head is the last run.
          const last = mine[0];
          return (
            <button
              key={a.id}
              onClick={() => setView({ kind: "detail", id: a.id })}
              className={`mt-2 block w-full shrink-0 rounded border p-3 text-left transition ${
                selectedAgentId === a.id
                  ? "border-neutral-600 bg-neutral-900"
                  : "border-neutral-800 bg-neutral-900/50 hover:border-neutral-700"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{a.name}</div>
                  <div className="mt-0.5 text-xs text-neutral-500">
                    {/* Only worth the room when the roster isn't already one space. */}
                    {active.kind === "all" && a.space && (
                      <span className="mr-1.5 rounded bg-neutral-800 px-1 py-px text-[10px] text-neutral-400">
                        {a.space}
                      </span>
                    )}
                    {workspaceKindLabel(a.workspaceKind)} · {a.permissionMode}
                  </div>
                  <div className="mt-0.5 text-xs">
                    {live > 0 ? (
                      <span className="text-sky-400">{live} running</span>
                    ) : last ? (
                      <span className="text-neutral-500">
                        <span className={STATUS_COLOR[last.status] ?? "text-neutral-400"}>●</span>{" "}
                        ran {ago(last.startedAt)}
                      </span>
                    ) : (
                      <span className="text-neutral-600">never run</span>
                    )}
                  </div>
                </div>
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    setView({ kind: "edit", agent: a });
                  }}
                  className="shrink-0 text-xs text-neutral-500 hover:text-neutral-100"
                >
                  Edit
                </span>
              </div>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  void start(a.id);
                }}
                className="mt-2 inline-block rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 hover:bg-white"
              >
                Run
              </span>
            </button>
          );
        })}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {view.kind === "edit" && (
          <div className="flex-1 overflow-y-auto">
            <AgentEditor
              key={view.agent ? `edit-${view.agent.id}` : `new-${view.seed?.id ?? ""}`}
              agent={view.agent}
              seed={view.seed ?? null}
              spaces={spaces}
              defaultSpace={active.kind === "space" ? active.name : null}
              onSaved={() => {
                refresh();
                setView({ kind: "home" });
              }}
              onDeleted={() => {
                refresh();
                setView({ kind: "home" });
              }}
              onCancel={() => setView({ kind: "home" })}
            />
          </div>
        )}

        {view.kind === "detail" && detailAgent && (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">{detailAgent.name}</h2>
                {!detailAgent.enabled && (
                  <p className="mt-1 text-xs text-amber-500">All triggers are paused</p>
                )}
                {detailAgent.description && (
                  <p className="mt-1 text-xs text-neutral-500">{detailAgent.description}</p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => setView({ kind: "edit", agent: detailAgent })}
                  className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-900"
                >
                  Edit
                </button>
                <button
                  onClick={() => setView({ kind: "edit", agent: null, seed: detailAgent })}
                  title="Start a new agent prefilled with this one's settings"
                  className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-900"
                >
                  Copy
                </button>
                <button
                  onClick={() => void start(detailAgent.id)}
                  className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white"
                >
                  Run
                </button>
              </div>
            </div>

            <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_26rem]">
              <section className="min-w-0">
                <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                  Runs
                </h3>
                {agentRuns.length === 0 ? (
                  <p className="mt-2 text-sm text-neutral-600">Nothing has run yet.</p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {agentRuns.map((r) => (
                      <li key={r.id}>
                        <button
                          onClick={() => setView({ kind: "run", id: r.id })}
                          className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-900"
                        >
                          <span className={STATUS_COLOR[r.status] ?? "text-neutral-400"}>●</span>
                          <span className="text-neutral-300">{r.status}</span>
                          <span className="text-xs text-neutral-600">{r.trigger}</span>
                          <span className="ml-auto text-xs text-neutral-600">
                            {new Date(r.startedAt * 1000).toLocaleString(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <aside className="space-y-5 lg:border-l lg:border-neutral-800 lg:pl-6">
                {detailAgent.prompt && (
                  <RailSection title="Instructions">
                    <p
                      className={`whitespace-pre-wrap text-xs leading-relaxed text-neutral-400 ${
                        promptOpen ? "" : "line-clamp-3"
                      }`}
                    >
                      {detailAgent.prompt}
                    </p>
                    {/* Clamping is visual, so the toggle guesses from length rather than measuring. */}
                    {detailAgent.prompt.length > 150 && (
                      <button
                        onClick={() => setPromptOpen(!promptOpen)}
                        className="text-xs text-neutral-500 hover:text-neutral-300"
                      >
                        {promptOpen ? "Show less" : "Show more"}
                      </button>
                    )}
                  </RailSection>
                )}

                <RailSection title="Triggers">
                  {triggersOf(detailAgent).map((tr) => (
                    <div key={tr} className="truncate text-xs text-neutral-300" title={tr}>
                      {tr}
                    </div>
                  ))}
                </RailSection>

                {detailAgent.webhookSecret && deliveries.length > 0 && (
                  <RailSection title="Recent deliveries">
                    <DeliveryList deliveries={deliveries} limit={10} />
                  </RailSection>
                )}

                <RailSection title="Runs with">
                  <RailRow label="Workspace" value={workspaceSummary(detailAgent)} />
                  <RailRow label="Kind" value={workspaceKindLabel(detailAgent.workspaceKind)} />
                  <RailRow label="Model" value={detailAgent.model ?? "default"} />
                  {Object.keys(detailAgent.mcpServers).length > 0 && (
                    <RailRow label="MCP" value={Object.keys(detailAgent.mcpServers).join(", ")} />
                  )}
                </RailSection>

                <RailSection title="Details">
                  <RailRow label="Permissions" value={detailAgent.permissionMode} />
                  <RailRow label="Space" value={detailAgent.space ?? "unassigned"} />
                  <RailRow label="Concurrency" value={detailAgent.concurrency} />
                  {detailAgent.maxTurns != null && (
                    <RailRow label="Max turns" value={detailAgent.maxTurns} />
                  )}
                </RailSection>
              </aside>
            </div>
          </div>
        )}

        {view.kind === "detail" && !detailAgent && agents.length > 0 && (
          <div className="m-auto text-center text-sm text-neutral-600">
            <p>That agent no longer exists.</p>
            <button
              onClick={() => setView({ kind: "home" })}
              className="mt-2 text-neutral-400 hover:text-neutral-100"
            >
              Back to the roster
            </button>
          </div>
        )}

        {view.kind === "home" && (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <h2 className="text-lg font-semibold">
              {active.kind === "space" ? active.name : "All agents"}
            </h2>
            <p className="mt-1 text-xs text-neutral-500">
              {visibleAgents.length} agent{visibleAgents.length === 1 ? "" : "s"} · {runsToday} run
              {runsToday === 1 ? "" : "s"} in the last 24h
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              <Stat
                label="awaiting approval"
                value={awaiting.length}
                tone={awaiting.length > 0 ? "text-amber-400" : ""}
              />
              <Stat
                label="running"
                value={running.length}
                tone={running.length > 0 ? "text-sky-400" : ""}
              />
              <Stat
                label="last run failed"
                value={failing.length}
                tone={failing.length > 0 ? "text-red-400" : ""}
              />
              <Stat
                label="paused"
                value={paused.length}
                tone={paused.length > 0 ? "text-neutral-400" : ""}
              />
            </div>
            {metered && spendToday > 0 && (
              <p className="mt-2 text-xs text-neutral-500">
                ${spendToday.toFixed(2)} spent in the last 24h
              </p>
            )}

            <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <HomeSection title="Recent activity">
                {scopedRuns.length === 0 ? (
                  <p className="text-sm text-neutral-600">Nothing has run yet.</p>
                ) : (
                  scopedRuns.slice(0, 15).map((r) => (
                    <button
                      key={r.id}
                      onClick={() => setView({ kind: "run", id: r.id })}
                      className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-900"
                    >
                      <span className={STATUS_COLOR[r.status] ?? "text-neutral-400"}>●</span>
                      <span className="truncate text-neutral-200">{agentName(r.agentId)}</span>
                      <span className="shrink-0 text-xs text-neutral-600">{r.trigger}</span>
                      <span className="ml-auto shrink-0 text-xs text-neutral-600">
                        {ago(r.startedAt)}
                      </span>
                    </button>
                  ))
                )}
              </HomeSection>

              <div className="space-y-8">
                {awaiting.length > 0 && (
                  <HomeSection
                    title="Needs you"
                    hint="A pending approval blocks the agent until answered."
                  >
                    {awaiting.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => setView({ kind: "run", id: r.id })}
                        className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-900"
                      >
                        <span className="text-amber-400">●</span>
                        <span className="truncate text-neutral-200">{agentName(r.agentId)}</span>
                        <span className="ml-auto shrink-0 text-xs text-neutral-600">
                          {ago(r.startedAt)}
                        </span>
                      </button>
                    ))}
                  </HomeSection>
                )}

                {failing.length > 0 && (
                  <HomeSection
                    title="Last run failed"
                    hint="Nothing else reports this — check it here."
                  >
                    {failing.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => setView({ kind: "detail", id: a.id })}
                        className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-900"
                      >
                        <span className="text-red-400">●</span>
                        <span className="truncate text-neutral-200">{a.name}</span>
                        <span className="ml-auto shrink-0 text-xs text-neutral-600">
                          {ago(latestByAgent.get(a.id)!.startedAt)}
                        </span>
                      </button>
                    ))}
                  </HomeSection>
                )}

                {scopedUpcoming.length > 0 && (
                  <HomeSection title="Up next" hint="Scheduled cron fires, soonest first.">
                    {scopedUpcoming.slice(0, 6).map((u) => (
                      <button
                        key={`${u.agentId}-${u.at}`}
                        onClick={() => setView({ kind: "detail", id: u.agentId })}
                        className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-900"
                      >
                        <span className="text-neutral-700">●</span>
                        <span className="truncate text-neutral-300">{agentName(u.agentId)}</span>
                        <span className="ml-auto shrink-0 text-xs text-neutral-600">
                          {new Date(u.at).toLocaleString(undefined, {
                            weekday: "short",
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </span>
                      </button>
                    ))}
                  </HomeSection>
                )}

                {paused.length > 0 && (
                  <HomeSection title="Paused" hint="Triggers are off until these are re-enabled.">
                    {paused.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => setView({ kind: "detail", id: a.id })}
                        className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-900"
                      >
                        <span className="text-neutral-700">●</span>
                        <span className="truncate text-neutral-300">{a.name}</span>
                        <span className="ml-auto shrink-0 text-xs text-neutral-600">
                          {triggersOf(a)[0]}
                        </span>
                      </button>
                    ))}
                  </HomeSection>
                )}

                {awaiting.length === 0 && failing.length === 0 && paused.length === 0 && (
                  <p className="text-sm text-neutral-600">Nothing needs you right now.</p>
                )}
              </div>
            </div>
          </div>
        )}

        {view.kind === "run" && run && (
          <>
            <header className="flex items-center gap-3 border-b border-neutral-800 px-6 py-3">
              <span className={`text-sm font-medium ${STATUS_COLOR[run.status] ?? ""}`}>{run.status}</span>
              <span className="text-sm text-neutral-300">{agentName(run.agentId)}</span>
              {run.branch && <span className="font-mono text-xs text-neutral-500">{run.branch}</span>}
              {run.numTurns != null && <span className="text-xs text-neutral-500">{run.numTurns} turns</span>}
              {canReply && (
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

        {view.kind !== "edit" && (
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
                  if (canReply && run) {
                    api.send(run.id, prompt.trim());
                    setPrompt("");
                  } else if (selectedAgentId ?? agents[0]) {
                    void start(selectedAgentId ?? agents[0]!.id, true);
                  }
                }}
                placeholder={canReply ? "Reply to this run…" : "Prompt for a new run…"}
                className="flex-1 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-600"
              />
              {!canReply && (
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
