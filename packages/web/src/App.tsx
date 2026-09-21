import { useEffect, useRef, useState } from "react";
import { AgentEditor } from "./AgentEditor.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { GitPanel } from "./GitPanel.tsx";
import { api } from "./api.ts";
import { MODES, modeLabel } from "./modes.ts";
import { ago, took } from "./time.ts";
import { DeliveryList, GroupedDeliveryList } from "./DeliveryList.tsx";
import { EnvEditor } from "./EnvEditor.tsx";
import { McpServerForm } from "./McpServerForm.tsx";
import { SetupView } from "./SetupView.tsx";
import { McpAuth } from "./McpAuth.tsx";
import { Timeline } from "./Timeline.tsx";
import { useRun } from "./useRun.ts";
import type {
  McpCatalogEntry, Artifact, Agent, Delivery, MachineMcp, Run, Skill, SkillsState, Stats } from "./types.ts";
import { DEFAULT_SPACE } from "./types.ts";

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

function PencilIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" />
      <path d="M10 4l2 2" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** A server's last-known state from runs' init messages; the title carries the time and any error. */
function McpHealthBadge({ h, compact = false }: { h?: { status: string; at: number; error?: string }; compact?: boolean }) {
  if (!h) return compact ? null : <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-800" title="No run has reached this server yet" />;
  const tone =
    h.status === "connected" ? "bg-emerald-500" : h.status === "needs-auth" ? "bg-amber-500" : h.status === "pending" ? "bg-neutral-500" : "bg-red-500";
  const title = `${h.status} · ${ago(h.at)}${h.error ? ` · ${h.error}` : ""}`;
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} title={title} />;
}

/** Extensions the artifact route will serve inline; everything else only downloads. */
const VIEWABLE = /\.(png|jpe?g|gif|webp|svg|pdf|txt|md|json|csv|html)$/i;

