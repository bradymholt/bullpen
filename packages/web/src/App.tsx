import { useEffect, useRef, useState } from "react";
import { AgentEditor } from "./AgentEditor.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { GitPanel } from "./GitPanel.tsx";
import { api } from "./api.ts";
import { MODES, modeLabel } from "./modes.ts";
import { ago, took } from "./time.ts";
import { DeliveryList, GroupedDeliveryList } from "./DeliveryList.tsx";
import { Timeline } from "./Timeline.tsx";
import { useRun } from "./useRun.ts";
import type { Agent, Delivery, Run, Skill, Stats } from "./types.ts";

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
  // Each maps to the first word of the option in the editor's Workspace menu.
  if (kind === "persistent") return "scratch";
  if (kind === "git") return "clone";
  if (kind === "ephemeral") return "fresh";
  return kind;
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
  /** Everything a space owns: its name, and the webhook the whole space answers. */
  | { kind: "space"; name: string }
  /** The roster at a glance, outside any one agent. */
  | { kind: "home" };

function viewToPath(v: View): string {
  if (v.kind === "detail") return `/agents/${v.id}`;
  if (v.kind === "run") return `/runs/${v.id}`;
  if (v.kind === "edit") return v.agent ? `/agents/${v.agent.id}/edit` : "/agents/new";
  if (v.kind === "space") return `/spaces/${encodeURIComponent(v.name)}`;
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
  m = /^\/spaces\/([^/]+)$/.exec(p);
  if (m) return { view: { kind: "space", name: decodeURIComponent(m[1]!) } };
  return { view: { kind: "home" } };
}

