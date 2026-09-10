import type { Agent, AgentInput, Approval, Delivery, Run, RunEvent } from "./types.ts";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  agents: () => fetch("/api/agents").then(json<Agent[]>),
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
  deliveries: (id: string) => fetch(`/api/agents/${id}/deliveries`).then(json<Delivery[]>),
  deleteAgent: (id: string) =>
    fetch(`/api/agents/${id}`, { method: "DELETE" }).then(json<{ ok: true }>),
  runsFor: (agentId: string) => fetch(`/api/runs?agentId=${agentId}`).then(json<Run[]>),
  runs: () => fetch("/api/runs").then(json<Run[]>),
  run: (id: string) => fetch(`/api/runs/${id}`).then(json<{ run: Run; events: RunEvent[] }>),
  startRun: (agentId: string, prompt?: string) =>
    fetch(`/api/agents/${agentId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prompt ? { prompt } : {}),
    }).then(json<{ runId: string }>),
  send: (runId: string, text: string) =>
    fetch(`/api/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(json<{ ok: true }>),
  approvals: (runId: string) => fetch(`/api/runs/${runId}/approvals`).then(json<Approval[]>),
  decide: (approvalId: string, allow: boolean, reason?: string) =>
    fetch(`/api/approvals/${approvalId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow, reason }),
    }).then(json<{ ok: true }>),
  setMode: (runId: string, mode: string) =>
    fetch(`/api/runs/${runId}/permission-mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    }).then(json<{ ok: true }>),
  stop: (runId: string) => fetch(`/api/runs/${runId}/stop`, { method: "POST" }).then(json<{ ok: true }>),
};