/** Files the agent left in .bullpen/out — fetched once the run has ended, since that is when they are collected. */
function ArtifactsPanel({ runId, status }: { runId: string; status: string }) {
  const [files, setFiles] = useState<Artifact[] | null>(null);
  const ended = !ACTIVE.has(status) && status !== "queued";
  useEffect(() => {
    if (!ended) return;
    void api.runArtifacts(runId).then(setFiles).catch(() => setFiles([]));
  }, [runId, ended]);
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set());
  if (!files || files.length === 0) return null;
  const fmt = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const href = (name: string) => `/api/runs/${runId}/artifacts/${name.split("/").map(encodeURIComponent).join("/")}`;
  // A report is usually the thing that was sent somewhere; reading it should not
  // mean downloading it first. The server serves these sandboxed.
  const viewable = (name: string) => VIEWABLE.test(name);
  // Top-level files are the deliverables; a subfolder (Playwright's snapshots, say) is one line until opened.
  const top = files.filter((f) => !f.name.includes("/"));
  const dirs = new Map<string, Artifact[]>();
  for (const f of files) {
    const i = f.name.indexOf("/");
    if (i > 0) {
      const dir = f.name.slice(0, i);
      dirs.set(dir, [...(dirs.get(dir) ?? []), f]);
    }
  }
  const FileLink = ({ f, short = false }: { f: Artifact; short?: boolean }) => (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <a href={href(f.name)} download className="font-mono text-sm text-neutral-200 underline decoration-neutral-700 hover:text-white">
        {short ? f.name.slice(f.name.indexOf("/") + 1) : f.name}
      </a>
      <span className="text-xs text-neutral-600">{fmt(f.size)}</span>
      {viewable(f.name) && (
        <a
          href={`${href(f.name)}?inline=1`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          view
        </a>
      )}
    </span>
  );
  return (
    <div className="mt-3 rounded border border-neutral-800 px-3 py-2">
      <div className="mb-1 font-mono text-xs uppercase tracking-wide text-neutral-500">Files</div>
      {top.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {top.map((f) => <FileLink key={f.name} f={f} />)}
        </div>
      )}
      {[...dirs.entries()].map(([dir, list]) => (
        <div key={dir} className="mt-1">
          <button
            onClick={() => setOpenDirs((prev) => { const n = new Set(prev); n.has(dir) ? n.delete(dir) : n.add(dir); return n; })}
            className="text-xs text-neutral-500 hover:text-neutral-300"
          >
            {openDirs.has(dir) ? "\u25be" : "\u25b8"} <span className="font-mono">{dir}/</span> {list.length} file{list.length === 1 ? "" : "s"}
          </button>
          {openDirs.has(dir) && (
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 pl-4">
              {list.map((f) => <FileLink key={f.name} f={f} short />)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
        active
          ? "border-neutral-100 text-neutral-100"
          : "border-transparent text-neutral-500 hover:text-neutral-300"
      }`}
    >
      {children}
    </button>
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
  if (a.trigger === "schedule") return [`cron ${a.cron ?? "?"}${a.cronTimezone ? ` · ${a.cronTimezone}` : ""}`];
  if (a.trigger === "poll") return ["poll"];
  if (a.trigger === "webhook") return [`webhook · ${a.webhookMode}`];
  return ["manual only"];
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

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0 text-neutral-500" aria-hidden="true">
      <path d="M5 6.5 8 3.5l3 3M5 9.5l3 3 3-3" />
    </svg>
  );
}

/**
 * The space is a scope, not a filter: everything below it is already inside the
 * one on the button, so nothing further down the sidebar has to say which space
 * it means. Its own settings live in here for the same reason — the space is
 * never a mode the landing page drops into.
 */
function SpaceSwitcher({
  spaces,
  current,
  subtitle,
  onPick,
  onSettings,
  onNew,
  className = "",
}: {
  spaces: string[];
  current: string;
  subtitle: string;
  onPick: (next: string) => void;
  onSettings: (name: string) => void;
  onNew: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const item = "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-neutral-800";
  return (
    <div className={`relative shrink-0 ${className}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Switch space"
        className="flex w-full items-center gap-2 rounded border border-neutral-800 bg-neutral-900/60 p-2 text-left hover:border-neutral-700"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{current}</span>
          <span className="block truncate text-xs text-neutral-500">{subtitle}</span>
        </span>
        <ChevronIcon />
      </button>
      {open && (
        <>
          <button
            tabIndex={-1}
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="absolute inset-x-0 z-20 mt-1 overflow-hidden rounded border border-neutral-700 bg-neutral-900 py-1 shadow-xl">
            {spaces.map((name) => (
              <button key={name} onClick={() => { setOpen(false); onPick(name); }} className={item}>
                <span className={`w-3 shrink-0 text-xs ${name === current ? "text-neutral-100" : "text-transparent"}`}>
                  &bull;
                </span>
                <span className="truncate">{name}</span>
              </button>
            ))}
            <div className="my-1 border-t border-neutral-800" />
            <button onClick={() => { setOpen(false); onSettings(current); }} className={`${item} text-neutral-400`}>
              <span className="w-3 shrink-0" />
              Space settings&hellip;
            </button>
            <button onClick={() => { setOpen(false); onNew(); }} className={`${item} text-neutral-400`}>
              <span className="w-3 shrink-0" />
              New space&hellip;
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const SPACE_KEY = "bullpen.space";

/** The tagged union this replaced also had an "all" arm, so old values parse. */
function loadSpace(): string {
  try {
    const raw = localStorage.getItem(SPACE_KEY);
    if (!raw) return DEFAULT_SPACE;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string") return parsed;
    const name = (parsed as { name?: unknown } | null)?.name;
    if (typeof name === "string") return name;
  } catch {
    // Private windows and blocked site data throw rather than returning null.
  }
  return DEFAULT_SPACE;
}



/** Process-env names shown by default; the rest hide behind "show all". */
const INTERESTING_ENV =
  /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|^GITHUB_|^ANTHROPIC_|^CLAUDE_|^GOG_|^OPENAI_|^TZ$|^NODE_ENV$/i;

const STATUS_COLOR: Record<string, string> = {
  queued: "text-neutral-500",
  running: "text-sky-400",
  awaiting_approval: "text-amber-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  cancelled: "text-neutral-400",
  interrupted: "text-amber-400",
};

type View =
  | { kind: "run"; id: string }
  /** The agent's own page: its history, and its settings behind a tab. */
  | { kind: "detail"; id: string; tab?: "settings" }
  /** Only ever a brand-new agent; `seed` prefills it from an existing one. */
  | { kind: "edit"; seed?: Agent }
  /** The space's settings tab: its name, env, and the webhook the whole space answers. */
  | { kind: "space"; name: string }
  /** Global env and the box's own state — what `.env` used to be for. */
  | { kind: "settings" }
  /** The space's overview tab: what needs you, and what has been happening. */
  | { kind: "home" };

/** What a view is editing, so moving within the same form isn't "leaving" it. */
function editingKey(v: View): string | null {
  if (v.kind === "space") return `space:${v.name}`;
  if (v.kind === "edit") return "agent:new";
  if (v.kind === "detail" && v.tab === "settings") return `agent:${v.id}`;
  return null;
}

function viewToPath(v: View): string {
  if (v.kind === "detail") return `/agents/${v.id}${v.tab === "settings" ? "/settings" : ""}`;
  if (v.kind === "run") return `/runs/${v.id}`;
  if (v.kind === "edit") return "/agents/new";
  if (v.kind === "space") return `/spaces/${encodeURIComponent(v.name)}/settings`;
  if (v.kind === "settings") return "/settings";
  return "/";
}

function pathToView(path: string): { view: View; space?: string } {
  const p = path.replace(/\/+$/, "") || "/";
  if (p === "/agents/new") return { view: { kind: "edit" } };
  if (p === "/settings") return { view: { kind: "settings" } };
  let m = /^\/runs\/([\w-]+)$/.exec(p);
  if (m) return { view: { kind: "run", id: m[1]! } };
  // `/edit` is where the settings tab used to live as a page of its own.
  m = /^\/agents\/([\w-]+)\/(?:settings|edit)$/.exec(p);
  if (m) return { view: { kind: "detail", id: m[1]!, tab: "settings" } };
  m = /^\/agents\/([\w-]+)$/.exec(p);
  if (m) return { view: { kind: "detail", id: m[1]! } };
  // `/edit` is the spelling that predates the tab.
  m = /^\/spaces\/([^/]+)\/(?:settings|edit)$/.exec(p);
  if (m) {
    const name = decodeURIComponent(m[1]!);
    return { view: { kind: "space", name }, space: name };
  }
  // A space's landing is the home view filtered to it.
  m = /^\/spaces\/([^/]+)$/.exec(p);
  if (m) return { view: { kind: "home" }, space: decodeURIComponent(m[1]!) };
  return { view: { kind: "home" } };
}

export function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [route] = useState(() => pathToView(location.pathname));
  const [view, setViewState] = useState<View>(route.view);

  const [editDirty, setEditDirty] = useState(false);
  const viewRef = useRef(view);
  const dirtyRef = useRef(false);
  viewRef.current = view;

  /** Leaving an editor with unsaved edits asks first; everything else is free. */
  const confirmLeave = (next: View): boolean => {
    const key = editingKey(viewRef.current);
    if (key === null || key === editingKey(next) || !dirtyRef.current) return true;
    return confirm(
      key.startsWith("space:")
        ? "Discard unsaved changes to this space?"
        : "Discard unsaved changes to this agent?",
    );
  };

  const setView = (next: View) => {
    if (!confirmLeave(next)) return;
    setEditDirty(false);
    setViewState(next);
    const path = viewToPath(next);
    if (path !== location.pathname) history.pushState(null, "", path);
  };
  const [prompt, setPrompt] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [metered, setMetered] = useState(false);
  // null until health answers; "none" swaps the whole app for setup.
  const [credentialSource, setCredentialSource] = useState<string | null>(null);
  // Webhook URLs are built from this: the funneled public base if the server has one, else this tab's origin.
  const [hookBase, setHookBase] = useState<string>(location.origin);
  const [build, setBuild] = useState<{ version: string; release: string | null; repoUrl: string | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<{ files: string; delivery: string; config: string | null } | null>(null);
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [showClaudeMd, setShowClaudeMd] = useState(false);
  const [setupGeneration, setSetupGeneration] = useState(0);
  // Setup can be re-entered on purpose to replace a token; it saves over the same keys.
  // `?setup=1` reopens onboarding on a configured install; there is no button for it.
  const [forceSetup, setForceSetup] = useState(() => new URLSearchParams(location.search).has("setup"));
  const [skillIndex, setSkillIndex] = useState(0);
  const [liveMode, setLiveMode] = useState("auto");
  const [space, setSpace] = useState<string>(() => route.space ?? loadSpace());
  const [spaceDraft, setSpaceDraft] = useState("");
  const [spaceSecret, setSpaceSecret] = useState<{
    configured: boolean;
    hookId: string | null;
    value?: string;
  } | null>(null);
  const [spaceError, setSpaceError] = useState<string | null>(null);
  /** A space named in the switcher exists only once an agent lands in it. */
  const [pendingSpace, setPendingSpace] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  // On an agent's own page the full delivery history is the point; the home panel is the curated one.
  const [showFiltered, setShowFiltered] = useState(true);
  const [upcoming, setUpcoming] = useState<{ agentId: string; at: string }[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  // null until fetched: an empty list would flash "nothing has run" before the answer arrives.
  const [agentRuns, setAgentRuns] = useState<Run[] | null>(null);
  const [drops, setDrops] = useState<Delivery[]>([]);
  const [spaceDeliveries, setSpaceDeliveries] = useState<Delivery[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);
  const [spaceEnvMap, setSpaceEnvMap] = useState<Record<string, string> | null>(null);
  const [spaceEnvLoaded, setSpaceEnvLoaded] = useState<string>("");
  const spaceKnown =
    view.kind !== "space" ||
    view.name === DEFAULT_SPACE ||
    agents.some((a) => a.space === view.name) ||
    spaceSecret?.configured === true;

  const spaceDirty =
    view.kind === "space" &&
    (spaceDraft.trim() !== view.name ||
      (spaceEnvMap !== null && JSON.stringify(spaceEnvMap) !== spaceEnvLoaded));
  dirtyRef.current = editDirty || spaceDirty;
  const [globalEnvMap, setGlobalEnvMap] = useState<Record<string, string> | null>(null);
  const [envSaved, setEnvSaved] = useState<string | null>(null);
  const [processEnvNames, setProcessEnvNames] = useState<string[] | null>(null);
  const [skillsInfo, setSkillsInfo] = useState<SkillsState | null>(null);
  const [skillsPulling, setSkillsPulling] = useState(false);
  const [skillsSource, setSkillsSource] = useState({ url: "", path: "" });
  const [skillsNote, setSkillsNote] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [machineMcp, setMachineMcp] = useState<MachineMcp | null>(null);
  const [skillList, setSkillList] = useState<Skill[]>([]);
  const [claudeMd, setClaudeMd] = useState<{ path: string; exists: boolean; size: number; managed: boolean; content: string } | null>(null);
  const [claudeMdDraft, setClaudeMdDraft] = useState("");
  const [claudeMdNote, setClaudeMdNote] = useState<string | null>(null);
  const [mcpNote, setMcpNote] = useState<string | null>(null);
  const [mcpCatalogEntries, setMcpCatalogEntries] = useState<McpCatalogEntry[] | null>(null);
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [showAllProcessEnv, setShowAllProcessEnv] = useState(false);
  const [health, setHealth] = useState<{
    dataDir: string;
    claudeCredential: { source: string; detail: string };
  } | null>(null);

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
      if (next.space) setSpace(next.space);
      setViewState(next.view);
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const spaceName = view.kind === "space" ? view.name : null;
  // Keyed by the stable id once one exists, so a rename can't move the URL.
  const spaceHookUrl = spaceName
    ? `${hookBase}/api/hooks/space/${encodeURIComponent(spaceSecret?.hookId ?? spaceName)}`
    : "";
  useEffect(() => {
    setSpaceError(null);
    if (spaceName === null) return setSpaceSecret(null);
    setSpaceDraft(spaceName);
    setSpaceEnvMap(null);
    void api
      .spaceEnv(spaceName)
      .then((r) => {
        setSpaceEnvMap(r.env);
        setSpaceEnvLoaded(JSON.stringify(r.env));
      })
      .catch(() => setEnvSaved("Couldn\u2019t load this space\u2019s environment \u2014 reload before editing."));
    void api
      .spaceSecretState(spaceName)
      .then((s) => setSpaceSecret({ configured: s.configured, hookId: s.hookId }))
      .catch(() => setSpaceSecret(null));
  }, [spaceName]);

  useEffect(() => {
    if (view.kind !== "settings") return;
    setEnvSaved(null);
    setGlobalEnvMap(null);
    void api
      .globalEnv()
      .then((r) => setGlobalEnvMap(r.env))
      .catch(() => setEnvSaved("Couldn\u2019t load the global environment \u2014 reload before editing."));
    void api.health().then(setHealth).catch(() => setHealth(null));
    void api.systemPrompt().then(setSystemPrompt).catch(() => setSystemPrompt(null));
    void api.mcpCatalog().then((r) => setMcpCatalogEntries(r.managed ? r.entries : null)).catch(() => setMcpCatalogEntries(null));
    void api
      .processEnvNames()
      .then((r) => setProcessEnvNames(r.names))
      .catch(() => setProcessEnvNames([]));
    void api.skillsState().then(setSkillsInfo).catch(() => setSkillsInfo(null));
    void api.skills().then(setSkillList).catch(() => setSkillList([]));
    void api.machineMcp().then(setMachineMcp).catch(() => setMachineMcp(null));
    void api
      .claudeMd()
      .then((m) => { setClaudeMd(m); setClaudeMdDraft(m.content); })
      .catch(() => setClaudeMd(null));
    setImportResult(null);
    setMcpNote(null);
  }, [view.kind]);

  const detailId = view.kind === "detail" ? view.id : null;
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
      // Not worth surfacing: the space just won't survive a reload.
    }
  }, [space]);

  useEffect(() => {
    void api.skills().then(setSkills).catch(() => setSkills([]));
    void api
      .health()
      .then((h) => {
        setMetered(h.claudeCredential.source === "api-key");
        setCredentialSource(h.claudeCredential.source);
        if (h.publicUrl) setHookBase(h.publicUrl);
        setBuild(h.version ? { version: h.version, release: h.release, repoUrl: h.repoUrl } : null);
      })
      .catch(() => {
        setMetered(false);
        setCredentialSource("unknown");
      });
  }, [setupGeneration]);
  const [error, setError] = useState<string | null>(null);

  const { run, events, partial, approvals, missing: runMissing } = useRun(view.kind === "run" ? view.id : null);
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

  /** The sidebar's live/last-run line comes from `stats`, so it has to move with the runs list. */
  const refreshRuns = () => {
    setRefreshTick((t) => t + 1);
    api.runs().then(setRuns);
  };

  const refresh = () => {
    refreshRuns();
    api.agents().then(setAgents);
    api
      .scheduleAll()
      .then(setUpcoming)
      .catch(() => setUpcoming([]));
    api.notableDrops().then(setDrops).catch(() => setDrops([]));
  };
  useEffect(refresh, []);

  /** Paused means nothing starts it — not a webhook, a cron fire, a poll, or the Run button. */
  async function setPaused(a: Agent, paused: boolean) {
    await api.updateAgent(a.id, { enabled: !paused });
    refresh();
  }
  useEffect(() => {
    if (run && !ACTIVE.has(run.status)) refreshRuns();
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
      refreshRuns();
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
  const isQueued = run?.status === "queued";
  // Finished but still attached: replying continues the same session rather
  // than starting a fresh run with none of its context.
  const canReply = run != null && (isLive || run.resumable === true);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? "—";
  // Only spaces with agents in them, the default one included: an empty
  // space is not a place to go.
  const spaces = [...new Set(agents.map((a) => a.space))].sort();
  // A remembered space that no longer exists (renamed, or its last agent
  // deleted) shows everything rather than an empty roster.
  const active = spaces.includes(space) ? space : (spaces[0] ?? DEFAULT_SPACE);
  const visibleAgents = agents.filter((a) => a.space === active);


  /** The space's landing: the home view filtered to it. Bypasses the guard — callers have settled that. */
  const goToSpace = (name: string) => {
    setSpace(name);
    setViewState({ kind: "home" });
    const path = `/spaces/${encodeURIComponent(name)}`;
    if (path !== location.pathname) history.pushState(null, "", path);
  };

  /** The switcher's own navigation: the scope changes and the view goes back to its home. */
  const pickSpace = (next: string) => {
    if (!confirmLeave({ kind: "home" })) return;
    setEditDirty(false);
    setSpace(next);
    setViewState({ kind: "home" });
    const path = `/spaces/${encodeURIComponent(next)}`;
    if (path !== location.pathname) history.pushState(null, "", path);
  };

  /** Env first under the old name, then the rename carries the row along. */
  async function saveSpace(from: string) {
    const to = spaceDraft.trim();
    if (to.length === 0) return setSpaceError("name is required");
    setSpaceError(null);
    try {
      if (spaceEnvMap !== null && JSON.stringify(spaceEnvMap) !== spaceEnvLoaded) {
        const r = await api.setSpaceEnv(from, spaceEnvMap, Object.keys(spaceEnvMap).length === 0);
        setSpaceEnvMap(r.env);
        setSpaceEnvLoaded(JSON.stringify(r.env));
      }
      if (to !== from) await api.renameSpace(from, to);
      refresh();
      goToSpace(to);
    } catch (e) {
      setSpaceError(e instanceof Error ? e.message : String(e));
    }
  }

  // The space whose deliveries are on screen: the settings page's, or the
  // one the home view is filtered to. Refetched with everything else.
  const deliveriesSpace =
    view.kind === "space" ? view.name : view.kind === "home" ? active : null;
  // Stats follow the space filter: the landing's numbers are that space's.
  useEffect(() => {
    void api.stats(active).then(setStats).catch(() => setStats(null));
  }, [active, refreshTick]);

  const deliveriesSpaceHasWebhooks =
    deliveriesSpace !== null && agents.some((a) => a.space === deliveriesSpace && a.trigger === "webhook");
  useEffect(() => {
    if (deliveriesSpace === null) return setSpaceDeliveries([]);
    void api
      .spaceDeliveries(deliveriesSpace)
      .then(setSpaceDeliveries)
      .catch(() => setSpaceDeliveries([]));
  }, [deliveriesSpace, refreshTick]);

  async function removeSpace(name: string) {
    setSpaceError(null);
    try {
      await api.removeSpace(name);
      refresh();
      goToSpace(DEFAULT_SPACE);
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
  // With nothing to show beside it, the activity list takes the page alone.
  const quiet =
    awaiting.length + failing.length + paused.length + drops.length + scopedUpcoming.length === 0;

  const selectedAgentId =
    view.kind === "detail"
      ? view.id
      : view.kind === "run"
        ? (run?.agentId ?? null)
        : null;
  const detailAgent = view.kind === "detail" ? agents.find((a) => a.id === view.id) : undefined;

  const spaceHeading = (
    <>
      <h2 className="text-lg font-semibold">{active}</h2>
      <p className="mt-1 text-xs text-neutral-500">
        {visibleAgents.length} agent{visibleAgents.length === 1 ? "" : "s"}
        {stats && (
          <>
            {" · "}
            {stats.last24h} run{stats.last24h === 1 ? "" : "s"} in the last 24h
            {stats.prev24h > 0 && (
              <span className="text-neutral-600">
                {" "}
                ({stats.last24h > stats.prev24h ? "\u2191" : "\u2193"}{" "}
                {Math.abs(stats.last24h - stats.prev24h)} vs the day before)
              </span>
            )}
          </>
        )}
      </p>
    </>
  );

  const spaceTabs = (settings: boolean) => (
    <div className="mt-5 flex gap-1 border-b border-neutral-800">
      <TabButton active={!settings} onClick={() => setView({ kind: "home" })}>
        Overview
      </TabButton>
      <TabButton active={settings} onClick={() => setView({ kind: "space", name: active })}>
        Settings
      </TabButton>
    </div>
  );

  /** Every way out of the new-agent page: back to what it was copied from, or the roster. */
  const leaveEditor = () => {
    const seed = view.kind === "edit" ? view.seed : undefined;
    setView(seed ? { kind: "detail", id: seed.id } : { kind: "home" });
  };

  // Nothing can run without a credential, so there is no dashboard to show
  // behind a dialog — setup replaces it until health says otherwise.
  if (credentialSource === null) return <div className="h-screen bg-neutral-950" />;
  if (credentialSource === "none" || forceSetup) {
    return (
      <SetupView
        onDone={() => {
          setForceSetup(false);
          if (location.search) history.replaceState(null, "", location.pathname);
          setSetupGeneration((g) => g + 1);
        }}
      />
    );
  }

  return (
    <div className="flex h-screen bg-neutral-950 font-sans text-neutral-100">
      <aside className="flex w-72 shrink-0 flex-col border-r border-neutral-800">
        {/* Outside the scroller: an absolute menu inside one is clipped by it. */}
        <div className="shrink-0 px-4 pt-4">
          <button
            onClick={() => setView({ kind: "home" })}
            className="flex items-center gap-2 text-left"
            title="Home"
          >
            <img src="/favicon.svg" alt="" className="h-9 w-9" />
            <h1 className="text-lg font-semibold tracking-tight hover:text-white">Bullpen</h1>
          </button>

          <SpaceSwitcher
            spaces={spaces}
            current={active}
            subtitle={`${visibleAgents.length} agent${visibleAgents.length === 1 ? "" : "s"}`}
            onPick={pickSpace}
            onSettings={(name) => setView({ kind: "space", name })}
            onNew={() => {
              const name = window.prompt("Name the new space")?.trim();
              if (!name) return;
              setPendingSpace(name);
              setView({ kind: "edit" });
            }}
            className="mt-4"
          />
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
        <div className="mt-6 flex shrink-0 items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Agents</h2>
          <button
            onClick={() => {
              setPendingSpace(null);
              setView({ kind: "edit" });
            }}
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
              } ${a.enabled ? "" : "opacity-60"}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{a.name}</div>
                  <div className="mt-0.5 text-xs text-neutral-500">
                    {workspaceKindLabel(a.workspaceKind)} · {modeLabel(a.permissionMode)}
                  </div>
                  <div className="mt-0.5 text-xs">
                    {!a.enabled && live === 0 ? (
                      <span className="text-amber-500">paused</span>
                    ) : live > 0 ? (
                      <span className="text-sky-400">
                        {live} running
                        {(stats?.queued[a.id] ?? 0) > 0 ? ` · ${stats!.queued[a.id]} queued` : ""}
                      </span>
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
                    setView({ kind: "detail", id: a.id, tab: "settings" });
                  }}
                  title="Edit"
                  className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-100"
                >
                  <PencilIcon />
                </span>
              </div>
              {/* A webhook or poll agent reads its payload from disk; run bare, there is none. */}
              {a.enabled && (a.trigger === "manual" || a.trigger === "schedule") && (
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
        </div>
        <div className="flex shrink-0 items-center gap-1 border-t border-neutral-800 px-3 py-2">
          <button
            onClick={() => setView({ kind: "settings" })}
            className={`flex items-center gap-2 rounded px-1.5 py-1.5 text-xs ${
              view.kind === "settings" ? "text-neutral-100" : "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
            }`}
          >
            <GearIcon />
            Settings
          </button>
          {build && (
            <a
              href={
                build.repoUrl
                  ? build.release
                    ? `${build.repoUrl}/releases/tag/${build.release}`
                    : `${build.repoUrl}/commit/${build.version}`
                  : undefined
              }
              target="_blank"
              rel="noreferrer"
              title={build.release ? `Release ${build.release} · commit ${build.version}` : `Running commit ${build.version}`}
              className="ml-auto font-mono text-[11px] text-neutral-600 hover:text-neutral-300"
            >
              {build.release ?? build.version.slice(0, 7)}
            </a>
          )}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">

        {view.kind === "edit" && (
          <div className="flex-1 overflow-y-auto">
            <AgentEditor
              key={`new-${view.seed?.id ?? ""}-${pendingSpace ?? ""}`}
              agent={null}
              seed={view.seed ?? null}
              spaces={spaces}
              defaultSpace={pendingSpace ?? active}
              hookBase={hookBase}
              back={{ label: view.seed?.name ?? active, to: leaveEditor }}
              onSaved={(saved) => {
                // Saved, so there is nothing to discard — and the guard reads the ref
                // synchronously, before the state update below has rendered.
                dirtyRef.current = false;
                setEditDirty(false);
                refresh();
                setView({ kind: "detail", id: saved.id });
              }}
              onDeleted={() => {
                dirtyRef.current = false;
                setEditDirty(false);
                refresh();
                setView({ kind: "home" });
              }}
              onCancel={leaveEditor}
              onDirtyChange={(d) => {
                dirtyRef.current = d;
                setEditDirty(d);
              }}
            />
          </div>
        )}

        {view.kind === "detail" && detailAgent && (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">{detailAgent.name}</h2>
                {!detailAgent.enabled && (
                  <p className="mt-1 text-xs text-amber-500">
                    Paused &mdash; nothing starts it until you resume. Webhooks are refused, cron fires
                    and polls are skipped.
                  </p>
                )}
                {detailAgent.description && (
                  <p className="mt-1 text-xs text-neutral-500">{detailAgent.description}</p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => setView({ kind: "edit", seed: detailAgent })}
                  title="Start a new agent prefilled with this one's settings"
                  className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-900"
                >
                  Copy
                </button>
                {detailAgent.enabled ? (
                  <button
                    onClick={() => void setPaused(detailAgent, true)}
                    title="Stop every trigger until resumed; running work finishes"
                    className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-900"
                  >
                    Pause
                  </button>
                ) : (
                  <button
                    onClick={() => void setPaused(detailAgent, false)}
                    className="rounded border border-amber-700 px-3 py-1.5 text-sm text-amber-300 hover:bg-amber-950"
                  >
                    Resume
                  </button>
                )}
                {detailAgent.enabled && (detailAgent.trigger === "manual" || detailAgent.trigger === "schedule") && (
                  <button
                    onClick={() => void start(detailAgent.id)}
                    className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white"
                  >
                    Run
                  </button>
                )}
              </div>
            </div>

            <div className="mt-5 flex gap-1 border-b border-neutral-800">
              <TabButton
                active={view.tab !== "settings"}
                onClick={() => setView({ kind: "detail", id: detailAgent.id })}
              >
                Overview
              </TabButton>
              <TabButton
                active={view.tab === "settings"}
                onClick={() => setView({ kind: "detail", id: detailAgent.id, tab: "settings" })}
              >
                Settings
              </TabButton>
            </div>

            {view.tab === "settings" ? (
              <div className="mt-5">
                <AgentEditor
                  key={`settings-${detailAgent.id}`}
                  agent={detailAgent}
                  spaces={spaces}
                  hookBase={hookBase}
                  onSaved={() => {
                    dirtyRef.current = false;
                    setEditDirty(false);
                    refresh();
                    setView({ kind: "detail", id: detailAgent.id });
                  }}
                  onDeleted={() => {
                    dirtyRef.current = false;
                    setEditDirty(false);
                    refresh();
                    setView({ kind: "home" });
                  }}
                  onCancel={() => setView({ kind: "detail", id: detailAgent.id })}
                  onDirtyChange={(d) => {
                    dirtyRef.current = d;
                    setEditDirty(d);
                  }}
                />
              </div>
            ) : (
              <div className="mt-5 grid gap-8 lg:grid-cols-[minmax(0,44rem)_20rem] xl:grid-cols-[minmax(0,44rem)_26rem]">
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

              {detailAgent.trigger === "webhook" && (
                <aside className="lg:border-l lg:border-neutral-800 lg:pl-6">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                    Recent webhook deliveries
                  </h3>
                  <div className="mt-2 space-y-2">
                    {deliveries.length > 0 ? (
                      <DeliveryList deliveries={deliveries} limit={10} />
                    ) : (
                      <p className="text-sm text-neutral-600">Nothing yet.</p>
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
                  </div>
                </aside>
              )}
              </div>
            )}
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

        {view.kind === "space" && !spaceKnown && (
          <div className="m-auto text-center text-sm text-neutral-600">
            <p>There is no space called &ldquo;{view.name}&rdquo;.</p>
            <button onClick={() => setView({ kind: "home" })} className="mt-2 text-neutral-400 hover:text-neutral-100">
              Back home
            </button>
          </div>
        )}

        {view.kind === "space" && spaceKnown && (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {spaceHeading}
            {spaceTabs(true)}

            <div className="mt-5 grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="min-w-0 space-y-8">
                <RailSection title="Name">
                  {view.name === DEFAULT_SPACE ? (
                    <>
                      <input
                        readOnly
                        value={view.name}
                        className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-500 outline-none"
                      />
                      <p className="text-xs leading-relaxed text-neutral-600">
                        Agents land here when no space is chosen, and when their space is removed, so
                        this one can&rsquo;t be renamed or removed.
                      </p>
                    </>
                  ) : (
                    <>
                      <input
                        className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm outline-none focus:border-neutral-600"
                        value={spaceDraft}
                        onChange={(e) => setSpaceDraft(e.target.value)}
                      />
                      <p className="text-xs text-neutral-600">
                        Renaming moves every agent in the space and keeps the shared webhook URL, secret
                        and environment.
                      </p>
                    </>
                  )}
                </RailSection>

                <RailSection title="Environment">
                  {spaceEnvMap === null ? null : (
                    <>
                      <EnvEditor
                        key={`${view.name}-${Object.keys(spaceEnvMap).join("|")}`}
                        value={spaceEnvMap}
                        onChange={setSpaceEnvMap}
                        inherited={[{ from: "global", keys: Object.keys(globalEnvMap ?? {}) }]}
                      />
                      <p className="text-xs leading-relaxed text-neutral-600">
                        Every agent in this space gets these, under its own. Values are stored once
                        and never shown again — a saved field is blank until you type a replacement.
                      </p>
                    </>
                  )}
                </RailSection>

                <div className="flex items-center gap-2 border-t border-neutral-800 pt-4">
                  <button
                    onClick={() => void saveSpace(view.name)}
                    disabled={!spaceDirty}
                    className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setView({ kind: "home" })}
                    className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-900"
                  >
                    Cancel
                  </button>
                  {spaceError && <span className="text-xs text-red-400">{spaceError}</span>}
                </div>
              </div>

              <div className="min-w-0 space-y-8">
                <RailSection title="Shared webhook">
                  <span className="block text-xs font-medium uppercase tracking-wide text-neutral-500">URL</span>
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={spaceHookUrl}
                      className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-400 outline-none"
                    />
                    <button
                      onClick={() => void navigator.clipboard.writeText(spaceHookUrl)}
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
                    used here. It is shown once, when generated, and takes effect immediately.
                  </p>
                </RailSection>

                {view.name !== DEFAULT_SPACE && (
                  <RailSection title="Remove this space">
                    <button
                      onClick={() => {
                        const n = agents.filter((a) => a.space === view.name).length;
                        if (confirm(`Remove "${view.name}" and move its ${n} agent(s) to ${DEFAULT_SPACE}?`)) {
                          void removeSpace(view.name);
                        }
                      }}
                      className="rounded border border-red-900 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950"
                    >
                      Move agents to {DEFAULT_SPACE} and remove
                    </button>
                    <p className="text-xs text-neutral-600">
                      The agents keep working from {DEFAULT_SPACE}. This space&rsquo;s shared secret and
                      environment are discarded, so its webhook URL stops answering.
                    </p>
                  </RailSection>
                )}
              </div>
            </div>
          </div>
        )}

        {view.kind === "settings" && (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <h2 className="text-lg font-semibold">Settings</h2>
            <p className="mt-1 text-xs text-neutral-500">
              What this bullpen needs regardless of agent or space.
            </p>

            <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="min-w-0 space-y-8">
                <RailSection title="Global environment">
                  {globalEnvMap === null ? null : (
                    <>
                      <EnvEditor
                        key={Object.keys(globalEnvMap).join("|")}
                        value={globalEnvMap}
                        onChange={setGlobalEnvMap}
                      />
                      <div className="flex items-center gap-3">
                        <button
                          onClick={async () => {
                            const r = await api.setGlobalEnv(globalEnvMap, Object.keys(globalEnvMap).length === 0);
                            setGlobalEnvMap(r.env);
                            setEnvSaved("Saved.");
                            setTimeout(() => setEnvSaved(null), 2000);
                          }}
                          className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white"
                        >
                          Save environment
                        </button>
                        {envSaved && <span className="text-xs text-emerald-500">{envSaved}</span>}
                      </div>
                      <p className="text-xs leading-relaxed text-neutral-600">
                        Every agent inherits these, under its space&rsquo;s and its own. The
                        server&rsquo;s own GitHub calls use <code>GITHUB_TOKEN</code> from here when
                        the process has none, so on a headless box <code>.env</code> only needs the
                        Claude token. Values are stored once and never shown again.
                      </p>
                    </>
                  )}
                </RailSection>

                <RailSection title="Process environment">
                  {processEnvNames === null ? null : (
                    <>
                      <p className="text-xs leading-relaxed text-neutral-600">
                        {processEnvNames.length} variables the server was started with — from the
                        shell, <code>.env</code>, or the container. Names only. This is the lowest
                        layer: anything set in bullpen overrides a name here.
                      </p>
                      {(() => {
                        const overridden = new Set(Object.keys(globalEnvMap ?? {}));
                        const shown = showAllProcessEnv
                          ? processEnvNames
                          : processEnvNames.filter((n) => overridden.has(n) || INTERESTING_ENV.test(n));
                        return (
                          <>
                            <div className="flex flex-wrap gap-1">
                              {shown.map((n) => (
                                <span
                                  key={n}
                                  title={overridden.has(n) ? "Also set in global env, which wins" : undefined}
                                  className={`rounded border px-1.5 py-px font-mono text-[11px] ${
                                    overridden.has(n)
                                      ? "border-amber-900 text-amber-400 line-through decoration-amber-700"
                                      : "border-neutral-800 text-neutral-400"
                                  }`}
                                >
                                  {n}
                                </span>
                              ))}
                              {shown.length === 0 && (
                                <span className="text-xs text-neutral-600">Nothing that looks relevant.</span>
                              )}
                            </div>
                            <button
                              onClick={() => setShowAllProcessEnv((v) => !v)}
                              className="text-xs text-neutral-500 hover:text-neutral-300"
                            >
                              {showAllProcessEnv
                                ? "Show only the relevant ones"
                                : `Show all ${processEnvNames.length}`}
                            </button>
                          </>
                        );
                      })()}
                    </>
                  )}
                </RailSection>
              </div>

              <div className="min-w-0 space-y-8">
                <RailSection title="This bullpen">
                  <RailRow label="Data directory" value={health?.dataDir ?? "…"} />
                  <RailRow label="Claude credential" value={health?.claudeCredential.source ?? "…"} />
                  {health && (
                    <p className="text-xs leading-relaxed text-neutral-600">{health.claudeCredential.detail}</p>
                  )}
                </RailSection>

                <RailSection title="Skills">
                  {skillsInfo && (
                    <>
                      <RailRow label="Directory" value={skillsInfo.dirDisplay} />
                      <RailRow label="Installed" value={`${skillsInfo.count} skill${skillsInfo.count === 1 ? "" : "s"}`} />
                      {skillsInfo.remote && (
                        <>
                          <RailRow
                            label="From"
                            value={`${skillsInfo.remote}${skillsInfo.subdir && skillsInfo.subdir !== "." ? ` · ${skillsInfo.subdir}` : ""}`}
                          />
                          <RailRow
                            label="Last pulled"
                            value={
                              skillsInfo.lastPulledAt === null ? (
                                "never"
                              ) : (
                                <span title={new Date(skillsInfo.lastPulledAt * 1000).toLocaleString()}>
                                  {ago(skillsInfo.lastPulledAt)}
                                </span>
                              )
                            }
                          />
                        </>
                      )}
                      {skillList.length > 0 && (
                        <ul className="space-y-0.5 pt-1">
                          {skillList.map((s) => (
                            <li key={s.name} className="flex items-baseline gap-2 text-xs">
                              <span className="shrink-0 font-mono text-neutral-200">/{s.name}</span>
                              <span className="min-w-0 truncate text-neutral-500" title={s.description}>
                                {s.description}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {skillsInfo.remote && (
                        <div className="space-y-2 pt-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              disabled={skillsPulling}
                              onClick={async () => {
                                setSkillsPulling(true);
                                setSkillsNote(null);
                                try {
                                  setSkillsInfo(await api.skillsPull());
                                  setSkillsNote("Pulled.");
                                } catch (e) {
                                  setSkillsNote(String((e as Error).message));
                                } finally {
                                  setSkillsPulling(false);
                                }
                              }}
                              className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-900 disabled:opacity-40"
                            >
                              {skillsPulling ? "Pulling…" : "Pull now"}
                            </button>
                            {skillsNote && <span className="text-xs text-neutral-400">{skillsNote}</span>}
                          </div>
                          {skillsInfo.managed && (
                            <label className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                              Then pull again automatically
                              <select
                                value={skillsInfo.refreshHours}
                                onChange={async (e) => {
                                  const hours = Number(e.target.value);
                                  const previous = skillsInfo.refreshHours;
                                  setSkillsInfo({ ...skillsInfo, refreshHours: hours });
                                  setSkillsNote(null);
                                  try {
                                    await api.setSkillsRefresh(hours);
                                  } catch (err) {
                                    setSkillsInfo({ ...skillsInfo, refreshHours: previous });
                                    setSkillsNote(String((err as Error).message));
                                  }
                                }}
                                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
                              >
                                <option value={0}>never</option>
                                <option value={6}>every 6 hours</option>
                                <option value={12}>every 12 hours</option>
                                <option value={24}>every day</option>
                                <option value={168}>every week</option>
                              </select>
                            </label>
                          )}
                        </div>
                      )}
                      {skillsInfo.managed ? (
                        <>
                          {!skillsInfo.remote && skillsNote && (
                            <span className="text-xs text-neutral-400">{skillsNote}</span>
                          )}
                          <p className="text-xs leading-relaxed text-neutral-600">
                            This directory is bullpen&rsquo;s to manage (<code>CLAUDE_CONFIG_DIR</code> is
                            set), and it is pulled on every boot and on the schedule above. To point it at a
                            different repo:
                          </p>
                          <input
                            className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs outline-none placeholder:text-neutral-700 focus:border-neutral-600"
                            placeholder="https://github.com/you/dotfiles"
                            value={skillsSource.url}
                            onChange={(e) => setSkillsSource({ ...skillsSource, url: e.target.value })}
                          />
                          <input
                            className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs outline-none placeholder:text-neutral-700 focus:border-neutral-600"
                            placeholder="path inside the repo — blank to detect"
                            value={skillsSource.path}
                            onChange={(e) => setSkillsSource({ ...skillsSource, path: e.target.value })}
                          />
                          <button
                            disabled={!skillsSource.url.trim()}
                            onClick={async () => {
                              if (skillsInfo.count > 0 && !confirm(`Replace the ${skillsInfo.count} installed skills with this repo's?`)) return;
                              try {
                                const r = await api.skillsClone(skillsSource.url.trim(), skillsSource.path.trim() || undefined);
                                setSkillsInfo(await api.skillsState());
                                setSkillsNote(`${r.count} skills installed.`);
                                setSkillsSource({ url: "", path: "" });
                              } catch (e) {
                                const c = (e as { candidates?: string[] }).candidates;
                                setSkillsNote(
                                  c?.length ? `Skills found in: ${c.join(", ")} — put one in the path field.` : String((e as Error).message),
                                );
                              }
                            }}
                            className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-900 disabled:opacity-40"
                          >
                            {skillsInfo.count > 0 ? "Replace skills" : "Clone skills"}
                          </button>
                        </>
                      ) : (
                        <p className="text-xs leading-relaxed text-neutral-600">
                          Bullpen reads these but doesn&rsquo;t manage them — this is your own
                          <code> ~/.claude</code>. Set <code>CLAUDE_CONFIG_DIR</code> (the container does)
                          to have bullpen own the directory, pull it on boot and daily after that, and let you
                          change its source here.
                        </p>
                      )}
                    </>
                  )}
                </RailSection>

                <RailSection title="MCP servers">
                  {machineMcp && (() => {
                    const writable = machineMcp.managed;
                    return (
                      <>
                        {machineMcp.global.length === 0 ? (
                          <p className="text-xs text-neutral-600">None. Agents that opt in with &ldquo;Use the shared MCP servers&rdquo; get what is listed here.</p>
                        ) : (
                          <ul className="space-y-1">
                            {machineMcp.global.map((s) => (
                              <li key={s.name} className="flex flex-wrap items-baseline gap-2 text-xs">
                                <McpHealthBadge h={machineMcp.health[s.name]} />
                                <span className="shrink-0 font-mono text-neutral-200">{s.name}</span>
                                <span className="shrink-0 text-neutral-600">{s.transport}</span>
                                {/* flex-1 gives it a zero hypothetical width, so the row never wraps for it — it truncates. */}
                                <span className="min-w-0 flex-1 truncate font-mono text-neutral-500" title={s.detail}>{s.detail}</span>
                                {s.secretKeys.length > 0 && (
                                  <span className="shrink-0 text-neutral-600" title={s.secretKeys.join(", ")}>{s.secretKeys.length} secret{s.secretKeys.length === 1 ? "" : "s"}</span>
                                )}
                                {(s.transport === "http" || s.transport === "sse") && (
                                  <span className={writable ? "" : "ml-auto"}>
                                    <McpAuth name={s.name} onDone={() => void api.machineMcp().then(setMachineMcp)} />
                                  </span>
                                )}
                                {writable && (
                                  <button
                                    onClick={async () => {
                                      if (!confirm(`Remove ${s.name} from every run?`)) return;
                                      try { setMachineMcp(await api.removeMachineMcp(s.name)); } catch (e) { setMcpNote(String((e as Error).message)); }
                                    }}
                                    className="ml-auto shrink-0 text-neutral-600 hover:text-red-400"
                                    title="Remove"
                                  >
                                    &times;
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                        {writable && mcpCatalogEntries?.some((e) => !e.installed && !e.unavailable) && (
                          <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                            <span>Suggested:</span>
                            {mcpCatalogEntries.filter((e) => !e.installed && !e.unavailable).map((e) => (
                              <button
                                key={e.key}
                                title={e.description}
                                onClick={async () => {
                                  const installed = mcpCatalogEntries.filter((x) => x.installed).map((x) => x.key);
                                  const r = await api.applyMcpCatalog([...installed, e.key]);
                                  setMcpCatalogEntries(r.entries);
                                  setMachineMcp(await api.machineMcp());
                                }}
                                className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:bg-neutral-900"
                              >
                                + {e.name.split(" — ")[0]}
                              </button>
                            ))}
                          </div>
                        )}
                        {writable ? (
                          <McpServerForm onAdd={async (n, cfg) => { setMachineMcp(await api.addMachineMcp(n, cfg)); }} />
                        ) : (
                          <p className="text-xs leading-relaxed text-neutral-600">
                            Loaded from your own <code>~/.claude.json</code> (user scope) and shown here so you can see what
                            agents inherit; bullpen never changes it. Manage with{" "}
                            <code>claude mcp add --scope user &hellip;</code>.
                          </p>
                        )}
                        {machineMcp.connectors.length === 0 && (
                          <p className="pt-1 text-xs text-neutral-600">
                            claude.ai connectors (Gmail, Slack, &hellip;) come with the login &mdash; nothing to
                            configure here. {machineMcp.managed
                              ? "There is no record of them in this config; whether a run gets them shows in that run\u2019s MCP status, for agents with \u201cUse the shared MCP servers\u201d on."
                              : "None have been connected from Claude Code on this machine yet."}
                          </p>
                        )}
                        {machineMcp.connectors.length > 0 && (
                          <div className="pt-1">
                            <p className="text-xs text-neutral-500">
                              claude.ai connectors &mdash; come with the login, nothing to configure here:
                            </p>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {machineMcp.connectors.map((n) => (
                                <span key={n} className="inline-flex items-center gap-1.5 rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400">
                                  <McpHealthBadge h={machineMcp.health[n]} compact />
                                  {n}
                                  {machineMcp.health[n]?.status === "needs-auth" && (
                                    <McpAuth name={n} onDone={() => void api.machineMcp().then(setMachineMcp)} />
                                  )}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {mcpNote && <p className="text-xs text-red-400">{mcpNote}</p>}
                        <p className="text-xs leading-relaxed text-neutral-600">
                          The dot is what the most recent run that reached each server reported
                          &mdash; connected, needs auth, or failed; none means no run has tried it yet.{" "}
                          {machineMcp.managed
                            ? "This config is bullpen\u2019s (CLAUDE_CONFIG_DIR is set), so it can be edited here. "
                            : ""}
                          Every agent with &ldquo;Use the shared MCP servers&rdquo; checked gets all of these
                          &mdash; a server&rsquo;s credentials go to each of them.
                        </p>
                      </>
                    );
                  })()}
                </RailSection>

                <RailSection title="Instructions every agent receives">
                  <p className="text-xs leading-relaxed text-neutral-600">
                    Two things reach an agent before its own prompt does. Claude Code&rsquo;s built-in system
                    prompt comes first; then these.
                  </p>

                  <button onClick={() => setShowSystemPrompt((v) => !v)} className="block text-left text-xs text-neutral-300 hover:text-white">
                    {showSystemPrompt ? "\u25be" : "\u25b8"} Bullpen&rsquo;s note &mdash; every run
                  </button>
                  <p className="-mt-1 pl-4 text-xs leading-relaxed text-neutral-600">
                    Appended to the system prompt of every run, unconditionally. It is not part of
                    CLAUDE.md and cannot be turned off: it is how the dashboard&rsquo;s files and webhook
                    payloads work. Read-only.
                  </p>
                  {showSystemPrompt && systemPrompt && (
                    <div className="space-y-2 pl-4">
                      <span className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">Every run</span>
                      <pre className="whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-sans text-xs leading-relaxed text-neutral-400">{systemPrompt.files}</pre>
                      {systemPrompt.config && (
                        <>
                          <span className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">Every run, because this box&rsquo;s config dir is not ~/.claude</span>
                          <pre className="whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-sans text-xs leading-relaxed text-neutral-400">{systemPrompt.config}</pre>
                        </>
                      )}
                      <span className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">Webhook and poll runs, additionally</span>
                      <pre className="whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950 px-3 py-2 font-sans text-xs leading-relaxed text-neutral-400">{systemPrompt.delivery}</pre>
                    </div>
                  )}

                  <button onClick={() => setShowClaudeMd((v) => !v)} className="block pt-1 text-left text-xs text-neutral-300 hover:text-white">
                    {showClaudeMd ? "\u25be" : "\u25b8"} Global CLAUDE.md &mdash; agents that opt in
                  </button>
                  <p className="-mt-1 pl-4 text-xs leading-relaxed text-neutral-600">
                    Your own standing instructions, the file Claude Code reads from its config directory.
                    Loaded only for agents with &ldquo;Use the shared skills and global CLAUDE.md&rdquo;
                    checked, together with that directory&rsquo;s skills and settings.json.
                  </p>
                  {showClaudeMd && (
                    <div className="space-y-2 pl-4">
                  {claudeMd && (
                    <>
                      <RailRow label="File" value={claudeMd.path} />
                      <RailRow
                        label="Status"
                        value={claudeMd.exists ? `${(claudeMd.size / 1024).toFixed(1)} KB` : "not present"}
                      />
                      <textarea
                        className="h-40 w-full resize-y rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs leading-relaxed text-neutral-300 outline-none focus:border-neutral-600 read-only:text-neutral-500"
                        value={claudeMdDraft}
                        readOnly={!claudeMd.managed}
                        spellCheck={false}
                        placeholder={claudeMd.managed ? "Standing instructions for agents that opt in." : ""}
                        onChange={(e) => setClaudeMdDraft(e.target.value)}
                      />
                      {claudeMd.managed ? (
                        <div className="flex items-center gap-3">
                          <button
                            disabled={claudeMdDraft === claudeMd.content}
                            onClick={async () => {
                              try {
                                const m = await api.setClaudeMd(claudeMdDraft);
                                setClaudeMd(m);
                                setClaudeMdNote("Saved.");
                              } catch (e) {
                                setClaudeMdNote(String((e as Error).message));
                              }
                              setTimeout(() => setClaudeMdNote(null), 2500);
                            }}
                            className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
                          >
                            Save
                          </button>
                          {claudeMdNote && <span className="text-xs text-neutral-400">{claudeMdNote}</span>}
                        </div>
                      ) : null}
                      <p className="text-xs leading-relaxed text-neutral-600">
                        {claudeMd.managed
                          ? "This directory is bullpen\u2019s, so the file can be edited here."
                          : "This is your own file; edit it on this machine."}
                      </p>
                    </>
                  )}
                    </div>
                  )}
                </RailSection>

                <RailSection title="Export / import">
                  <input
                    className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs outline-none placeholder:text-neutral-700 focus:border-neutral-600"
                    type="password"
                    autoComplete="off"
                    placeholder="passphrase — leave blank to export without secrets"
                    value={exportPassphrase}
                    onChange={(e) => setExportPassphrase(e.target.value)}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={async () => {
                        const pass = exportPassphrase.trim();
                        const data = await api.exportAgents(pass || undefined);
                        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(blob);
                        a.download = `bullpen-agents-${new Date().toISOString().slice(0, 10)}-${pass ? "with-secrets-encrypted" : "no-secrets"}.json`;
                        a.click();
                        URL.revokeObjectURL(a.href);
                        setExportPassphrase("");
                      }}
                      className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-900"
                    >
                      {exportPassphrase.trim() ? "Export with secrets (encrypted)" : "Export without secrets"}
                    </button>
                    <label className="cursor-pointer rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-900">
                      Import…
                      <input
                        type="file"
                        accept="application/json,.json"
                        className="hidden"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          try {
                            const payload = JSON.parse(await f.text()) as Record<string, unknown>;
                            let pass: string | undefined;
                            if (payload.secrets) {
                              pass = window.prompt("This file includes secrets. Passphrase to open them (cancel to import without):") ?? undefined;
                            }
                            const r = await api.importAgents(payload, pass?.trim() || undefined);
                            const needs = Object.entries(r.envNeeded);
                            setImportResult(
                              `${r.created.length} created, ${r.updated.length} updated` +
                                (r.errors.length ? `, ${r.errors.length} rejected` : "") +
                                (r.secretsApplied
                                  ? `. Secrets restored for ${r.secretsApplied.agents} agents, ${r.secretsApplied.spaces} spaces, ${r.secretsApplied.globalKeys} global keys` +
                                    (r.secretsApplied.mcp ? `, ${r.secretsApplied.mcp} MCP servers` : "")
                                  : "") +
                                (r.secretsNote ? `. ${r.secretsNote}` : "") +
                                (r.mcpNote ? `. ${r.mcpNote}` : "") +
                                (needs.length
                                  ? `. Set env for: ${needs.map(([n, k]) => `${n} (${k.join(", ")})`).join("; ")}`
                                  : "."),
                            );
                            refresh();
                          } catch (err) {
                            setImportResult(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
                          }
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                  {importResult && <p className="text-xs text-neutral-300">{importResult}</p>}
                  <p className="text-xs leading-relaxed text-neutral-600">
                    Every agent as JSON — prompts, triggers, filters, workspace, permissions. Without
                    a passphrase, secrets are left out: env keeps its keys but not its values, and
                    webhook secrets are minted fresh on import. With one, every secret — agent env,
                    webhook and space secrets, hook ids, global env — is included, encrypted with
                    that passphrase, so the shared webhook URLs survive a move to another box. Ids
                    are kept, so importing over an existing bullpen updates in place.
                  </p>
                </RailSection>


              </div>
            </div>
          </div>
        )}

        {view.kind === "home" && (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {spaceHeading}
            {spaceTabs(false)}

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

            <div
              className={
                quiet
                  ? "mt-8 max-w-3xl"
                  : "mt-8 grid gap-8 lg:grid-cols-[minmax(0,48rem)_18rem]"
              }
            >
              <div className="min-w-0 space-y-8">
              <HomeSection title="Recent activity">
                {scopedRuns.length === 0 ? (
                  <p className="text-sm text-neutral-600">Nothing has run yet.</p>
                ) : (
                  scopedRuns.slice(0, deliveriesSpaceHasWebhooks ? 8 : 15).map((r) => (
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

              {deliveriesSpaceHasWebhooks && (
                <HomeSection
                  title="Recent webhook deliveries"
                  hint="What arrived at this space's shared webhook URL, and which agents it reached."
                >
                  {spaceDeliveries.length === 0 ? (
                    <p className="text-sm text-neutral-600">Nothing has arrived yet.</p>
                  ) : (
                    <GroupedDeliveryList
                      deliveries={spaceDeliveries}
                      limit={10}
                      agentName={agentName}
                      onOpenRun={(id) => setView({ kind: "run", id })}
                      onOpenAgent={(id) => setView({ kind: "detail", id })}
                    />
                  )}
                </HomeSection>
              )}
              </div>

              {!quiet && (
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
              )}
            </div>
          </div>
        )}

        {view.kind === "run" && !run && runMissing && (
          <div className="m-auto text-center text-sm text-neutral-600">
            <p>That run no longer exists.</p>
            <button onClick={() => setView({ kind: "home" })} className="mt-2 text-neutral-400 hover:text-neutral-100">
              Back home
            </button>
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
              {run.status === "queued" && (
                <span className="text-xs text-neutral-500">starts when the current run ends</span>
              )}
              {took(run) && <span className="text-xs text-neutral-500">{took(run)}</span>}
              {metered && run.costUsd != null && run.costUsd > 0 && (
                <span className="text-xs text-neutral-500">${(run.costUsd / 1_000_000).toFixed(2)}</span>
              )}
              <span
                className="text-xs tabular-nums text-neutral-500"
                title={new Date(run.startedAt * 1000).toLocaleString()}
              >
                {ago(run.startedAt)}
              </span>
              <span className="ml-auto flex items-center gap-2">
              {isQueued && (
                <button
                  onClick={() => api.stop(run.id).then(() => setView({ kind: "detail", id: run.agentId }))}
                  className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-900"
                >
                  Cancel
                </button>
              )}
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
                    className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
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
                  {isLive ? (
                    <button
                      onClick={() => api.stop(run.id)}
                      className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950"
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      onClick={() => api.stop(run.id)}
                      title="End the session. The run is finished; this only removes the ability to reply to it."
                      className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-900"
                    >
                      Close
                    </button>
                  )}
                </>
              )}
                <a
                  href={`/api/runs/${run.id}/export`}
                  download
                  title="Save this run as a text transcript"
                  className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-900"
                >
                  Export
                </a>
              </span>
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
              <Timeline events={events} partial={partial} meteredBilling={metered} runId={run.id} />
              {approvals.length > 0 && (
                <div className="mt-3 space-y-2">
                  {approvals.map((a) => (
                    <ApprovalCard key={a.id} approval={a} onDecided={() => {}} />
                  ))}
                </div>
              )}
              <ArtifactsPanel runId={run.id} status={run.status} />
              {run.branch && <GitPanel runId={run.id} />}
            </div>
          </>
        )}

        {((view.kind === "detail" && view.tab !== "settings" && selectedAgentId) ||
          (view.kind === "run" && canReply)) && (
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
