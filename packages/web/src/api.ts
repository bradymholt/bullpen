import type { Agent, Run, RunEvent } from "./types.ts";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  agents: () => fetch("/api/agents").then(json<Agent[]>),
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
  stop: (runId: string) => fetch(`/api/runs/${runId}/stop`, { method: "POST" }).then(json<{ ok: true }>),
};
