import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/index.ts";
import { webhookDeliveries, type Agent } from "../db/schema.ts";

export const MAX_BODY_BYTES = 1_000_000;

export function verifyToken(provided: string | undefined, secret: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** GitHub sends `sha256=<hex>` over the raw bytes, so the body must not be reparsed first. */
export function verifyHmac(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Decision = { ok: true; prompt: string } | { ok: false; status: number; reason: string };

/**
 * A webhook body is attacker-influenced text heading for an agent that holds
 * Bash, so it is interpolated as data. Replacing the prompt outright takes an
 * explicit per-agent opt-in.
 */
export function decideDelivery(opts: {
  agent: Agent;
  rawBody: string;
  headers: Record<string, string | undefined>;
}): Decision {
  const { agent, rawBody, headers } = opts;
  if (!agent.enabled) return { ok: false, status: 409, reason: "agent is disabled" };
  if (!agent.webhookSecret) return { ok: false, status: 401, reason: "no webhook secret" };
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return { ok: false, status: 413, reason: "body too large" };
  }

  const authorized =
    agent.webhookMode === "hmac"
      ? verifyHmac(rawBody, headers["x-hub-signature-256"], agent.webhookSecret)
      : verifyToken(headers["x-bullpen-token"], agent.webhookSecret);
  if (!authorized) return { ok: false, status: 401, reason: "bad signature" };

  const event = headers["x-github-event"];
  if (event === "ping") return { ok: false, status: 200, reason: "ping acknowledged" };

  const allowed = agent.webhookEvents as string[];
  if (event && allowed.length > 0 && !allowed.includes(event)) {
    return { ok: false, status: 202, reason: `event ${event} not in this agent's allowlist` };
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    return {
      ok: false,
      status: 400,
      reason: headers["content-type"]?.includes("x-www-form-urlencoded")
        ? "set the webhook content type to application/json"
        : "body is not JSON",
    };
  }

  const override = payload.prompt;
  if (typeof override === "string" && agent.allowPromptOverride) {
    return { ok: true, prompt: override };
  }
  return { ok: true, prompt: renderPrompt(agent.prompt, payload) };
}

/** {{payload.a.b}} substitution. Values land as JSON, never as bare instructions. */
export function renderPrompt(template: string, payload: unknown): string {
  return template.replace(/\{\{payload(?:\.([\w.]+))?\}\}/g, (_m, path?: string) => {
    let value: unknown = payload;
    for (const key of path ? path.split(".") : []) {
      value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    }
    if (value === undefined) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

/** Big payloads belong on disk where the agent can Read them, not in the prompt. */
export function writePayload(workspacePath: string, rawBody: string): void {
  const dir = join(workspacePath, ".bullpen");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "payload.json"), rawBody);
}

export function recordDelivery(row: {
  agentId: string;
  sourceIp?: string | undefined;
  deliveryKey?: string | undefined;
  event?: string | undefined;
  accepted: boolean;
  reason?: string | undefined;
  runId?: string | undefined;
}): void {
  db.insert(webhookDeliveries)
    .values({ id: randomUUID(), ...row })
    .run();
}

export function alreadyDelivered(agentId: string, key: string | undefined): string | null {
  if (!key) return null;
  const prior = db
    .select()
    .from(webhookDeliveries)
    .all()
    .find((d) => d.agentId === agentId && d.deliveryKey === key && d.accepted);
  return prior?.runId ?? null;
}
