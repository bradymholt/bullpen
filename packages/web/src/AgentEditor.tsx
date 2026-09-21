import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { EnvEditor } from "./EnvEditor.tsx";
import { MODES } from "./modes.ts";
import { ListInput, randomSecret, TriggerSettings } from "./TriggerSettings.tsx";
import { DEFAULT_SPACE, type Agent, type AgentInput, type MachineMcp, type Repo, type RepoList, type Skill, type WorkspaceConfig } from "./types.ts";

const MODELS = [
  ["opus", "Opus — alias, tracks the current Opus"],
  ["sonnet", "Sonnet — alias, cheaper and faster"],
  ["haiku", "Haiku — alias, cheapest"],
  ["claude-opus-5", "claude-opus-5"],
  ["claude-sonnet-5", "claude-sonnet-5"],
  ["claude-haiku-4-5", "claude-haiku-4-5"],
  ["claude-fable-5-1", "claude-fable-5-1 — most capable, priced above Opus"],
] as const;

const field =
  "w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm outline-none placeholder:text-neutral-700 focus:border-neutral-600";
const label = "block text-xs font-medium uppercase tracking-wide text-neutral-500 mb-1";

/** Kept in step with the server's ASK_TOOL; a question holds the run until answered. */
const ASK_TOOL = "AskUserQuestion";

