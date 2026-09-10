import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Agent, AgentInput, WorkspaceConfig } from "./types.ts";

const MODES = [
  ["supervised", "Ask before commands and edits"],
  ["acceptEdits", "Auto-accept file edits"],
  ["plan", "Explore and plan, no edits"],
  ["full", "No prompts at all"],
  ["locked", "Deny anything not pre-approved"],
] as const;

const field = "w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm outline-none focus:border-neutral-600";
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

export function AgentEditor({
  agent,
  onSaved,
  onDeleted,
  onCancel,
}: {
  agent: Agent | null;
  onSaved: (a: Agent) => void;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<AgentInput>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
    setDraft(
      agent ?? {
        name: "",
        prompt: "",
        permissionMode: "supervised",
        workspaceConfig: { kind: "persistent" },
        env: {},
        allowedTools: [],
      },
    );
  }, [agent?.id]);

  const set = <K extends keyof AgentInput>(k: K, v: AgentInput[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const ws = (draft.workspaceConfig ?? { kind: "persistent" }) as WorkspaceConfig;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = agent
        ? await api.updateAgent(agent.id, draft)
        : await api.createAgent(draft);
      onSaved(saved);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h2 className="text-lg font-semibold">{agent ? `Edit ${agent.name}` : "New agent"}</h2>

      <Row title="Name">
        <input className={field} value={draft.name ?? ""} onChange={(e) => set("name", e.target.value)} />
      </Row>

      <Row title="Prompt" hint="What this agent does every time you run it.">
        <textarea
          className={`${field} h-28 resize-y font-mono`}
          value={draft.prompt ?? ""}
          onChange={(e) => set("prompt", e.target.value)}
        />
      </Row>

      <Row title="Model" hint="Blank uses Claude Code's default.">
        <input
          className={field}
          placeholder="claude-opus-5"
          value={draft.model ?? ""}
          onChange={(e) => set("model", e.target.value || null)}
        />
      </Row>

      <Row title="Permission mode">
        <select
          className={field}
          value={draft.permissionMode ?? "supervised"}
          onChange={(e) => set("permissionMode", e.target.value)}
        >
          {MODES.map(([v, desc]) => (
            <option key={v} value={v}>
              {v} — {desc}
            </option>
          ))}
        </select>
      </Row>

      <Row title="Workspace">
        <select
          className={field}
          value={ws.kind}
          onChange={(e) =>
            set(
              "workspaceConfig",
              e.target.value === "git" ? { kind: "git", repoUrl: "" } : { kind: "persistent" },
            )
          }
        >
          <option value="persistent">persistent — a directory that survives runs</option>
          <option value="git">git — fresh clone and branch per run</option>
        </select>
      </Row>

      {ws.kind === "git" && (
        <>
          <Row title="Repo URL">
            <input
              className={field}
              placeholder="https://github.com/you/repo.git"
              value={ws.repoUrl}
              onChange={(e) => set("workspaceConfig", { ...ws, repoUrl: e.target.value })}
            />
          </Row>
          <Row title="Base branch">
            <input
              className={field}
              placeholder="main"
              value={ws.baseBranch ?? ""}
              onChange={(e) => set("workspaceConfig", { ...ws, baseBranch: e.target.value || undefined })}
            />
          </Row>
        </>
      )}

      <Row
        title="Allowed tools"
        hint="Comma separated. MCP wildcards need a real server name: mcp__linear__* works, mcp__* is ignored."
      >
        <input
          className={field}
          placeholder="Read, Grep, mcp__linear__*"
          value={(draft.allowedTools ?? []).join(", ")}
          onChange={(e) =>
            set("allowedTools", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))
          }
        />
      </Row>

      <Row title="MCP servers" hint="JSON, same shape the Agent SDK takes.">
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
      </Row>

      <label className="flex items-center gap-2 text-sm text-neutral-300">
        <input
          type="checkbox"
          checked={draft.inheritMachineMcp ?? false}
          onChange={(e) => set("inheritMachineMcp", e.target.checked)}
        />
        Inherit this machine&rsquo;s MCP config
      </label>
      <p className="-mt-2 text-xs text-neutral-600">
        Off by default. On, the agent also picks up servers from ~/.claude.json, the repo&rsquo;s
        .mcp.json, and claude.ai connectors.
      </p>

      {error && <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</p>}

      <div className="flex items-center gap-2 pt-2">
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
              await api.deleteAgent(agent.id);
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
