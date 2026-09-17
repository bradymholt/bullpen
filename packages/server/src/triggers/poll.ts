import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { agents, type Agent } from "../db/schema.ts";
import { interpolateSecrets } from "../mcp.ts";
import { agentHasActiveRun, requestRun } from "../runs/RunManager.ts";
import { MAX_BODY_BYTES, recordDelivery } from "./webhook.ts";

export type PollOutcome =
  | { kind: "primed"; status: number }
  | { kind: "unchanged"; status: number }
  | { kind: "changed"; status: number; runId: string }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

/** Dot path into the parsed body; anything missing hashes as empty. */
function atPath(body: string, path: string | null): string {
  if (!path?.trim()) return body;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return body;
  }
  for (const key of path.trim().split(".")) {
    value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  }
  return value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
}

function payloadOf(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { data: parsed };
  } catch {
    return { text: body };
  }
}

/**
 * A dry check for the editor: fetch the URL as a run would, report what came
 * back and what the watched path resolves to. Nothing is recorded.
 */
export async function probePoll(
  opts: { url: string; headers: Record<string, string>; path: string | null; env: Record<string, string> },
  timeoutMs = 20_000,
): Promise<{ status: number; bytes: number; watched: string; hash: string }> {
  const res = await fetch(interpolateSecrets(opts.url, opts.env), {
    headers: interpolateSecrets(opts.headers, opts.env),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 200)}`);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("response too large");
  const watched = atPath(body, opts.path);
  return {
    status: res.status,
    bytes: Buffer.byteLength(body),
    watched: watched.slice(0, 300),
    hash: createHash("sha256").update(watched).digest("hex").slice(0, 12),
  };
}

/**
 * One check. A first poll only records the shape it found — firing there would
 * stampede an agent with everything the endpoint already had.
 */
export async function pollOnce(agent: Agent, timeoutMs = 20_000): Promise<PollOutcome> {
  if (!agent.pollUrl) return { kind: "skipped", reason: "no poll url" };
  if (!agent.enabled) return { kind: "skipped", reason: "agent is disabled" };

  const env = agent.env as Record<string, string>;
  const headers = interpolateSecrets(agent.pollHeaders as Record<string, string>, env);

  let status = 0;
  let body: string;
  try {
    const res = await fetch(interpolateSecrets(agent.pollUrl, env), {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    body = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 200)}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    finish(agent.id, { status: `error: ${reason}`.slice(0, 300) });
    recordDelivery({ agentId: agent.id, event: "poll", accepted: false, reason });
    return { kind: "failed", reason };
  }

  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    const reason = "response too large";
    finish(agent.id, { status: reason });
    recordDelivery({ agentId: agent.id, event: "poll", accepted: false, reason });
    return { kind: "failed", reason };
  }

  const hash = createHash("sha256").update(atPath(body, agent.pollPath)).digest("hex");

  if (!agent.pollState) {
    finish(agent.id, { status: `${status} primed`, state: hash });
    recordDelivery({ agentId: agent.id, event: "poll", accepted: false, reason: "primed" });
    return { kind: "primed", status };
  }

  if (hash === agent.pollState) {
    finish(agent.id, { status: `${status} unchanged` });
    return { kind: "unchanged", status };
  }

  if (agent.concurrency === "skip" && agentHasActiveRun(agent.id)) {
    finish(agent.id, { status: `${status} changed, run already active` });
    recordDelivery({ agentId: agent.id, event: "poll", accepted: false, reason: "run already active" });
    return { kind: "skipped", reason: "run already active" };
  }

  const { runId } = requestRun({
    agent,
    trigger: "poll",
    prompt: renderPollPrompt(agent.prompt, body),
    rawPayload: body,
  });
  // Written only once the run exists, so a crash mid-start re-fires rather than
  // silently swallowing the change.
  finish(agent.id, { status: `${status} changed`, state: hash });
  recordDelivery({ agentId: agent.id, event: "poll", accepted: true, runId });
  return { kind: "changed", status, runId };
}

function renderPollPrompt(template: string, body: string): string {
  const payload = payloadOf(body);
  return template.replace(/\{\{payload(?:\.([\w.]+))?\}\}/g, (_m, path?: string) => {
    let value: unknown = payload;
    for (const key of path ? path.split(".") : []) {
      value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    }
    if (value === undefined) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function finish(agentId: string, patch: { status: string; state?: string }): void {
  db.update(agents)
    .set({
      pollStatus: patch.status,
      pollCheckedAt: Math.floor(Date.now() / 1000),
      ...(patch.state ? { pollState: patch.state } : {}),
    })
    .where(eq(agents.id, agentId))
    .run();
}