export function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [route] = useState(() => pathToView(location.pathname));
  const [view, setViewState] = useState<View>(route.view);
  const [pendingEdit, setPendingEdit] = useState<string | null>(route.editId ?? null);

  const [editDirty, setEditDirty] = useState(false);
  const viewRef = useRef(view);
  const dirtyRef = useRef(false);
  viewRef.current = view;
  dirtyRef.current = editDirty;

  /** Leaving the editor with unsaved edits asks first; everything else is free. */
  const confirmLeave = (next: View): boolean => {
    const cur = viewRef.current;
    if (cur.kind !== "edit" || next.kind === "edit" || !dirtyRef.current) return true;
    return confirm("Discard unsaved changes to this agent?");
  };

  const setView = (next: View) => {
    if (!confirmLeave(next)) return;
    setEditDirty(false);
    setViewState(next);
    setPendingEdit(null);
    const path = viewToPath(next);
    if (path !== location.pathname) history.pushState(null, "", path);
  };
  const [prompt, setPrompt] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [metered, setMetered] = useState(false);
  const [skillIndex, setSkillIndex] = useState(0);
  const [liveMode, setLiveMode] = useState("auto");
  const [space, setSpace] = useState<SpaceFilter>(loadSpaceFilter);
  const [spaceDraft, setSpaceDraft] = useState("");
  const [spaceSecret, setSpaceSecret] = useState<{
    configured: boolean;
    hookId: string | null;
    value?: string;
  } | null>(null);
  const [spaceError, setSpaceError] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const promptRef = useRef<HTMLParagraphElement>(null);
  const [promptOverflows, setPromptOverflows] = useState(false);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [showFiltered, setShowFiltered] = useState(false);
  const [upcoming, setUpcoming] = useState<{ agentId: string; at: string }[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  // null until fetched: an empty list would flash "nothing has run" before the answer arrives.
  const [agentRuns, setAgentRuns] = useState<Run[] | null>(null);
  const [drops, setDrops] = useState<Delivery[]>([]);
  const [spaceDeliveries, setSpaceDeliveries] = useState<Delivery[]>([]);

  // Back and forward are the browser's, so the view follows the URL rather than
  // the other way round.
  useEffect(() => {
    const onPop = () => {
      const next = pathToView(location.pathname);
      if (!confirmLeave(next.view)) {
        // Back was refused: put the editor's URL back so the bar matches the page.
        history.pushState(null, "", viewToPath(viewRef.current));
        return;
      }
      setEditDirty(false);
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

  const spaceName = view.kind === "space" ? view.name : null;
  // Keyed by the stable id once one exists, so a rename can't move the URL.
  const spaceHookUrl = spaceName
    ? `${location.origin}/api/hooks/space/${encodeURIComponent(spaceSecret?.hookId ?? spaceName)}`
    : "";
  useEffect(() => {
    setSpaceError(null);
    if (spaceName === null) return setSpaceSecret(null);
    setSpaceDraft(spaceName);
    void api
      .spaceDeliveries(spaceName)
      .then(setSpaceDeliveries)
      .catch(() => setSpaceDeliveries([]));
    void api
      .spaceSecretState(spaceName)
      .then((s) => setSpaceSecret({ configured: s.configured, hookId: s.hookId }))
      .catch(() => setSpaceSecret(null));
  }, [spaceName]);

  const detailId = view.kind === "detail" ? view.id : null;
  useEffect(() => setPromptOpen(false), [detailId]);
  // Only meaningful while clamped: an open paragraph never overflows.
  useEffect(() => {
    if (promptOpen) return;
    const el = promptRef.current;
    setPromptOverflows(el !== null && el.scrollHeight > el.clientHeight + 1);
  }, [detailId, promptOpen, agents.find((a) => a.id === detailId)?.prompt]);

  useEffect(() => {
    setAgentRuns(null);
    if (detailId === null) return;
    void api.runsFor(detailId).then(setAgentRuns).catch(() => setAgentRuns([]));
  }, [detailId, runs]);

  // Refetched when runs change so a delivery that just fired shows up without a reload.
  useEffect(() => {
    if (detailId === null) return setDeliveries([]);
    void api
      .deliveries(detailId, showFiltered)
      .then(setDeliveries)
      .catch(() => setDeliveries([]));
  }, [detailId, runs, showFiltered]);

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
    api.stats().then(setStats).catch(() => setStats(null));
    api.notableDrops().then(setDrops).catch(() => setDrops([]));
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
        // No mode: the run uses whatever the agent is configured for.
        undefined,
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
    if (to === from) return;
    if (to !== null && to.length === 0) return;
    setSpaceError(null);
    try {
      await api.renameSpace(from, to);
      // Follow the agents so they don't vanish from under the selection.
      setSpace(to === null ? { kind: "unassigned" } : { kind: "space", name: to });
      setView(to === null ? { kind: "home" } : { kind: "space", name: to });
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
  const latestByAgent = stats?.latest ?? {};
  const failing = visibleAgents.filter((a) => latestByAgent[a.id]?.status === "failed");
  const paused = visibleAgents.filter((a) => !a.enabled);
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

  return (
    <div className="flex h-screen bg-neutral-950 font-sans text-neutral-100">
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-neutral-800 p-4">
        <button
          onClick={() => setView({ kind: "home" })}
          className="flex shrink-0 items-center gap-2 text-left"
          title="Home"
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
                  <button
                    onClick={() => setView({ kind: "space", name: sp })}
                    title={`Settings for "${sp}"`}
                    className="max-w-0 overflow-hidden text-neutral-500 opacity-0 transition-all duration-150 hover:text-neutral-100 focus:ml-1 focus:max-w-5 focus:opacity-100 group-hover:ml-1 group-hover:max-w-5 group-hover:opacity-100"
                  >
                    &#9881;
                  </button>
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
          const live = stats?.active[a.id] ?? 0;
          const last = stats?.latest[a.id];
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
                    {workspaceKindLabel(a.workspaceKind)} · {modeLabel(a.permissionMode)}
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
              {/* A webhook or poll agent reads its payload from disk; run bare, there is none. */}
              {!a.webhookSecret && !a.pollUrl && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    void start(a.id);
                  }}
                  className="mt-2 inline-block rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 hover:bg-white"
                >
                  Run
                </span>
              )}
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
              onDirtyChange={setEditDirty}
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
                {!detailAgent.webhookSecret && !detailAgent.pollUrl && (
                  <button
                    onClick={() => void start(detailAgent.id)}
                    className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white"
                  >
                    Run
                  </button>
                )}
              </div>
            </div>

            <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_26rem]">
              <section className="min-w-0">
                <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                  Runs
                </h3>
                {agentRuns === null ? null : agentRuns.length === 0 ? (
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
                          <span className="shrink-0 text-neutral-300">{r.status}</span>
                          {r.label && (
                            <span className="truncate text-xs text-neutral-400">{r.label}</span>
                          )}
                          <span className="shrink-0 text-xs text-neutral-600">{r.trigger}</span>
                          {r.numTurns != null && (
                            <span className="text-xs text-neutral-600">{r.numTurns} turns</span>
                          )}
                          {took(r) && <span className="text-xs text-neutral-600">{took(r)}</span>}
                          <span
                            className="ml-auto text-xs tabular-nums text-neutral-600"
                            title={new Date(r.startedAt * 1000).toLocaleString()}
                          >
                            {ago(r.startedAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <aside className="space-y-5 lg:border-l lg:border-neutral-800 lg:pl-6">
                {detailAgent.prompt && (
                  <RailSection title="Prompt">
                    <p
                      ref={promptRef}
                      className={`whitespace-pre-wrap text-xs leading-relaxed text-neutral-400 ${
                        promptOpen ? "" : "line-clamp-3"
                      }`}
                    >
                      {detailAgent.prompt}
                    </p>
                    {(promptOpen || promptOverflows) && (
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

                {detailAgent.webhookSecret && (
                  <RailSection title="Recent webhook deliveries">
                    {deliveries.length > 0 ? (
                      <DeliveryList deliveries={deliveries} limit={10} />
                    ) : (
                      <p className="text-xs text-neutral-600">Nothing yet.</p>
                    )}
                    <button
                      onClick={() => setShowFiltered((v) => !v)}
                      className="text-xs text-neutral-500 hover:text-neutral-300"
                    >
                      {showFiltered ? "Hide filtered" : "Show filtered"}
                    </button>
                    <p className="text-xs leading-relaxed text-neutral-600">
                      {showFiltered
                        ? "Including deliveries this agent's own filters refused."
                        : "Filter and allowlist misses are hidden — on a shared space URL they arrive constantly."}
                    </p>
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
                  <RailRow label="Permissions" value={modeLabel(detailAgent.permissionMode)} />
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
              Back to home
            </button>
          </div>
        )}

        {view.kind === "space" && (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <button
              onClick={() => setView({ kind: "home" })}
              className="text-xs text-neutral-500 hover:text-neutral-300"
            >
              &larr; Home
            </button>
            <h2 className="mt-2 text-lg font-semibold">{view.name}</h2>
            <p className="mt-1 text-xs text-neutral-500">
              {agents.filter((a) => a.space === view.name).length} agent
              {agents.filter((a) => a.space === view.name).length === 1 ? "" : "s"} in this space
            </p>

            <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="min-w-0 space-y-8">
              <RailSection title="Name">
                <div className="flex gap-2">
                  <input
                    className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm outline-none focus:border-neutral-600"
                    value={spaceDraft}
                    onChange={(e) => setSpaceDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void moveSpace(view.name, spaceDraft.trim());
                    }}
                  />
                  <button
                    onClick={() => void moveSpace(view.name, spaceDraft.trim())}
                    disabled={spaceDraft.trim() === view.name || spaceDraft.trim() === ""}
                    className="shrink-0 rounded border border-neutral-700 px-3 text-sm hover:bg-neutral-900 disabled:opacity-40"
                  >
                    Rename
                  </button>
                </div>
                <p className="text-xs text-neutral-600">
                  Renaming moves every agent in the space and carries the shared secret with it, but
                  the webhook URL below changes — repoint the sender afterwards.
                </p>
                {spaceError && <p className="text-xs text-red-400">{spaceError}</p>}
              </RailSection>

              <RailSection title="Shared webhook">
                <span className="block text-xs font-medium uppercase tracking-wide text-neutral-500">URL</span>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={spaceHookUrl}
                    className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-400 outline-none"
                  />
                  <button
                    onClick={() =>
                      void navigator.clipboard.writeText(
                        spaceHookUrl,
                      )
                    }
                    className="shrink-0 rounded border border-neutral-700 px-3 text-xs hover:bg-neutral-800"
                  >
                    Copy
                  </button>
                </div>
                <span className="block text-xs font-medium uppercase tracking-wide text-neutral-500 pt-2">Secret</span>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={
                      spaceSecret?.value ??
                      (spaceSecret?.configured ? "\u2022".repeat(24) : "no shared secret yet")
                    }
                    className={`w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs outline-none ${
                      spaceSecret?.value ? "text-neutral-200" : "text-neutral-500"
                    }`}
                  />
                  {spaceSecret?.value && (
                    <button
                      onClick={() => void navigator.clipboard.writeText(spaceSecret.value!)}
                      className="shrink-0 rounded border border-neutral-700 px-3 text-xs hover:bg-neutral-800"
                    >
                      Copy
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      if (
                        spaceSecret?.configured &&
                        !confirm(
                          "Replace this space's secret? Every sender using the old one stops working until you repaste.",
                        )
                      ) {
                        return;
                      }
                      const r = await api.setSpaceSecret(view.name);
                      setSpaceSecret({ configured: true, hookId: r.hookId, value: r.secret });
                    }}
                    className="shrink-0 rounded border border-neutral-700 px-3 text-xs text-amber-400 hover:bg-neutral-800"
                  >
                    {spaceSecret?.configured ? "Rotate" : "Generate"}
                  </button>
                </div>
                <p className="text-xs leading-relaxed text-neutral-600">
                  One webhook for the whole space. Every enabled agent in it gets the delivery and
                  its own filters decide whether it runs, so agents split by author or action share
                  one hook. This secret is the space&rsquo;s own — the per-agent secrets are not
                  used here. It is shown once, when generated.
                </p>
              </RailSection>

              <RailSection title="Recent webhook deliveries">
                {spaceDeliveries.length === 0 ? (
                  <p className="text-xs text-neutral-600">
                    Nothing has arrived at this URL yet.
                  </p>
                ) : (
                  <>
                    <GroupedDeliveryList
                      deliveries={spaceDeliveries}
                      limit={8}
                      agentName={agentName}
                    />
                    <p className="text-xs leading-relaxed text-neutral-600">
                      One block per delivery. The shared URL hands each one to every agent in the
                      space, so a single event normally shows one OK and several DROPs — the drops
                      are the agents whose filters correctly declined it.
                    </p>
                  </>
                )}
              </RailSection>

              </div>

              <div className="min-w-0 space-y-8">
              <RailSection title="Agents">
                {agents
                  .filter((a) => a.space === view.name)
                  .map((a) => (
                    <button
                      key={a.id}
                      onClick={() => setView({ kind: "detail", id: a.id })}
                      className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-900"
                    >
                      <span className="truncate text-neutral-200">{a.name}</span>
                      <span className="ml-auto shrink-0 truncate text-xs text-neutral-600">
                        {triggersOf(a)[0]}
                      </span>
                    </button>
                  ))}
              </RailSection>

              <RailSection title="Empty this space">
                <button
                  onClick={() => {
                    const n = agents.filter((a) => a.space === view.name).length;
                    if (confirm(`Move ${n} agent(s) out of "${view.name}"? The space disappears.`)) {
                      void moveSpace(view.name, null);
                    }
                  }}
                  className="rounded border border-red-900 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950"
                >
                  Unassign every agent
                </button>
                <p className="text-xs text-neutral-600">
                  The agents keep working; they just stop being grouped. The shared secret is
                  discarded, so the webhook URL stops answering.
                </p>
              </RailSection>
              </div>
            </div>
          </div>
        )}

        {view.kind === "home" && (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="flex items-baseline gap-3">
              <h2 className="text-lg font-semibold">
                {active.kind === "space" ? active.name : "All agents"}
              </h2>
              {active.kind === "space" && (
                <button
                  onClick={() => setView({ kind: "space", name: active.name })}
                  className="text-xs text-neutral-500 hover:text-neutral-300"
                >
                  Space settings
                </button>
              )}
            </div>
            <p className="mt-1 text-xs text-neutral-500">
              {visibleAgents.length} agent{visibleAgents.length === 1 ? "" : "s"}
              {stats && (
                <>
                  {" · "}
                  {stats.last24h} run{stats.last24h === 1 ? "" : "s"} in the last 24h
                  {stats.prev24h > 0 && (
                    <span
                      className="text-neutral-600"
                    >
                      {" "}
                      ({stats.last24h > stats.prev24h ? "\u2191" : "\u2193"}{" "}
                      {Math.abs(stats.last24h - stats.prev24h)} vs the day before)
                    </span>
                  )}
                </>
              )}
            </p>

            {awaiting.length + running.length + failing.length + paused.length === 0 ? (
              <p className="mt-4 text-sm text-neutral-500">
                <span className="text-emerald-500">●</span> All clear — nothing awaiting approval,
                running, failed, or paused.
              </p>
            ) : (
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
            )}
            {metered && (stats?.spend24h ?? 0) > 0 && (
              <p className="mt-2 text-xs text-neutral-500">
                ${stats!.spend24h.toFixed(2)} spent in the last 24h
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
                      <span className="shrink-0 text-neutral-200">{agentName(r.agentId)}</span>
                      {r.label && (
                        <span className="truncate text-xs text-neutral-400">{r.label}</span>
                      )}
                      <span className="shrink-0 text-xs text-neutral-600">{r.trigger}</span>
                      {r.numTurns != null && (
                        <span className="shrink-0 text-xs text-neutral-600">{r.numTurns} turns</span>
                      )}
                      {took(r) && (
                        <span className="shrink-0 text-xs text-neutral-600">{took(r)}</span>
                      )}
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
                          {ago(latestByAgent[a.id]!.startedAt)}
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

                {drops.length > 0 && (
                  <HomeSection
                    title="Didn't run · last 24h"
                    hint="Refused for a reason other than a filter miss. Nothing is retried — GitHub does not redeliver."
                  >
                    {drops.slice(0, 6).map((d) => (
                      <button
                        key={d.id}
                        onClick={() => setView({ kind: "detail", id: d.agentId })}
                        className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-900"
                      >
                        <span className="text-amber-400">●</span>
                        <span className="shrink-0 text-xs tabular-nums text-neutral-400">
                          {ago(d.ts)}
                        </span>
                        <span className="shrink-0 text-neutral-300">{agentName(d.agentId)}</span>
                        {d.label && (
                          <span className="truncate font-mono text-xs text-neutral-400">
                            {d.label}
                          </span>
                        )}
                        <span className="ml-auto shrink-0 truncate text-xs text-neutral-600">
                          {d.reason}
                        </span>
                      </button>
                    ))}
                  </HomeSection>
                )}

                {awaiting.length === 0 &&
                  failing.length === 0 &&
                  paused.length === 0 &&
                  drops.length === 0 && (
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
              <button
                onClick={() => setView({ kind: "detail", id: run.agentId })}
                className="text-sm text-neutral-300 hover:text-neutral-100"
                title="Back to this agent"
              >
                &larr; {agentName(run.agentId)}
              </button>
              {run.label && <span className="truncate font-mono text-xs text-neutral-400">{run.label}</span>}
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
                    {/* A run can only enter Bypass if it started there. */}
                    {MODES.filter(([v]) => v !== "full" || run.permissionMode === "full").map(
                      ([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ),
                    )}
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

        {(view.kind === "run" || view.kind === "detail") && selectedAgentId && (
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
                  } else if (selectedAgentId) {
                    void start(selectedAgentId, true);
                  }
                }}
                placeholder={
                  canReply
                    ? "Reply to this run…"
                    : `One-off run of ${agentName(selectedAgentId ?? "")}…`
                }
                className="flex-1 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-600"
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
