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

/** Signed over the raw bytes, so the body must not be reparsed first. */
export function verifyHmac(
  rawBody: string,
  header: string | undefined,
  secret: string,
  prefix = "sha256=",
): boolean {
  if (!header) return false;
  const expected = `${prefix}${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Slack's own window; a stale timestamp means a replayed request. */
export const SLACK_MAX_SKEW_SECONDS = 60 * 5;

/**
 * Slack signs `v0:{timestamp}:{body}`, not the body alone, and refuses anything
 * older than five minutes.
 */
export function verifySlack(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: string,
  nowSeconds = Date.now() / 1000,
): boolean {
  if (!signature || !timestamp) return false;
  const age = Math.abs(nowSeconds - Number(timestamp));
  if (!Number.isFinite(age) || age > SLACK_MAX_SKEW_SECONDS) return false;
  return verifyHmac(`v0:${timestamp}:${rawBody}`, signature, secret, "v0=");
}

export type WebhookPreset = {
  scheme: "token" | "hmac" | "slack";
  signatureHeader: string;
  signaturePrefix: string;
  /** Where the sender names the event, when it names one at all. */
  eventHeader: string | null;
  /** Senders that prove ownership by having you echo a secret they chose. */
  handshakeHeader: string | null;
};

const PRESETS: Record<string, WebhookPreset> = {
  token: {
    scheme: "token",
    signatureHeader: "x-bullpen-token",
    signaturePrefix: "",
    eventHeader: null,
    handshakeHeader: null,
  },
  github: {
    scheme: "hmac",
    signatureHeader: "x-hub-signature-256",
    signaturePrefix: "sha256=",
    eventHeader: "x-github-event",
    handshakeHeader: null,
  },
  slack: {
    scheme: "slack",
    signatureHeader: "x-slack-signature",
    signaturePrefix: "v0=",
    // Slack names the event in the body, not a header.
    eventHeader: null,
    handshakeHeader: null,
  },
  asana: {
    scheme: "hmac",
    signatureHeader: "x-hook-signature",
    signaturePrefix: "",
    eventHeader: null,
    handshakeHeader: "x-hook-secret",
  },
};

/** `hmac` predates the presets and always meant GitHub's shape. */
export function presetFor(agent: Agent): WebhookPreset {
  if (agent.webhookMode !== "custom") {
    return PRESETS[agent.webhookMode === "hmac" ? "github" : agent.webhookMode] ?? PRESETS.token!;
  }
  // Header lookups are against a lowercased map; what the user typed is not.
  const header = agent.webhookSignatureHeader?.trim().toLowerCase();
  // Configured with nothing, custom is the plain shared-secret sender.
  if (!header) return PRESETS.token!;
  return {
    scheme: "hmac",
    signatureHeader: header,
    signaturePrefix: agent.webhookSignaturePrefix ?? "",
    eventHeader: null,
    handshakeHeader: null,
  };
}

/**
 * Asana-style setup: the sender picks the secret and proves it reached us by
 * asking for it back. Only honoured while the agent has no secret, so a
 * stranger who knows the URL can't swap the secret out from under a live hook.
 */
export function handshakeSecret(
  agent: Agent,
  headers: Record<string, string | undefined>,
): string | null {
  const preset = presetFor(agent);
  if (!preset.handshakeHeader || agent.webhookSecret) return null;
  return headers[preset.handshakeHeader] ?? null;
}

export type Decision = { ok: true; prompt: string } | { ok: false; status: number; reason: string };

/**
 * A webhook body is attacker-influenced text heading for an agent that holds
 * Bash, so it only ever reaches the agent as data — interpolated into the
 * agent's own prompt, and written to .bullpen/payload.json. A caller cannot
 * supply instructions.
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

  const preset = presetFor(agent);
  const authorized =
    preset.scheme === "slack"
      ? verifySlack(
          rawBody,
          headers[preset.signatureHeader],
          headers["x-slack-request-timestamp"],
          agent.webhookSecret,
        )
      : preset.scheme === "hmac"
        ? verifyHmac(rawBody, headers[preset.signatureHeader], agent.webhookSecret, preset.signaturePrefix)
        : verifyToken(headers[preset.signatureHeader], agent.webhookSecret);
  if (!authorized) return { ok: false, status: 401, reason: "bad signature" };

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

  // Slack answers a retry with the same event, so let its own signal drop it
  // rather than running the agent twice.
  if (preset.scheme === "slack" && headers["x-slack-retry-num"]) {
    return { ok: false, status: 200, reason: `slack retry ${headers["x-slack-retry-num"]}` };
  }

  const event = eventNameOf(preset, headers);
  if (event === "ping") return { ok: false, status: 200, reason: "ping acknowledged" };

  const allowed = agent.webhookEvents as string[];
  if (event && allowed.length > 0 && !allowed.includes(event)) {
    return { ok: false, status: 202, reason: `event ${event} not in this agent's allowlist` };
  }

  const path = agent.filterPath?.trim();
  const wanted = (agent.filterValues as string[] | undefined) ?? [];
  if (path && wanted.length > 0) {
    const found = valueAtPath(payload, path);
    if (found === undefined || !wanted.includes(found)) {
      return { ok: false, status: 202, reason: `${path}=${found ?? "(missing)"} is not in the filter` };
    }
  }

  return { ok: true, prompt: renderPrompt(agent.prompt, payload) };
}

/**
 * Reads a dot path out of the payload. Deliberately not sender-specific: the
 * same field works for Slack's event.channel, GitHub's action, or anything else
 * that identifies which thing a delivery is about.
 */
export function valueAtPath(payload: Record<string, unknown>, path: string): string | undefined {
  let value: unknown = payload;
  for (const key of path.split(".")) {
    value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  }
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Only GitHub names its event in a header, and only GitHub has an allowlist. */
export function eventNameOf(
  preset: WebhookPreset,
  headers: Record<string, string | undefined>,
): string | undefined {
  return preset.eventHeader ? headers[preset.eventHeader] : undefined;
}

/**
 * Slack proves it owns the URL by asking for a value from the body back, where
 * Asana asks for a header back. Signature is checked first either way.
 */
export function urlVerificationChallenge(preset: WebhookPreset, rawBody: string): string | null {
  if (preset.scheme !== "slack") return null;
  try {
    const payload = JSON.parse(rawBody) as { type?: unknown; challenge?: unknown };
    return payload.type === "url_verification" && typeof payload.challenge === "string"
      ? payload.challenge
      : null;
  } catch {
    return null;
  }
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
