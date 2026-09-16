import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { MODES } from "./modes.ts";
import { ListInput, randomSecret, TriggerSettings } from "./TriggerSettings.tsx";
import type { Agent, AgentInput, MachineMcp, Repo, RepoList, WorkspaceConfig } from "./types.ts";

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

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <span className={label}>{title}</span>
      {children}
      {hint && <p className="mt-1 text-xs text-neutral-600">{hint}</p>}
    </div>
  );
}

function Chips({ title, names }: { title: string; names: string[] }) {
  return (
    <div className="mb-2 last:mb-0">
      <span className="text-neutral-500">{title}</span>
      {names.length === 0 ? (
        <span className="ml-2 text-neutral-600">none</span>
      ) : (
        <div className="mt-1 flex flex-wrap gap-1">
          {names.map((n) => (
            <span key={n} className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
              {n}
            </span>
          ))}
        </div>
      )}
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
  onSaved,
  onDeleted,
  onCancel,
  onDirtyChange,
}: {
  agent: Agent | null;
  /** Fills a new agent in from an existing one, leaving the original alone. */
  seed?: Agent | null;
  /** Spaces already in use, offered as suggestions. */
  spaces?: string[];
  /** A new agent lands in the space the roster is filtered to. */
  defaultSpace?: string | null;
  onSaved: (a: Agent) => void;
  onDeleted: () => void;
  onCancel: () => void;
  /** Fires as the draft diverges from what was loaded, so the shell can guard navigation. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<AgentInput>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [machineMcp, setMachineMcp] = useState<MachineMcp | null>(null);
  const [repoList, setRepoList] = useState<RepoList | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);

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
              ...(defaultSpace ? { space: defaultSpace } : {}),
              webhookSecret: randomSecret(),
              name: "",
              prompt: "",
              permissionMode: "auto",
              workspaceConfig: { kind: "ephemeral" },
              concurrency: "allow",
              env: {},
              allowedTools: [],
              inheritMachineMcp: true,
              inheritUserSettings: true,
            });
    loadedRef.current = JSON.stringify(seeded);
    setDraft(seeded);
    setShowMcp(Object.keys((agent ?? seed)?.mcpServers ?? {}).length > 0);
  }, [agent?.id, seed?.id]);

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
  // A space the roster doesn't know yet — a seeded draft, or one being typed.
  const spaceOptions =
    draft.space && !spaces.includes(draft.space) ? [...spaces, draft.space].sort() : spaces;
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
  const mcpCount = Object.keys(draft.mcpServers ?? {}).length;
  const knownModel = !draft.model || MODELS.some(([v]) => v === draft.model);
  const mode = draft.permissionMode ?? "auto";
  // `auto` and `full` never prompt, so a permission rule changes nothing there.
  const toolRulesApply = mode !== "auto" && mode !== "full";
  const droppedEnv = seed ? Object.keys(seed.env) : [];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = agent
        ? await api.updateAgent(agent.id, draft)
        : await api.createAgent(draft);
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
      <h2 className="text-lg font-semibold">
        {agent ? `Edit ${agent.name}` : seed ? `Copy of ${seed.name}` : "New agent"}
      </h2>
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
          <input className={field} value={draft.name ?? ""} onChange={(e) => set("name", e.target.value)} />
        </Row>
        <Row title="Space" hint="Groups your agents.">
          {naming ? (
            <input
              className={field}
              autoFocus
              placeholder="work"
              value={draft.space ?? ""}
              onChange={(e) => set("space", e.target.value || null)}
              onBlur={() => {
                const trimmed = (draft.space ?? "").trim();
                set("space", trimmed || null);
                if (!trimmed) setNaming(false);
              }}
            />
          ) : (
            <select
              className={field}
              value={draft.space ?? ""}
              onChange={(e) => {
                setNaming(e.target.value === "__new__");
                set("space", e.target.value === "__new__" ? null : e.target.value || null);
              }}
            >
              <option value="">Unassigned</option>
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

      <TriggerSettings agent={agent} draft={draft} set={set} />

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
          <option value="scratch">Scratch directory — one folder this agent reuses every run</option>
          <option value="ephemeral">Fresh directory — a new folder per run, deleted after</option>
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
          <option value="skip">Skip — refuse a trigger while a run is active</option>
          <option value="allow">Allow — start it anyway, in parallel</option>
        </select>
        {(draft.concurrency ?? "allow") === "allow" &&
        (wsKind === "scratch" || wsKind === "existing") ? (
          <p className="mt-1 rounded border border-amber-900 bg-amber-950/40 px-2 py-1.5 text-xs leading-relaxed text-amber-300">
            Parallel runs share one directory and will overwrite each other&rsquo;s files, including
            the webhook payload. Set <strong>Workspace</strong> above to{" "}
            <strong>Fresh directory</strong>.
          </p>
        ) : (
          <p className="mt-1 text-xs leading-relaxed text-neutral-600">
            {(draft.concurrency ?? "allow") === "skip"
              ? "A trigger that arrives mid-run is dropped, not queued — two webhooks in quick succession means the second is never handled. A run waiting on an approval counts as active."
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
          Inherit this machine&rsquo;s
        </label>
        <p className="-mt-1 text-xs text-neutral-600">
          Servers from {machineMcp?.configPath ?? "~/.claude.json"}, the repo&rsquo;s .mcp.json, and
          claude.ai connectors.
        </p>

        {(draft.inheritMachineMcp ?? true) && machineMcp && (
          <div className="rounded border border-neutral-800 bg-neutral-950 p-2.5 text-xs">
            {!machineMcp.found ? (
              <p className="text-neutral-600">No config found at {machineMcp.configPath}.</p>
            ) : (
              <>
                <Chips title="From this machine" names={machineMcp.global.map((s) => s.name)} />
                <Chips title="claude.ai connectors" names={machineMcp.connectors} />
                <p className="mt-2 text-neutral-600">
                  What actually connects is reported per run as an mcp.status event.
                </p>
              </>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => setShowMcp((v) => !v)}
          className="block pt-1 text-left text-xs text-neutral-500 hover:text-neutral-300"
        >
          {showMcp ? "▾" : "▸"} Add servers just for this agent
          {mcpCount > 0 ? ` (${mcpCount})` : ""}
        </button>

        {showMcp && (
          <div>
            <textarea
              className={`${field} h-24 resize-y font-mono text-xs`}
              defaultValue={JSON.stringify(draft.mcpServers ?? {}, null, 2)}
              onBlur={(e) => {
                try {
                  set("mcpServers", JSON.parse(e.target.value || "{}"));
                  setError(null);
                } catch {
                  setError("MCP servers must be valid JSON");
                }
              }}
            />
            <p className="mt-1 text-xs text-neutral-600">
              JSON, same shape the Agent SDK takes. These are added to whatever is inherited above.
            </p>
          </div>
        )}

        <label className="flex items-center gap-2 pt-1 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={draft.inheritUserSettings ?? true}
            onChange={(e) => set("inheritUserSettings", e.target.checked)}
          />
          Load this machine&rsquo;s skills and global CLAUDE.md
        </label>
        <p className="-mt-1 text-xs text-neutral-600">
          Needed for ~/.claude/skills to be invokable. It also loads ~/.claude/settings.json, so any
          allow rule there auto-approves that tool without prompting &mdash; a bare <code>Bash</code>{" "}
          rule turns the approval UI off entirely.
        </p>
      </div>
          </div>
        </div>
      </div>

      {error && <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</p>}

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
