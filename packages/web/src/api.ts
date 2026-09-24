import type {
  Agent,
  AgentInput,
  Approval,
  Delivery,
  MachineMcp,
  McpLogin,
  Artifact,
  McpCatalogEntry,
  PollOutcome,
  Health,
  RepoList,
  Skill,
  SkillsState,
  Stats,
  Run,
  RunEvent,
} from "./types.ts";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; issues?: { path?: (string | number)[]; message?: string }[] };
      if (typeof parsed.error === "string") message = parsed.error;
      // Zod issues name the field; without them "invalid agent" says nothing.
      if (Array.isArray(parsed.issues) && parsed.issues.length > 0) {
        message += ": " + parsed.issues.map((i) => `${(i.path ?? []).join(".") || "input"} — ${i.message ?? "invalid"}`).join("; ");
      }
    } catch {
      // not JSON; the raw body is the message
    }
    throw new Error(message || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  agents: () => fetch("/api/agents").then(json<Agent[]>),
  health: () => fetch("/api/health").then(json<Health>),
  setDefaultSpace: (space: string) =>
    fetch(`/api/spaces/${encodeURIComponent(space)}/default`, { method: "PUT" }).then(
      json<{ defaultSpace: string | null }>,
    ),
  clearDefaultSpace: (space: string) =>
    fetch(`/api/spaces/${encodeURIComponent(space)}/default`, { method: "DELETE" }).then(
      json<{ defaultSpace: string | null }>,
    ),
  machineMcp: () => fetch("/api/machine-mcp").then(json<MachineMcp>),
  skills: () => fetch("/api/skills").then(json<Skill[]>),
  repos: (refresh = false) =>
    fetch(`/api/github/repos${refresh ? "?refresh=1" : ""}`).then(json<RepoList>),
  createAgent: (input: AgentInput) =>
    fetch("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then(json<Agent>),
  updateAgent: (id: string, input: AgentInput) =>
    fetch(`/api/agents/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then(json<Agent>),
  schedule: (id: string) =>
    fetch(`/api/agents/${id}/schedule`).then(json<{ next: string[] }>),
  poll: (id: string) => fetch(`/api/agents/${id}/poll`, { method: "POST" }).then(json<PollOutcome>),
  clearPollState: (id: string) =>
    fetch(`/api/agents/${id}/poll-state`, { method: "DELETE" }).then(json<{ ok: true }>),
  deliveries: (id: string) => fetch(`/api/agents/${id}/deliveries`).then(json<Delivery[]>),
  setSecret: (id: string, webhookSecret: string) =>
    fetch(`/api/agents/${id}/webhook-secret`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webhookSecret }),
    }).then(json<{ ok: true }>),
  clearSecret: (id: string) =>
    fetch(`/api/agents/${id}/webhook-secret`, { method: "DELETE" }).then(json<{ ok: true }>),
  rotateSecret: (id: string) =>
    fetch(`/api/agents/${id}/webhook-secret`, { method: "POST" }).then(json<{ webhookSecret: string }>),
  testFire: (id: string, body: string) =>
    fetch(`/api/agents/${id}/test-fire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }).then(json<{ status: number; body: unknown }>),
  /** The whole roster's upcoming fires; the per-agent `schedule` above is unrelated. */
  scheduleAll: () => fetch("/api/schedule").then(json<{ agentId: string; at: string }[]>),
  deleteAgent: (id: string) =>
    fetch(`/api/agents/${id}`, { method: "DELETE" }).then(json<{ ok: true }>),
  setupGithub: (token: string) =>
    fetch("/api/setup/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }).then(json<{ login: string }>),
  /** Spends a few cents on a one-turn run to prove the token. Opt-in from setup only. */
  setupClaudeTest: (token: string) =>
    fetch("/api/setup/claude-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }).then(json<{ ok: true; reply: string }>),
  addMachineMcp: (name: string, config: Record<string, unknown>) =>
    fetch("/api/machine-mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, config }),
    }).then(json<MachineMcp>),
  removeMachineMcp: (name: string) =>
    fetch(`/api/machine-mcp/${encodeURIComponent(name)}`, { method: "DELETE" }).then(json<MachineMcp>),
  mcpLoginStart: (name: string) =>
    fetch(`/api/machine-mcp/${encodeURIComponent(name)}/login`, { method: "POST" }).then(json<McpLogin>),
  mcpLoginGet: (id: string) => fetch(`/api/machine-mcp/login/${id}`).then(json<McpLogin>),
  mcpLoginComplete: (id: string, redirectUrl: string) =>
    fetch(`/api/machine-mcp/login/${id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirectUrl }),
    }).then(json<McpLogin>),
  mcpLoginCancel: (id: string) => fetch(`/api/machine-mcp/login/${id}`, { method: "DELETE" }).then(json<{ ok: true }>),
  mcpLogout: (name: string) =>
    fetch(`/api/machine-mcp/${encodeURIComponent(name)}/logout`, { method: "POST" }).then(json<{ ok: true }>),
  claudeMd: () =>
    fetch("/api/setup/claude-md").then(
      json<{ path: string; exists: boolean; size: number; managed: boolean; content: string }>,
    ),
  setClaudeMd: (content: string) =>
    fetch("/api/setup/claude-md", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    }).then(json<{ path: string; exists: boolean; size: number; managed: boolean; content: string }>),
  mcpCatalog: () => fetch("/api/setup/mcp-catalog").then(json<{ managed: boolean; entries: McpCatalogEntry[] }>),
  applyMcpCatalog: (keys: string[]) =>
    fetch("/api/setup/mcp-catalog", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys }) }).then(
      json<{ added: string[]; removed: string[]; entries: McpCatalogEntry[] }>,
    ),
  skillsState: () => fetch("/api/setup/skills").then(json<SkillsState>),
  /** Fails with `candidates` when skills live in more than one place or not where `path` says. */
  skillsClone: async (url: string, path?: string) => {
    const res = await fetch("/api/setup/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(path ? { url, path } : { url }),
    });
    const body = (await res.json()) as { error?: string; candidates?: string[]; count?: number };
    if (!res.ok) throw Object.assign(new Error(body.error ?? `${res.status}`), { candidates: body.candidates });
    return body as { count: number };
  },
  skillsPull: () => fetch("/api/setup/skills/pull", { method: "POST" }).then(json<SkillsState>),
  /** Hours between background pulls of the skills checkout; 0 turns them off. */
  setSkillsRefresh: (hours: number) =>
    fetch("/api/setup/skills/refresh", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hours }),
    }).then(json<{ refreshHours: number }>),
  setWorkspaceRetention: (hours: number) =>
    fetch("/api/setup/workspace-retention", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hours }),
    }).then(json<{ workspaceRetentionHours: number }>),
  /** With a passphrase, secrets ride along sealed; without one they are left out. */
  exportAgents: (passphrase?: string) =>
    fetch("/api/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(passphrase ? { passphrase } : {}),
    }).then(json<{ version: number; agents: unknown[]; secrets?: unknown }>),
  importAgents: (payload: Record<string, unknown>, passphrase?: string) =>
    fetch("/api/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(passphrase ? { ...payload, passphrase } : payload),
    }).then(
      json<{
        created: string[];
        updated: string[];
        envNeeded: Record<string, string[]>;
        errors: { name: string }[];
        secretsApplied: { agents: number; spaces: number; globalKeys: number; mcp: number } | null;
        secretsNote: string | null;
        mcpNote: string | null;
      }>,
    ),
  /** Names only — what the server process itself was started with. */
  processEnvNames: () => fetch("/api/config/process-env").then(json<{ names: string[] }>),
  /** Env maps come back masked; send the mask back to keep a value, a string to replace it. */
  globalEnv: () => fetch("/api/config/env").then(json<{ env: Record<string, string> }>),
  /** `force` is required to write an empty map over a non-empty one. */
  setGlobalEnv: (env: Record<string, string>, force = false) =>
    fetch("/api/config/env", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(force ? { env, force: true } : { env }),
    }).then(json<{ env: Record<string, string> }>),
  spaceEnv: (space: string) =>
    fetch(`/api/spaces/${encodeURIComponent(space)}/env`).then(json<{ env: Record<string, string> }>),
  setSpaceEnv: (space: string, env: Record<string, string>, force = false) =>
    fetch(`/api/spaces/${encodeURIComponent(space)}/env`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(force ? { env, force: true } : { env }),
    }).then(json<{ env: Record<string, string> }>),
  spaceIcons: () => fetch("/api/spaces/icons").then(json<Record<string, string>>),
  /** `icon: null` puts the space back on the default tile. */
  setSpaceIcon: (space: string, icon: string | null) =>
    fetch(`/api/spaces/${encodeURIComponent(space)}/icon`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ icon }),
    }).then(json<{ icon: string | null }>),
  spaceSecretState: (space: string) =>
    fetch(`/api/spaces/${encodeURIComponent(space)}/secret`).then(json<{ configured: boolean; hookId: string | null }>),
  /** Omit `secret` to have the server mint one. Returns it once, then never again. */
  setSpaceSecret: (space: string, secret?: string) =>
    fetch(`/api/spaces/${encodeURIComponent(space)}/secret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(secret ? { secret } : {}),
    }).then(json<{ secret: string; hookId: string }>),
  clearSpaceSecret: (space: string) =>
    fetch(`/api/spaces/${encodeURIComponent(space)}/secret`, { method: "DELETE" }).then(
      json<{ ok: true }>,
    ),
  /** `name: null` unassigns every member, which is how a space is removed. */
  renameSpace: (from: string, name: string) =>
    fetch(`/api/spaces/${encodeURIComponent(from)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).then(json<{ moved: number; name: string }>),
  /** Members go to the default space; the space's secret and env are dropped. */
  removeSpace: (name: string) =>
    fetch(`/api/spaces/${encodeURIComponent(name)}`, { method: "DELETE" }).then(json<{ moved: number; name: string }>),
  systemPrompt: () => fetch("/api/system-prompt").then(json<{ files: string; delivery: string; config: string | null }>),
  pollProbe: (body: { url: string; headers: Record<string, string>; path: string | null; space: string | null; env: Record<string, string> }) =>
    fetch("/api/poll/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(
      json<{ status: number; bytes: number; watched: string; hash: string }>,
    ),
  cronPreview: (cron: string, tz: string | null) =>
    fetch(`/api/cron/preview?cron=${encodeURIComponent(cron)}${tz ? `&tz=${encodeURIComponent(tz)}` : ""}`).then(json<{ next: string[] }>),
  runArtifacts: (runId: string) => fetch(`/api/runs/${runId}/artifacts`).then(json<Artifact[]>),
  runsFor: (agentId: string) => fetch(`/api/runs?agentId=${agentId}`).then(json<Run[]>),
  runs: () => fetch("/api/runs").then(json<Run[]>),
  stats: (space?: string | null) => fetch(space ? `/api/stats?space=${encodeURIComponent(space)}` : "/api/stats").then(json<Stats>),
  spaceDeliveries: (space: string) =>
    fetch(`/api/spaces/${encodeURIComponent(space)}/deliveries`).then(json<Delivery[]>),
  /** Deliveries refused for a reason worth knowing about; filter misses excluded. */
  notableDrops: () => fetch("/api/deliveries").then(json<Delivery[]>),
  run: (id: string) => fetch(`/api/runs/${id}`).then(json<{ run: Run; events: RunEvent[] }>),
  startRun: (agentId: string, prompt?: string, permissionMode?: string, ephemeral?: boolean) =>
    fetch(`/api/agents/${agentId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(prompt ? { prompt } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(ephemeral ? { ephemeral: true } : {}),
      }),
    }).then(json<{ runId: string }>),
  send: (runId: string, text: string) =>
    fetch(`/api/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(json<{ ok: true }>),
  approvals: (runId: string) => fetch(`/api/runs/${runId}/approvals`).then(json<Approval[]>),
  decide: (
    approvalId: string,
    allow: boolean,
    reason?: string,
    answers?: Record<string, string | string[]>,
  ) =>
    fetch(`/api/approvals/${approvalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow, reason, answers }),
    }).then(json<{ ok: true }>),
  setMode: (runId: string, mode: string) =>
    fetch(`/api/runs/${runId}/permission-mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    }).then(json<{ ok: true }>),
  stop: (runId: string) => fetch(`/api/runs/${runId}/stop`, { method: "POST" }).then(json<{ ok: true }>),
};