/** Last connection state a run reported for a server. */
function McpHealthDot({ status }: { status: string }) {
  const tone =
    status === "connected" ? "bg-emerald-500" : status === "needs-auth" ? "bg-amber-500" : status === "pending" ? "bg-neutral-500" : "bg-red-500";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${tone}`} title={status} />;
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <span className={label}>{title}</span>
      {children}
      {hint && <p className="mt-1 text-xs text-neutral-600">{hint}</p>}
    </div>
  );
}

/**
 * A copy is a new agent that happens to start filled in: its own id and webhook
 * secret, and no env — the API masks secret values, so copying them across would
 * store bullets. Asana issues its own secret during the handshake, so leave it
 * unset there rather than minting one the handshake would then refuse.
 */
function copyOf(source: Agent): AgentInput {
  const { workspaceKind, pollState, pollStatus, pollCheckedAt, ...rest } = source;
  return {
    ...rest,
    id: crypto.randomUUID(),
    name: `${source.name} copy`,
    env: {},
    ...(source.webhookMode === "asana" ? {} : { webhookSecret: randomSecret() }),
  };
}

export function AgentEditor({
  agent,
  seed = null,
  spaces = [],
  defaultSpace = null,
  hookBase = location.origin,
  onSaved,
  onDeleted,
  onCancel,
  onBack,
  backLabel,
  onDirtyChange,
}: {
  agent: Agent | null;
  /** Fills a new agent in from an existing one, leaving the original alone. */
  seed?: Agent | null;
  /** Spaces already in use, offered as suggestions. */
  spaces?: string[];
  /** A new agent lands in the space the roster is filtered to. */
  defaultSpace?: string | null;
  /** Base for the webhook URLs shown; the server's public base when it has one. */
  hookBase?: string;
  onSaved: (a: Agent) => void;
  onDeleted: () => void;
  onCancel: () => void;
  /** Where the breadcrumb goes: the agent's own page, or the space it lives in. */
  onBack: () => void;
  backLabel: string;
  /** Fires as the draft diverges from what was loaded, so the shell can guard navigation. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<AgentInput>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [machineMcp, setMachineMcp] = useState<MachineMcp | null>(null);
  const [repoList, setRepoList] = useState<RepoList | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [sharedSkills, setSharedSkills] = useState<Skill[]>([]);
  const [claudeMdInfo, setClaudeMdInfo] = useState<{ exists: boolean; size: number } | null>(null);
  const [preapproved, setPreapproved] = useState<{ count: number; bare: string[] } | null>(null);
  useEffect(() => {
    void api.skills().then(setSharedSkills).catch(() => setSharedSkills([]));
    void api.skillsState().then((s) => setPreapproved(s.preapproved)).catch(() => setPreapproved(null));
    void api.claudeMd().then((m) => setClaudeMdInfo({ exists: m.exists, size: m.size })).catch(() => setClaudeMdInfo({ exists: false, size: 0 }));
  }, []);

  useEffect(() => {
    void api.machineMcp().then(setMachineMcp).catch(() => setMachineMcp(null));
    void api
      .repos()
      .then(setRepoList)
      .catch((e) => setRepoError(String(e)));
  }, []);

  const loadedRef = useRef<string>("");
  useEffect(() => {
    setError(null);
    const seeded: AgentInput =
      agent ??
        (seed
          ? copyOf(seed)
          : {
              id: crypto.randomUUID(),
              space: defaultSpace ?? DEFAULT_SPACE,
              webhookSecret: randomSecret(),
              name: "",
              prompt: "",
              permissionMode: "auto",
              workspaceConfig: { kind: "ephemeral" },
              concurrency: "allow",
              trigger: "manual",
              env: {},
              allowedTools: [],
              disallowedTools: [ASK_TOOL],
              inheritMachineMcp: false,
              sharedMcpPick: null,
              inheritUserSettings: true,
            });
    loadedRef.current = JSON.stringify(seeded);
    setDraft(seeded);
  }, [agent?.id, seed?.id]);

  // Which keys wider scopes provide, so the editor can say what this agent inherits.
  const [inheritedEnv, setInheritedEnv] = useState<{ from: string; keys: string[] }[]>([]);
  useEffect(() => {
    const space = draft.space;
    void Promise.all([
      api.globalEnv().then((r) => Object.keys(r.env)).catch(() => []),
      space ? api.spaceEnv(space).then((r) => Object.keys(r.env)).catch(() => []) : Promise.resolve([]),
    ]).then(([g, s]) =>
      setInheritedEnv([{ from: "global", keys: g }, ...(space ? [{ from: `the ${space} space`, keys: s }] : [])]),
    );
  }, [draft.space]);

  const dirty = loadedRef.current !== "" && JSON.stringify(draft) !== loadedRef.current;
  useEffect(() => onDirtyChange?.(dirty), [dirty]);
  // In-app navigation is guarded by the shell; this covers the tab itself.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  const set = <K extends keyof AgentInput>(k: K, v: AgentInput[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const ws = (draft.workspaceConfig ?? { kind: "scratch" }) as WorkspaceConfig;
  // The default space is always on offer; so is one the roster doesn't know
  // yet — a seeded draft, or one being typed.
  const spaceOptions = [...new Set([DEFAULT_SPACE, ...spaces, ...(draft.space ? [draft.space] : [])])].sort();
  // Old records still say persistent/git; show them as the option they mean.
  const wsKind = ws.kind === "persistent" ? "scratch" : ws.kind === "git" ? "clone" : ws.kind;
  const repo = ws as { repoUrl?: string; baseBranch?: string };
  const known = (repoList?.repos ?? []).some((r) => r.cloneUrl === repo.repoUrl);
  // The viewer's own repos first, then organisations alphabetically.
  const repoGroups = Object.entries(
    (repoList?.repos ?? []).reduce<Record<string, Repo[]>>((acc, r) => {
      (acc[r.owner] ??= []).push(r);
      return acc;
    }, {}),
  ).sort(([a], [b]) =>
    a === repoList?.viewer ? -1 : b === repoList?.viewer ? 1 : a.localeCompare(b),
  );
  const knownModel = !draft.model || MODELS.some(([v]) => v === draft.model);
  const mode = draft.permissionMode ?? "auto";
  const canAsk = !(draft.disallowedTools ?? []).includes(ASK_TOOL);
  // `auto` and `full` never prompt, so a permission rule changes nothing there.
  const toolRulesApply = mode !== "auto" && mode !== "full";
  const droppedEnv = seed ? Object.keys(seed.env) : [];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // A condition row left half-filled is a stray click, not a rule.
      const filters = (draft.filters ?? [])
        .map((f) => ({ ...f, path: f.path.trim(), values: f.values.map((v) => v.trim()).filter(Boolean) }))
        .filter((f) => f.path && f.values.length > 0);
      const payload = draft.filters ? { ...draft, filters } : draft;
      const saved = agent
        ? await api.updateAgent(agent.id, payload)
        : await api.createAgent(payload);
      loadedRef.current = JSON.stringify(draft);
      onDirtyChange?.(false);
      onSaved(saved);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 px-6 py-5">
      <div>
        <button onClick={onBack} className="text-xs text-neutral-500 hover:text-neutral-300">
          &larr; {backLabel}
        </button>
        <h2 className="mt-2 text-lg font-semibold">
          {agent ? "Agent settings" : seed ? `Copy of ${seed.name}` : "New agent"}
        </h2>
      </div>
      {droppedEnv.length > 0 && (
        <p className="text-xs text-amber-500/80">
          {droppedEnv.join(", ")} {droppedEnv.length === 1 ? "was" : "were"} not copied &mdash;
          secret values never leave the server.
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
      <div className="grid grid-cols-[1fr_12rem] gap-3">
        <Row title="Name">
          <input
            className={field}
            autoFocus={!agent}
            value={draft.name ?? ""}
            onChange={(e) => set("name", e.target.value)}
          />
        </Row>
        <Row title="Space" hint="Groups your agents.">
          {naming ? (
            <input
              className={field}
              autoFocus
              placeholder="work"
              value={draft.space ?? ""}
              onChange={(e) => set("space", e.target.value)}
              onBlur={() => {
                const trimmed = (draft.space ?? "").trim();
                set("space", trimmed || DEFAULT_SPACE);
                if (!trimmed) setNaming(false);
              }}
            />
          ) : (
            <select
              className={field}
              value={draft.space ?? DEFAULT_SPACE}
              onChange={(e) => {
                setNaming(e.target.value === "__new__");
                set("space", e.target.value === "__new__" ? "" : e.target.value);
              }}
            >
              {spaceOptions.map((sp) => (
                <option key={sp} value={sp}>
                  {sp}
                </option>
              ))}
              <option value="__new__">New space…</option>
            </select>
          )}
        </Row>
      </div>

      <TriggerSettings agent={agent} draft={draft} set={set} hookBase={hookBase} />

      <Row title="Workspace" hint="The directory each run works in — its cwd, and where the webhook payload is written.">
        <select
          className={field}
          value={wsKind}
          onChange={(e) => {
            const kind = e.target.value;
            set(
              "workspaceConfig",
              kind === "clone"
                ? { kind: "clone", repoUrl: "" }
                : kind === "existing"
                  ? { kind: "existing", path: "" }
                  : kind === "ephemeral"
                    ? { kind: "ephemeral" }
                    : { kind: "scratch" },
            );
          }}
        >
          <option value="ephemeral">Fresh directory — a new folder per run, deleted after</option>
          <option value="scratch">Scratch directory — one folder this agent reuses every run</option>
          <option value="existing">Existing directory — run in a checkout you already have</option>
          <option value="clone">Git clone — new clone and branch per run, discarded after</option>
        </select>
        <p className="mt-1 text-xs text-neutral-600">
          {wsKind === "scratch"
            ? "One directory per agent, reused by every run of it and shared with no other agent. Files left behind are still there next time, so an agent can keep notes, caches, or a checkout it manages itself."
            : wsKind === "ephemeral"
              ? "A new directory per run, removed when the run ends. Nothing carries over, which is what lets several runs of this agent work at once."
              : wsKind === "existing"
                ? "The agent works in your real checkout, on whatever branch is there."
                : "Isolated per run. Review the diff and open a PR from the run view."}
        </p>
      </Row>

      {wsKind === "existing" && (
        <>
          <Row title="Directory">
            <input
              className={field}
              placeholder="~/dev/my-project"
              value={(ws as { path?: string }).path ?? ""}
              onChange={(e) =>
                set("workspaceConfig", {
                  kind: "existing",
                  path: e.target.value,
                })
              }
            />
          </Row>
          <p className="-mt-2 text-xs text-amber-500/80">
            Edits land in your working tree immediately — uncommitted changes are real, and the
            agent shares this directory with whatever else you&rsquo;re doing in it. A CLAUDE.md
            above this path applies to the run.
          </p>
        </>
      )}

      {wsKind === "clone" && (
        <>
          <Row title="Repository">
            {repoList?.configured && (
              <select
                className={field}
                value={known ? repo.repoUrl : "__other__"}
                onChange={(e) =>
                  set("workspaceConfig", {
                    kind: "clone",
                    ...repo,
                    repoUrl: e.target.value === "__other__" ? "" : e.target.value,
                  })
                }
              >
                <option value="__other__">Another repository — paste a URL</option>
                {repoGroups.map(([owner, repos]) => (
                  <optgroup key={owner} label={owner}>
                    {repos.map((r) => (
                      <option key={r.cloneUrl} value={r.cloneUrl}>
                        {r.fullName}
                        {r.private ? " (private)" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
            {(!repoList?.configured || !known) && (
              <input
                className={`${field} ${repoList?.configured ? "mt-2" : ""}`}
                placeholder="https://github.com/you/repo.git"
                value={repo.repoUrl ?? ""}
                onChange={(e) =>
                  set("workspaceConfig", {
                    kind: "clone",
                    ...repo,
                    repoUrl: e.target.value,
                  })
                }
              />
            )}
            <p className="mt-1 text-xs text-neutral-600">
              {repoError
                ? `Couldn't reach GitHub: ${repoError}`
                : repoList?.configured
                  ? `${repoList.repos.length} repositories this GITHUB_TOKEN can reach, as ${repoList.viewer}. Anything public works by URL too.`
                  : "Set GITHUB_TOKEN to pick from your repositories. Public repos clone by URL without one."}
            </p>
          </Row>
          <Row title="Base branch">
            <input
              className={field}
              placeholder="main"
              value={repo.baseBranch ?? ""}
              onChange={(e) =>
                set("workspaceConfig", {
                  kind: "clone",
                  repoUrl: repo.repoUrl ?? "",
                  ...(e.target.value ? { baseBranch: e.target.value } : {}),
                })
              }
            />
          </Row>
        </>
      )}

      <Row title="Overlapping runs">
        <select
          className={field}
          value={draft.concurrency ?? "allow"}
          onChange={(e) => set("concurrency", e.target.value)}
        >
          <option value="allow">Allow — start it anyway, in parallel</option>
          <option value="queue">Queue — hold it and run one at a time, in order</option>
          <option value="skip">Skip — refuse a trigger while a run is active</option>
        </select>
        {(draft.concurrency ?? "allow") === "allow" &&
        (wsKind === "scratch" || wsKind === "existing") ? (
          <p className="mt-1 rounded border border-amber-900 bg-amber-950/40 px-2 py-1.5 text-xs leading-relaxed text-amber-300">
            Parallel runs share one directory and will overwrite each other&rsquo;s files, including
            the webhook payload. Two ways out: set <strong>Workspace</strong> above to{" "}
            <strong>Fresh directory</strong> if runs don&rsquo;t need what earlier runs left behind, or
            choose <strong>Queue</strong> here if they do &mdash; one run at a time keeps the shared
            directory safe.
          </p>
        ) : (
          <p className="mt-1 text-xs leading-relaxed text-neutral-600">
            {(draft.concurrency ?? "allow") === "skip"
              ? "A trigger that arrives mid-run is dropped for good — two webhooks in quick succession means the second is never handled. A run waiting on an approval counts as active. If every trigger must be handled, choose Queue instead."
              : (draft.concurrency ?? "allow") === "queue"
                ? wsKind === "scratch" || wsKind === "existing"
                  ? "A trigger that arrives mid-run waits and starts when the current run ends, oldest first — which is what keeps this shared directory safe. Up to 20 can wait; beyond that a trigger is dropped and shows as a refused delivery."
                  : "A trigger that arrives mid-run waits and starts when the current run ends, oldest first. With a fresh directory per run nothing is shared, so Allow would run these in parallel with no downside — Queue only makes sense here if the runs must not overlap for some other reason. Up to 20 can wait."
                : "Runs happen in parallel, each in its own directory."}
          </p>
        )}
      </Row>

        </div>

        {/* The prompt is the agent; give it a column rather than a slot in the form. */}
        <div className="min-w-0">
          <div className="space-y-4">
            <Row title="Prompt" hint="What this agent does every time you run it.">
              <textarea
                className={`${field} h-[32rem] resize-y font-mono text-xs leading-relaxed`}
                value={draft.prompt ?? ""}
                onChange={(e) => set("prompt", e.target.value)}
              />
            </Row>

      <Row
        title="Model"
        hint={
          knownModel
            ? "Aliases follow Anthropic's current model in that tier; a pinned id never moves."
            : "Any model string Claude Code accepts."
        }
      >
        <select
          className={field}
          value={knownModel ? (draft.model ?? "") : "__other__"}
          onChange={(e) =>
            set("model", e.target.value === "__other__" ? "" : e.target.value || null)
          }
        >
          <option value="">Default — whatever Claude Code picks</option>
          {MODELS.map(([v, desc]) => (
            <option key={v} value={v}>
              {desc}
            </option>
          ))}
          <option value="__other__">Another model — enter an id</option>
        </select>
        {!knownModel && (
          <input
            className={`${field} mt-2`}
            placeholder="claude-opus-4-8"
            value={draft.model ?? ""}
            onChange={(e) => set("model", e.target.value || null)}
          />
        )}
      </Row>

      <Row title="Permission mode">
        <select
          className={field}
          value={draft.permissionMode ?? "auto"}
          onChange={(e) => set("permissionMode", e.target.value)}
        >
          {MODES.map(([v, label, desc]) => (
            <option key={v} value={v}>
              {label} — {desc}
            </option>
          ))}
        </select>
      </Row>

      <div>
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={canAsk}
            onChange={(e) =>
              set(
                "disallowedTools",
                e.target.checked
                  ? (draft.disallowedTools ?? []).filter((t) => t !== ASK_TOOL)
                  : [...(draft.disallowedTools ?? []), ASK_TOOL],
              )
            }
          />
          Let this agent ask me questions
        </label>
        <p className="mt-1 text-xs text-neutral-600">
          {canAsk
            ? "It can stop mid-run to ask. Nobody answering holds the run for 15 minutes before the question is denied — and on a queue or skip agent, that blocks every trigger behind it."
            : "It must decide for itself or stop and explain, which is what an unattended run wants."}
        </p>
      </div>

      {/* Nothing to allow in a mode that never asks. */}
      {toolRulesApply && (
        <Row
          title="Allowed tools"
          hint={
            mode === "locked"
              ? "Comma separated, and the whole allowance — anything unlisted is denied. MCP wildcards need a real server name: mcp__linear__* works, mcp__* is ignored."
              : "Comma separated. Anything listed is auto-approved and never reaches the approval prompt, so prefer scoped rules like Bash(ls *). MCP wildcards need a real server name: mcp__linear__* works, mcp__* is ignored."
          }
        >
          <ListInput
            key={`tools-${agent?.id ?? "new"}`}
            placeholder="Read, Grep, mcp__linear__*"
            value={draft.allowedTools ?? []}
            onChange={(next) => set("allowedTools", next)}
          />
        </Row>
      )}

      <div className="space-y-2 border-t border-neutral-800 pt-4">
        <span className={label}>MCP servers</span>

        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={draft.inheritMachineMcp ?? true}
            onChange={(e) => set("inheritMachineMcp", e.target.checked)}
          />
          Use the shared MCP servers
        </label>
        <p className="-mt-1 text-xs text-neutral-600">
          The list is managed under Settings &rarr; MCP servers; this decides whether this agent gets
          any of it. Off means none &mdash; the safe choice for an agent that doesn&rsquo;t need a browser
          or Datadog, since a server&rsquo;s credentials go to every agent that can reach it.
        </p>

        {(draft.inheritMachineMcp ?? true) && machineMcp && (
          <div className="space-y-1.5 pl-5">
            <label className="flex items-start gap-2 text-sm text-neutral-300">
              <input
                type="radio"
                name="shared-mcp-pick"
                className="mt-1"
                checked={draft.sharedMcpPick == null}
                onChange={() => set("sharedMcpPick", null)}
              />
              <span>
                All of them
                <span className="block text-xs text-neutral-600">
                  {machineMcp.global.length} server{machineMcp.global.length === 1 ? "" : "s"}
                  {machineMcp.connectors.length > 0 ? `, ${machineMcp.connectors.length} claude.ai connectors` : ", any claude.ai connectors"}
                  , and the repo&rsquo;s .mcp.json. The only way to get connectors.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-neutral-300">
              <input
                type="radio"
                name="shared-mcp-pick"
                className="mt-1"
                checked={draft.sharedMcpPick != null}
                onChange={() => set("sharedMcpPick", draft.sharedMcpPick ?? [])}
                disabled={machineMcp.global.length === 0}
              />
              <span>
                Only these
                <span className="block text-xs text-neutral-600">
                  Passed to the run by name, with everything else &mdash; connectors included &mdash; kept out.
                  {machineMcp.global.length === 0 ? " No shared servers are configured yet." : ""}
                </span>
              </span>
            </label>
            {draft.sharedMcpPick != null && (
              <div className="flex flex-wrap gap-1.5 pl-6">
                {machineMcp.global.map((srv) => {
                  const on = draft.sharedMcpPick!.includes(srv.name);
                  const h = machineMcp.health[srv.name];
                  return (
                    <label
                      key={srv.name}
                      className={`flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 text-xs ${
                        on ? "border-neutral-500 text-neutral-100" : "border-neutral-800 text-neutral-400"
                      }`}
                      title={srv.detail}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) =>
                          set(
                            "sharedMcpPick",
                            e.target.checked
                              ? [...draft.sharedMcpPick!, srv.name]
                              : draft.sharedMcpPick!.filter((n) => n !== srv.name),
                          )
                        }
                      />
                      <span className="font-mono">{srv.name}</span>
                      {h && <McpHealthDot status={h.status} />}
                    </label>
                  );
                })}
                {draft.sharedMcpPick!.filter((n) => !machineMcp.global.some((g) => g.name === n)).map((n) => (
                  <span key={n} className="rounded border border-amber-900 px-2 py-1 font-mono text-xs text-amber-500" title="Picked, but no shared server has this name any more">
                    {n}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <label className="flex items-center gap-2 pt-1 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={draft.inheritUserSettings ?? true}
            onChange={(e) => set("inheritUserSettings", e.target.checked)}
          />
          Use the shared skills and global CLAUDE.md
        </label>
        <p className="-mt-1 text-xs text-neutral-600">
          Needed for the skills under Settings &rarr; Skills to be invokable. It also brings that
          directory&rsquo;s settings.json along, including its list of pre-approved tools.
          {preapproved && preapproved.count > 0 ? (
            <>
              {" "}Yours pre-approves <strong>{preapproved.count}</strong> tool rule
              {preapproved.count === 1 ? "" : "s"}
              {preapproved.bare.includes("Bash") ? (
                <>
                  {" "}&mdash; including <code>Bash</code> with no pattern, which is <strong>every shell
                  command</strong>. An agent with this on will run those without asking, even if its
                  permission mode is Manual.
                </>
              ) : (
                <> that will run without asking, even if this agent&rsquo;s permission mode is Manual.</>
              )}
            </>
          ) : (
            <> Anything on that list runs without asking, even on a Manual agent.</>
          )}
        </p>

        {(draft.inheritUserSettings ?? true) && (
          <p className="text-xs text-neutral-500">
            Currently {sharedSkills.length} skill{sharedSkills.length === 1 ? "" : "s"}
            {claudeMdInfo?.exists ? ` and a ${(claudeMdInfo.size / 1024).toFixed(1)} KB global CLAUDE.md` : ""}
            {" "}&mdash; listed under Settings &rarr; Skills.
          </p>
        )}
      </div>

      <Row
        title="Environment"
        hint="This agent's own variables. It also inherits global and space env; on a clash, these win."
      >
        <EnvEditor
          key={`env-${agent?.id ?? "new"}-${Object.keys(draft.env ?? {}).length}`}
          value={draft.env ?? {}}
          onChange={(env) => set("env", env)}
          inherited={inheritedEnv}
        />
      </Row>
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 -mx-6 -mb-5 flex items-center gap-2 border-t border-neutral-800 bg-neutral-950 px-6 py-3">
        <button
          onClick={save}
          disabled={busy || !draft.name}
          className="rounded bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-40"
        >
          {agent ? "Save" : "Create"}
        </button>
        <button onClick={onCancel} className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-900">
          Cancel
        </button>
        {error && <span className="min-w-0 truncate text-sm text-red-400" title={error}>{error}</span>}
        {agent && (
          <button
            onClick={async () => {
              if (!confirm(`Delete "${agent.name}"? Its runs and delivery history go with it.`)) return;
              await api.deleteAgent(agent.id);
              onDirtyChange?.(false);
              onDeleted();
            }}
            className="ml-auto rounded border border-red-900 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
