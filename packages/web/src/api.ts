import type {
  Agent,
  AgentInput,
  Approval,
  Delivery,
  MachineMcp,
  PollOutcome,
  Health,
  RepoList,
  Skill,
  Run,
  RunEvent,
} from "./types.ts";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  agents: () => fetch("/api/agents").then(json<Agent[]>),
  health: () => fetch("/api/health").then(json<Health>),
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
  spaceSecretState: (space: string) =>
    fetch(`/api/spaces/${encodeURIComponent(space)}/secret`).then(json<{ configured: boolean }>),
  /** Omit `secret` to have the server mint one. Returns it once, then never again. */
  setSpaceSecret: (space: string, secret?: string) =>
    fetch(`/api/spaces/${encodeURIComponent(space)}/secret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(secret ? { secret } : {}),
    }).then(json<{ secret: string }>),
  clearSpaceSecret: (space: string) =>
    fetch(`/api/spaces/${encodeURIComponent(space)}/secret`, { method: "DELETE" }).then(
      json<{ ok: true }>,
    ),
  /** `name: null` unassigns every member, which is how a space is removed. */
  renameSpace: (from: string, name: string | null) =>
    fetch(`/api/spaces/${encodeURIComponent(from)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).then(json<{ moved: number; name: string | null }>),
  runsFor: (agentId: string) => fetch(`/api/runs?agentId=${agentId}`).then(json<Run[]>),
  runs: () => fetch("/api/runs").then(json<Run[]>),
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
