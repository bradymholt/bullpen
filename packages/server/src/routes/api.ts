import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { agentCreateSchema, agentPatchSchema, inferTrigger, DEFAULT_SPACE } from "../agentSchema.ts";
import { nextRuns, rescheduleAgent } from "../triggers/cron.ts";
import { pollOnce, probePoll } from "../triggers/poll.ts";
import {
  alreadyDelivered,
  decideDelivery,
  eventNameOf,
  handshakeSecret,
  presetFor,
  recordDelivery,
  renderPrompt,
  urlVerificationChallenge,
} from "../triggers/webhook.ts";
import { config } from "../config.ts";
import { git } from "../workspaces.ts";
import { claudeCredential, defaultSpace, globalEnv, maskEnv, mergeMaskedEnv, resolveEnv, setDefaultSpace, setGlobalEnv, setSkillsRefreshHours, spaceEnv } from "../env.ts";
import { claudeRunner } from "../runs/ClaudeRunner.ts";
import { open, seal, type SealedBundle, type SecretsBundle } from "../secretsBundle.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addMachineMcp, applyMcpCatalog, exportMachineMcp, importMachineMcp, mcpCatalog, readMachineMcp, removeMachineMcp } from "../machineMcp.ts";
import { listRepos } from "../github.ts";
import { claudeConfigDir, claudeMdState, findSkillRoots, listSkills, skillDirsIn, skillsState, startSkillsRefresh, writeClaudeMd } from "../skills.ts";
import { cancelMcpLogin, completeMcpLogin, getMcpLogin, mcpLogout, startMcpLogin } from "../mcpLogin.ts";
import { exportFilename, renderTranscript } from "../transcript.ts";
import { artifactPath, listArtifacts } from "../artifacts.ts";
import { noteworthyConfigDir, SYSTEM_NOTE } from "../runs/systemNote.ts";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".json": "application/json", ".csv": "text/csv; charset=utf-8", ".html": "text/html; charset=utf-8", ".zip": "application/zip",
};
const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
/**
 * Types a browser can show in place. An HTML report is usually the email the
 * agent just sent, and downloading a file to see what went out is a poor way
 * to read it. Anything else still downloads.
 */
const INLINE_TYPES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf", ".txt", ".md", ".json", ".csv", ".html"]);
import { foldMcpHealth } from "../mcp.ts";
import {
  commit as gitCommit,
  diff as gitDiff,
  openPullRequest,
  push as gitPush,
  status as gitStatus,
} from "../git.ts";
import { db } from "../db/index.ts";
import { type Agent, agents, runEvents, runs, spaceSecrets, webhookDeliveries } from "../db/schema.ts";
import { eventsSince } from "../runs/eventLog.ts";
import { decideApproval, pendingApprovals } from "../runs/approvals.ts";
import {
  agentHasActiveRun,
  getAgent,
  isResumable,
  isPermissionMode,
  listAgents,
  sendToRun,
  setRunPermissionMode,
  QueueFullError,
  requestRun,
  stopRun,
} from "../runs/RunManager.ts";

export const api = new Hono();

/** The config plus each server's last-known connection state, taken from recent runs' init messages. */
function machineMcpState() {
  const recent = db
    .select({ ts: runEvents.ts, payload: runEvents.payload })
    .from(runEvents)
    .where(eq(runEvents.type, "mcp.status"))
    .orderBy(desc(runEvents.id))
    .limit(200)
    .all();
  return { ...readMachineMcp(), health: foldMcpHealth(recent) };
}

api.get("/machine-mcp", (c) => c.json(machineMcpState()));

/** OAuth for a remote server or claude.ai connector, through the harness's own `claude mcp login`. */
api.post("/machine-mcp/:name/login", (c) => c.json(startMcpLogin(c.req.param("name")), 202));
api.get("/machine-mcp/login/:id", (c) => {
  const l = getMcpLogin(c.req.param("id"));
  return l ? c.json(l) : c.json({ error: "not found" }, 404);
});
api.post("/machine-mcp/login/:id/complete", async (c) => {
  const body = await c.req.json<{ redirectUrl?: string }>().catch(() => null);
  if (!body?.redirectUrl) return c.json({ error: "redirectUrl is required" }, 400);
  try {
    return c.json(await completeMcpLogin(c.req.param("id"), body.redirectUrl));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
api.delete("/machine-mcp/login/:id", (c) => {
  cancelMcpLogin(c.req.param("id"));
  return c.json({ ok: true });
});
api.post("/machine-mcp/:name/logout", async (c) => {
  try {
    await mcpLogout(c.req.param("name"));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/** Adds a server every run inherits. Managed dirs are written directly; otherwise via the `claude` CLI. */
api.post("/machine-mcp", async (c) => {
  const body = await c.req.json<{ name?: string; config?: Record<string, unknown> }>().catch(() => null);
  if (!body?.name || !body.config || typeof body.config !== "object") return c.json({ error: "name and config are required" }, 400);
  try {
    addMachineMcp(body.name.trim(), body.config);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  return c.json(machineMcpState());
});

api.delete("/machine-mcp/:name", (c) => {
  try {
    removeMachineMcp(c.req.param("name"));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  return c.json(machineMcpState());
});

api.get("/skills", (c) => c.json(listSkills()));
api.get("/github/repos", async (c) => {
  try {
    return c.json(await listRepos(c.req.query("refresh") === "1"));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

/**
 * `publicUrl` is where senders reach /api/hooks. Set explicitly, or derived when
 * the request came through Tailscale serve (it stamps identity headers on
 * tailnet traffic): the same host, on the funneled port. Otherwise null and the
 * UI uses its own origin.
 */
function publicUrlFor(c: Context): string | null {
  if (config.publicUrl) return config.publicUrl;
  if (!c.req.header("tailscale-user-login")) return null;
  const host = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "").replace(/:\d+$/, "");
  return host ? `https://${host}:${config.tailscaleHooksPort}` : null;
}

api.get("/health", (c) => {
  const credential = claudeCredential();
  return c.json({
    ok: credential.source !== "none",
    dataDir: config.dataDir,
    publicUrl: publicUrlFor(c),
    version: config.version,
    release: config.release,
    repoUrl: config.repoUrl,
    claudeCredential: credential,
    defaultSpace: defaultSpace(),
  });
});

/** Proves a GitHub token before it is saved: who does it authenticate as? */
api.post("/setup/github", async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => null);
  const token = body?.token?.trim();
  if (!token) return c.json({ error: "token is required" }, 400);
  const res = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "bullpen" },
  }).catch(() => null);
  if (!res) return c.json({ error: "could not reach api.github.com" }, 502);
  if (!res.ok) return c.json({ error: `GitHub said ${res.status}` }, 401);
  const user = (await res.json()) as { login: string };
  return c.json({ login: user.login });
});

/**
 * Proves a Claude token by spending a few cents on a one-turn run. Explicit and
 * opt-in from setup, never automatic: it costs money and takes seconds. Runs
 * locked with no tools in a throwaway directory, so it can do nothing but reply.
 */
api.post("/setup/claude-test", async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => null);
  const token = body?.token?.trim();
  if (!token) return c.json({ error: "token is required" }, 400);

  const cwd = mkdtempSync(join(tmpdir(), "bullpen-setup-"));
  let reply = "";
  let errorText = "";
  // Streaming-input sessions stay open after a result so a run can be replied
  // to, so `done` is the wrong thing to await here: the result event is the
  // finish line, and the session is closed explicitly afterwards.
  let settle!: (r: { isError: boolean }) => void;
  const result = new Promise<{ isError: boolean }>((r) => (settle = r));

  const handle = claudeRunner.start(
    {
      cwd,
      prompt: "Reply with exactly the word OK and nothing else.",
      permissionMode: "locked",
      allowedTools: [],
      strictMcpConfig: true,
      inheritUserSettings: false,
      maxTurns: 1,
      env: { CLAUDE_CODE_OAUTH_TOKEN: token },
    },
    {
      onMessage: (type, payload) => {
        const m = payload as {
          message?: { content?: { type: string; text?: string }[] };
          subtype?: string;
          result?: string;
          errors?: string[];
        };
        if (type === "assistant") {
          for (const b of m.message?.content ?? []) if (b.type === "text" && b.text) reply += b.text;
        }
        if (type === "result") {
          errorText = m.errors?.join("; ") || (m.subtype && m.subtype !== "success" ? m.subtype : "") || m.result || "";
        }
      },
      onSession: () => {},
      onMcpStatus: () => {},
      onResult: ({ isError }) => settle({ isError }),
    },
  );

  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 30_000));
  const outcome = await Promise.race([result, timeout]);
  await handle.stop();
  rmSync(cwd, { recursive: true, force: true });

  if (outcome === "timeout") return c.json({ ok: false, error: "no reply within 30 seconds" }, 504);
  if (outcome.isError) {
    return c.json({ ok: false, error: errorText || "the harness reported an error — is the token valid?" }, 401);
  }
  return c.json({ ok: true, reply: reply.trim().slice(0, 80) });
});

/** Secret env values never leave the server; the UI can set or clear, not read. */
function redact(agent: Agent): Agent {
  // A row from before spaces were required may still hold null; clients assume a name.
  return { ...agent, space: agent.space ?? DEFAULT_SPACE, env: maskEnv(agent.env as Record<string, string>) };
}

api.get("/agents", (c) => c.json(listAgents().map(redact)));

/** The whole roster's upcoming cron fires, flattened — the home view's "up next". */
/** Next fires for an expression being typed, so the editor can say so before anything is saved. */
api.get("/cron/preview", (c) => {
  const cron = c.req.query("cron")?.trim();
  if (!cron) return c.json({ error: "cron is required" }, 400);
  try {
    return c.json({ next: nextRuns(cron, c.req.query("tz") || null, 3) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "invalid cron expression" }, 400);
  }
});

api.get("/schedule", (c) => {
  const upcoming: { agentId: string; at: string }[] = [];
  for (const agent of listAgents()) {
    if (!agent.cron || !agent.enabled) continue;
    try {
      for (const at of nextRuns(agent.cron, agent.cronTimezone, 2)) {
        upcoming.push({ agentId: agent.id, at });
      }
    } catch {
      // A malformed expression is the editor's problem to report, not this view's.
    }
  }
  upcoming.sort((a, b) => a.at.localeCompare(b.at));
  return c.json(upcoming.slice(0, 10));
});

api.get("/agents/:id/schedule", (c) => {
  const agent = getAgent(c.req.param("id"));
  if (!agent?.cron) return c.json({ error: "agent has no cron expression" }, 409);
  try {
    return c.json({ next: nextRuns(agent.cron, agent.cronTimezone) });
  } catch (e) {
    return c.json({ error: String(e) }, 400);
  }
});

/**
 * A delivery refused by a filter or event allowlist is the system working — and
 * with one URL fanning out to a space, most deliveries are refused that way. So
 * they are noise in any list meant to show problems.
 */
const BY_DESIGN =
  /filter|allowlist|ping acknowledged|url_verification|handshake|duplicate|another sender/i;
const isByDesign = (r: { reason: string | null }) => BY_DESIGN.test(r.reason ?? "");

/**
 * A space URL checks every member against the space's secret, so an agent whose
 * preset doesn't match the delivery refuses it — a `github` agent and a `token`
 * agent in one space each drop the other's traffic. Recording that as "bad
 * signature" reads like a wrong secret or someone probing the URL, which is what
 * the same refusal means on the agent's own URL. So it is named for what it is.
 */
const FAN_OUT_MISMATCH = /bad signature|no webhook secret/i;
const reasonFor = (reason: string, viaSpace: string | undefined) =>
  viaSpace && FAN_OUT_MISMATCH.test(reason) ? "another sender's delivery" : reason;

/**
 * The one drop an agent's own list is better off without: it says nothing about
 * this agent, and on a shared space URL it arrives with every delivery meant for
 * anyone else. Rows written before the drop had a name still say "bad signature",
 * so `viaSpace` decides those.
 */
const isCrossSender = (r: { accepted: boolean; reason: string | null; viaSpace: string | null }) =>
  !r.accepted &&
  (/another sender/i.test(r.reason ?? "") || (r.viaSpace !== null && FAN_OUT_MISMATCH.test(r.reason ?? "")));

/** Everything that reached this agent, minus the traffic that was never its own. */
api.get("/agents/:id/deliveries", (c) => {
  const rows = db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.agentId, c.req.param("id")))
    .orderBy(desc(webhookDeliveries.ts))
    .limit(200)
    .all();
  return c.json(rows.filter((r) => !isCrossSender(r)).slice(0, 20));
});

/**
 * A run's label comes from the agent's own template, in the same
 * `{{payload.a.b}}` syntax the prompt uses — so it works for any sender rather
 * than assuming a shape. Blank or unset means the run is simply unlabelled.
 */
function renderRunLabel(agent: Agent, payload: unknown): string | undefined {
  const template = agent.labelTemplate?.trim();
  if (!template) return undefined;
  const rendered = renderPrompt(template, payload).trim();
  return rendered.length > 0 ? rendered.slice(0, 200) : undefined;
}

type DeliveryOutcome =
  | { ok: true; agentId: string; runId: string; duplicate?: boolean; queued?: boolean }
  | { ok: false; agentId: string; status: number; reason: string };

/**
 * One agent's half of a delivery: verify, dedup, respect concurrency, run.
 * Shared so the per-agent URL and the space fan-out can't drift apart.
 */
function deliverToAgent(opts: {
  agent: Agent;
  rawBody: string;
  /** `rawBody` parsed once by the route; the signature is over the raw bytes, the label over this. */
  payload: unknown;
  headers: Record<string, string | undefined>;
  sourceIp?: string;
  deliveryKey?: string;
  /** Set when this came through a space's shared URL rather than the agent's own. */
  viaSpace?: string;
}): DeliveryOutcome {
  const { agent, rawBody, payload, headers, sourceIp, deliveryKey, viaSpace } = opts;
  const agentId = agent.id;
  const event = eventNameOf(presetFor(agent), headers);
  // GitHub's header names the family; the action in the body is what actually
  // distinguishes three `pull_request` deliveries on the same PR. Recorded that way.
  const action = payload && typeof payload === "object" ? (payload as { action?: unknown }).action : undefined;
  const shownEvent = event && typeof action === "string" ? `${event}.${action}` : event;
  // Named up front so a refusal can say what it refused, not just why.
  const label = renderRunLabel(agent, payload);
  const decision = decideDelivery({ agent, rawBody, headers });

  if (!decision.ok) {
    recordDelivery({ agentId, sourceIp, deliveryKey, event: shownEvent, label, viaSpace, accepted: false, reason: reasonFor(decision.reason, viaSpace) });
    return { ok: false, agentId, status: decision.status, reason: decision.reason };
  }

  const duplicate = alreadyDelivered(agentId, deliveryKey);
  if (duplicate) return { ok: true, agentId, runId: duplicate, duplicate: true };

  if (agent.concurrency === "skip" && agentHasActiveRun(agentId)) {
    recordDelivery({ agentId, sourceIp, deliveryKey, event: shownEvent, label, viaSpace, accepted: false, reason: "run already active" });
    return { ok: false, agentId, status: 409, reason: "agent already has an active run" };
  }

  let started: { runId: string; queued: boolean };
  try {
    started = requestRun({ agent, trigger: "webhook", prompt: decision.prompt, rawPayload: rawBody, ...(label ? { label } : {}) });
  } catch (e) {
    if (!(e instanceof QueueFullError)) throw e;
    recordDelivery({ agentId, sourceIp, deliveryKey, event: shownEvent, label, viaSpace, accepted: false, reason: "queue full" });
    return { ok: false, agentId, status: 429, reason: "queue full" };
  }
  recordDelivery({
    agentId, sourceIp, deliveryKey, event: shownEvent, label, viaSpace, accepted: true, runId: started.runId,
    ...(started.queued ? { reason: "queued" } : {}),
  });
  return { ok: true, agentId, runId: started.runId, queued: started.queued };
}

/**
 * Every header, lowercased, since which ones matter is per-agent configuration.
 * `?token=` stands in for `X-Bullpen-Token` for senders that can only be given a
 * URL, such as a GroupMe bot callback.
 */
function hookHeaders(c: Context): Record<string, string | undefined> {
  const headers = Object.fromEntries(
    [...c.req.raw.headers].map(([k, v]) => [k.toLowerCase(), v]),
  ) as Record<string, string | undefined>;
  headers["x-bullpen-token"] ??= c.req.query("token");
  return headers;
}

/**
 * One URL for a whole space: every enabled agent in it that verifies the
 * signature gets the delivery, and its own filters decide whether it runs. The
 * sender holds one secret, so each agent must be given that same secret — one
 * that doesn't match is simply skipped, which is what keeps this safe.
 */
api.post("/hooks/space/:key", async (c) => {
  const key = c.req.param("key");
  // The key is the space's stable hook id. A space name is still accepted, so
  // URLs handed out before ids existed keep working.
  const byId = db.select().from(spaceSecrets).where(eq(spaceSecrets.hookId, key)).get();
  const space = byId?.space ?? key;
  const headers = hookHeaders(c);
  const sourceIp = c.req.header("x-forwarded-for") ?? undefined;
  const rawBody = await c.req.text();

  let payload: Record<string, unknown> = {};
  try {
    payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }
  const deliveryKey =
    headers["x-bullpen-idempotency-key"] ??
    headers["x-github-delivery"] ??
    (typeof payload.event_id === "string" ? payload.event_id : undefined);

  // The space's own secret is what the sender signs with, so every agent is
  // checked against it. Without one, each falls back to its own — which is how
  // this behaved before the table existed.
  const shared = byId ?? db.select().from(spaceSecrets).where(eq(spaceSecrets.space, space)).get();
  const candidates = listAgents().filter(
    (a) => a.space === space && a.enabled && a.trigger === "webhook" && (shared ? true : a.webhookSecret),
  );
  // Same answer as a bad secret, so this can't be used to enumerate spaces.
  if (candidates.length === 0) return c.json({ error: "unauthorized" }, 401);

  const outcomes = candidates.map((agent) =>
    deliverToAgent({
      agent: shared ? { ...agent, webhookSecret: shared.secret } : agent,
      rawBody,
      payload,
      headers,
      sourceIp,
      deliveryKey,
      viaSpace: space,
    }),
  );

  // A secret that matches nobody is a real failure — let the sender see it.
  if (outcomes.every((o) => !o.ok && o.status === 401)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (outcomes.every((o) => !o.ok && o.reason === "ping acknowledged")) {
    return c.json({ ok: true }, 200);
  }

  return c.json(
    {
      ran: outcomes.filter((o) => o.ok).map((o) => ({ agentId: o.agentId, runId: o.runId })),
      skipped: outcomes.filter((o) => !o.ok).map((o) => ({ agentId: o.agentId, reason: o.reason })),
    },
    202,
  );
});

/**
 * The one endpoint reachable without a UI session, so it carries its own
 * per-agent secret. Raw bytes are read before any parsing: GitHub signs those.
 */
api.post("/hooks/:id", async (c) => {
  const agentId = c.req.param("id");
  const agent = getAgent(agentId);
  const headers = hookHeaders(c);
  const sourceIp = c.req.header("x-forwarded-for") ?? undefined;
  const headerDeliveryKey = headers["x-bullpen-idempotency-key"] ?? headers["x-github-delivery"];

  if (!agent) {
    // Same answer as a bad secret, so the endpoint can't enumerate agent ids.
    return c.json({ error: "unauthorized" }, 401);
  }

  const echo = handshakeSecret(agent, headers);
  if (echo) {
    db.update(agents).set({ webhookSecret: echo }).where(eq(agents.id, agentId)).run();
    recordDelivery({ agentId, sourceIp, deliveryKey: headerDeliveryKey, accepted: false, reason: "handshake accepted" });
    const preset = presetFor(agent);
    return c.body(null, 200, { [preset.handshakeHeader!]: echo });
  }

  const rawBody = await c.req.text();
  const preset = presetFor(agent);

  let payload: Record<string, unknown> = {};
  try {
    payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }
  // Slack repeats event_id across its retries, and puts it in the body.
  const deliveryKey =
    headerDeliveryKey ?? (typeof payload.event_id === "string" ? payload.event_id : undefined);

  const decision = decideDelivery({ agent, rawBody, headers });

  // Slack's URL check is a signed request like any other, so it only gets an
  // answer once decideDelivery has accepted the signature.
  const challenge = urlVerificationChallenge(preset, rawBody);
  if (challenge && decision.ok) {
    recordDelivery({ agentId, sourceIp, deliveryKey, accepted: false, reason: "url_verification" });
    return c.text(challenge, 200);
  }

  const outcome = deliverToAgent({ agent, rawBody, payload, headers, sourceIp, deliveryKey });
  if (!outcome.ok) return c.json({ error: outcome.reason }, outcome.status as 400);
  return c.json(
    outcome.duplicate
      ? { runId: outcome.runId, duplicate: true }
      : outcome.queued
        ? { runId: outcome.runId, queued: true }
        : { runId: outcome.runId },
    202,
  );
});

api.get("/agents/:id", (c) => {
  const agent = getAgent(c.req.param("id"));
  return agent ? c.json(redact(agent)) : c.json({ error: "not found" }, 404);
});

/** One place that turns a validated create payload into a row; import uses it too. */
function createAgentRecord(data: ReturnType<typeof agentCreateSchema.parse>): string {
  const { id: proposedId, webhookSecret: proposedSecret, ...values } = data;
  const id = proposedId ?? randomUUID();
  // A sender that does its own handshake picks the secret, so start empty and
  // let the handshake fill it in — minting one here would refuse that handshake.
  const awaitsHandshake = presetFor({ ...values, id } as never).handshakeHeader !== null;
  db.insert(agents)
    .values({
      id,
      ...values,
      workspaceKind: data.workspaceConfig.kind,
      webhookSecret: proposedSecret ?? (awaitsHandshake ? null : randomBytes(32).toString("base64url")),
    })
    .run();
  rescheduleAgent(id);
  return id;
}

api.post("/agents", async (c) => {
  const parsed = agentCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid agent", issues: parsed.error.issues }, 400);
  if (parsed.data.id && getAgent(parsed.data.id)) return c.json({ error: "agent id already exists" }, 409);
  const id = createAgentRecord(parsed.data);
  return c.json(redact(getAgent(id)!), 201);
});

/**
 * Agents as portable JSON: everything that defines one, nothing that is a
 * secret. Env keeps its keys with empty values so an importer knows what to
 * fill in; webhook secrets are omitted and minted fresh on import. Ids are kept,
 * so importing over an existing bullpen updates in place and per-agent webhook
 * URLs survive.
 */
const NOT_EXPORTED = new Set(["webhookSecret", "pollState", "pollStatus", "pollCheckedAt", "createdAt", "updatedAt", "workspaceKind"]);
api.post("/export", async (c) => {
  const body = await c.req.json<{ passphrase?: string }>().catch(() => ({}) as { passphrase?: string });
  const all = listAgents();
  const exported = all.map((a) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a)) if (!NOT_EXPORTED.has(k)) out[k] = v;
    out.env = Object.fromEntries(Object.keys(a.env as object).map((k) => [k, ""]));
    return out;
  });
  const result: Record<string, unknown> = { version: 1, exportedAt: new Date().toISOString(), agents: exported };

  // With a passphrase, the secrets ride along sealed — never in the clear, and
  // never without one. The passphrase itself is used here and forgotten.
  const passphrase = body.passphrase?.trim();
  if (passphrase) {
    const bundle: SecretsBundle = {
      agents: Object.fromEntries(
        all.map((a) => [a.id, { env: a.env as Record<string, string>, webhookSecret: a.webhookSecret }]),
      ),
      spaces: Object.fromEntries(
        db.select().from(spaceSecrets).all().map((s) => [
          s.space,
          { secret: s.secret, hookId: s.hookId, env: s.env as Record<string, string> },
        ]),
      ),
      global: globalEnv(),
      mcp: exportMachineMcp(),
    };
    result.secrets = seal(bundle, passphrase);
  }
  return c.json(result);
});

api.post("/import", async (c) => {
  const body = await c.req
    .json<{ version?: number; agents?: unknown[]; secrets?: SealedBundle; passphrase?: string }>()
    .catch(() => null);
  if (!body || !Array.isArray(body.agents)) return c.json({ error: "expected { agents: [...] }" }, 400);
  if (body.version !== undefined && body.version !== 1) return c.json({ error: `unsupported export version ${body.version}` }, 400);

  // Open the secrets first: a wrong passphrase should import nothing at all,
  // not leave agents created with their secrets missing.
  let secrets: SecretsBundle | null = null;
  let secretsNote: string | null = null;
  if (body.secrets) {
    const passphrase = body.passphrase?.trim();
    if (!passphrase) secretsNote = "file has secrets, but no passphrase was given — skipped";
    else {
      try {
        secrets = open(body.secrets, passphrase);
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : "could not open secrets" }, 400);
      }
    }
  }

  const created: string[] = [];
  const updated: string[] = [];
  const envNeeded: Record<string, string[]> = {};
  const errors: { name: string; issues: unknown }[] = [];

  for (const raw of body.agents) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name : "(unnamed)";
    const id = typeof item.id === "string" ? item.id : undefined;
    // Exported env carries keys only; those keys are reported, never written as blanks.
    const envKeys = item.env && typeof item.env === "object" ? Object.keys(item.env as object) : [];
    const { env: _env, ...rest } = item;
    if (rest.trigger === undefined) rest.trigger = inferTrigger(rest);
    if (rest.space == null || (typeof rest.space === "string" && rest.space.trim() === "")) rest.space = DEFAULT_SPACE;

    if (id && getAgent(id)) {
      const parsed = agentPatchSchema.safeParse(rest);
      if (!parsed.success) { errors.push({ name, issues: parsed.error.issues }); continue; }
      const patch = parsed.data;
      db.update(agents)
        .set({ ...patch, ...(patch.workspaceConfig ? { workspaceKind: patch.workspaceConfig.kind } : {}), updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(agents.id, id))
        .run();
      rescheduleAgent(id);
      updated.push(name);
    } else {
      const parsed = agentCreateSchema.safeParse({ ...rest, env: {} });
      if (!parsed.success) { errors.push({ name, issues: parsed.error.issues }); continue; }
      createAgentRecord(parsed.data);
      created.push(name);
      if (envKeys.length > 0) envNeeded[name] = envKeys;
    }
  }
  let secretsApplied: { agents: number; spaces: number; globalKeys: number; mcp: number } | null = null;
  let mcpNote: string | null = null;
  if (secrets) {
    let n = 0;
    for (const [id, s] of Object.entries(secrets.agents)) {
      if (!getAgent(id)) continue;
      db.update(agents)
        .set({ env: s.env, ...(s.webhookSecret ? { webhookSecret: s.webhookSecret } : {}) })
        .where(eq(agents.id, id))
        .run();
      delete envNeeded[getAgent(id)!.name];
      n++;
    }
    for (const [space, s] of Object.entries(secrets.spaces)) {
      db.insert(spaceSecrets)
        .values({ space, secret: s.secret, hookId: s.hookId, env: s.env })
        .onConflictDoUpdate({ target: spaceSecrets.space, set: { secret: s.secret, hookId: s.hookId, env: s.env } })
        .run();
    }
    setGlobalEnv({ ...globalEnv(), ...secrets.global });
    // MCP config lives in the Claude config dir, which is only bullpen's to write
    // in managed mode; on a laptop the export's servers are reported, not applied.
    let mcp = 0;
    const mcpCount = Object.keys(secrets.mcp ?? {}).length;
    if (mcpCount > 0) {
      try {
        mcp = importMachineMcp(secrets.mcp!);
      } catch (e) {
        mcpNote = `${mcpCount} MCP server${mcpCount === 1 ? "" : "s"} not imported: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    secretsApplied = { agents: n, spaces: Object.keys(secrets.spaces).length, globalKeys: Object.keys(secrets.global).length, mcp };
  }
  return c.json({ created, updated, envNeeded, errors, secretsApplied, secretsNote, mcpNote });
});

/** Suggested servers for a managed box: what is offered, what is installed, and applying a selection. */
api.get("/setup/mcp-catalog", (c) => c.json({ managed: Boolean(process.env.CLAUDE_CONFIG_DIR), entries: mcpCatalog() }));
api.post("/setup/mcp-catalog", async (c) => {
  const body = await c.req.json<{ keys?: string[] }>().catch(() => null);
  if (!Array.isArray(body?.keys)) return c.json({ error: "keys is required" }, 400);
  try {
    return c.json({ ...applyMcpCatalog(body.keys, { dataDir: config.dataDir }), entries: mcpCatalog() });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

api.get("/setup/skills", (c) => c.json(skillsState()));

api.get("/setup/claude-md", (c) => c.json(claudeMdState()));

api.put("/setup/claude-md", async (c) => {
  const body = await c.req.json<{ content?: string }>().catch(() => null);
  if (typeof body?.content !== "string") return c.json({ error: "content is required" }, 400);
  try {
    writeClaudeMd(body.content);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
  }
  return c.json(claudeMdState());
});

/**
 * Clones a skills repo beside the skills directory and points `skills` at the
 * directory inside it that holds them — the root, the path given, or the one
 * place they were found. Never replaces a skills directory that has content.
 */
api.post("/setup/skills", async (c) => {
  const body = await c.req.json<{ url?: string; path?: string }>().catch(() => null);
  const url = body?.url?.trim();
  if (!url || !/^(https?:\/\/|git@)/.test(url)) return c.json({ error: "a git URL is required" }, 400);
  const state = skillsState();
  // Replacing is fine where bullpen owns the directory; never over the user's own.
  if (state.count > 0 && !state.managed) {
    return c.json({ error: `${state.dir} is not managed by bullpen and already has ${state.count} skills` }, 409);
  }

  const checkout = join(claudeConfigDir(), "skills-repo");
  mkdirSync(claudeConfigDir(), { recursive: true });
  rmSync(checkout, { recursive: true, force: true });
  try {
    git(claudeConfigDir(), ["clone", "--depth", "1", url, checkout], 120_000);
  } catch (e) {
    return c.json({ error: `clone failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` }, 502);
  }

  let sub = body?.path?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  if (sub) {
    const target = resolve(checkout, sub);
    if (!target.startsWith(checkout + "/") && target !== checkout) return c.json({ error: "path escapes the repo" }, 400);
    if (skillDirsIn(target).length === 0) {
      return c.json({ error: `no skills at ${sub}`, candidates: findSkillRoots(checkout) }, 400);
    }
  } else {
    const roots = findSkillRoots(checkout);
    if (roots.length === 1) sub = roots[0] === "." ? "" : roots[0]!;
    else if (roots.length === 0) return c.json({ error: "no directories with a SKILL.md found in that repo" }, 400);
    else return c.json({ error: "skills found in more than one place — pick one", candidates: roots }, 400);
  }

  const src = sub ? join(checkout, sub) : checkout;
  if (existsSync(state.dir)) rmSync(state.dir, { recursive: true, force: true });
  symlinkSync(src, state.dir, "dir");
  return c.json(skillsState());
});

api.post("/setup/skills/pull", (c) => {
  const state = skillsState();
  if (!state.remote) return c.json({ error: "skills directory is not a git checkout" }, 409);
  try {
    git(state.dir, ["pull", "--ff-only"], 120_000);
  } catch (e) {
    return c.json({ error: `pull failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` }, 502);
  }
  return c.json(skillsState());
});

api.put("/setup/skills/refresh", async (c) => {
  const body = await c.req.json<{ hours?: number }>().catch(() => null);
  const hours = body?.hours;
  if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 0 || hours > 24 * 30) {
    return c.json({ error: "hours must be a whole number between 0 and 720" }, 400);
  }
  setSkillsRefreshHours(hours);
  startSkillsRefresh();
  return c.json(skillsState());
});

api.patch("/agents/:id", async (c) => {
  const id = c.req.param("id");
  const existing = getAgent(id);
  if (!existing) return c.json({ error: "not found" }, 404);

  const parsed = agentPatchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid agent", issues: parsed.error.issues }, 400);

  const patch = parsed.data;
  // An omitted env leaves the stored secrets alone; masked values sent back
  // from the UI would otherwise overwrite real ones with bullets.
  if (patch.env) patch.env = mergeMaskedEnv(existing.env as Record<string, string>, patch.env);

  db.update(agents)
    .set({
      ...patch,
      ...(patch.workspaceConfig ? { workspaceKind: patch.workspaceConfig.kind } : {}),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(agents.id, id))
    .run();
  rescheduleAgent(id);
  return c.json(redact(getAgent(id)!));
});

/**
 * What the server itself was started with — the shell, `.env`, or the container.
 * Names only: values would put every token the process holds into the browser.
 * The lowest env layer; anything set in bullpen overrides a name listed here.
 */
api.get("/config/process-env", (c) =>
  c.json({ names: Object.keys(process.env).filter((k) => k.length > 0).sort() }));

/** Global env: inherited by every agent, under its space's and its own. */
api.get("/config/env", (c) => c.json({ env: maskEnv(globalEnv()) }));

/**
 * An empty map over a non-empty one is refused unless the client says it meant
 * it: a UI that failed to load the current values and saved its blank editor
 * would otherwise wipe every shared secret in one click.
 */
function wouldWipe(current: Record<string, string>, next: Record<string, string>, force: unknown): boolean {
  return Object.keys(next).length === 0 && Object.keys(current).length > 0 && force !== true;
}

api.put("/config/env", async (c) => {
  const body = await c.req.json<{ env?: Record<string, string>; force?: boolean }>().catch(() => null);
  if (!body?.env || typeof body.env !== "object") return c.json({ error: "env object required" }, 400);
  if (wouldWipe(globalEnv(), body.env, body.force)) {
    return c.json({ error: "refusing to empty the global environment without force: true" }, 409);
  }
  setGlobalEnv(mergeMaskedEnv(globalEnv(), body.env));
  return c.json({ env: maskEnv(globalEnv()) });
});

api.get("/spaces/:name/env", (c) => c.json({ env: maskEnv(spaceEnv(c.req.param("name"))) }));

/**
 * Configuring env on a space that has no row yet creates one, which means
 * minting a webhook secret and id it may never use. Harmless: neither is ever
 * shown, and the URL answers nothing until a sender is given the secret.
 */
api.put("/spaces/:name/env", async (c) => {
  const space = c.req.param("name");
  const body = await c.req.json<{ env?: Record<string, string>; force?: boolean }>().catch(() => null);
  if (!body?.env || typeof body.env !== "object") return c.json({ error: "env object required" }, 400);
  if (wouldWipe(spaceEnv(space), body.env, body.force)) {
    return c.json({ error: "refusing to empty this space's environment without force: true" }, 409);
  }
  const env = mergeMaskedEnv(spaceEnv(space), body.env);
  db.insert(spaceSecrets)
    .values({ space, env, secret: randomBytes(32).toString("base64url"), hookId: randomUUID() })
    .onConflictDoUpdate({ target: spaceSecrets.space, set: { env } })
    .run();
  return c.json({ env: maskEnv(env) });
});

/** The palette the editor offers; anything else is refused so a typo can't render as nothing. */
const SPACE_ICONS = [
  "slate", "blue", "emerald", "amber", "rose", "violet", "dusk", "ocean", "moss",
];

api.get("/spaces/icons", (c) => {
  const rows = db.select({ space: spaceSecrets.space, icon: spaceSecrets.icon }).from(spaceSecrets).all();
  const icons: Record<string, string> = {};
  for (const r of rows) if (r.icon) icons[r.space] = r.icon;
  return c.json(icons);
});

/** Same row-minting trade as space env: setting an icon can create the secret early. */
api.put("/spaces/:name/icon", async (c) => {
  const space = c.req.param("name");
  const body = await c.req.json<{ icon?: unknown }>().catch(() => null);
  if (body === null) return c.json({ error: "expected a JSON body" }, 400);
  const icon = body.icon === null ? null : typeof body.icon === "string" ? body.icon : undefined;
  if (icon === undefined || (icon !== null && !SPACE_ICONS.includes(icon))) {
    return c.json({ error: `icon must be null or one of: ${SPACE_ICONS.join(", ")}` }, 400);
  }
  db.insert(spaceSecrets)
    .values({ space, icon, secret: randomBytes(32).toString("base64url"), hookId: randomUUID() })
    .onConflictDoUpdate({ target: spaceSecrets.space, set: { icon } })
    .run();
  return c.json({ icon });
});

/** The fan-out URL's own secret. Never returned — the UI can set or rotate, not read. */
api.get("/spaces/:name/secret", (c) => {
  const space = c.req.param("name");
  const row = db.select().from(spaceSecrets).where(eq(spaceSecrets.space, space)).get();
  // A row from before ids existed gets one here rather than on rotate: the id
  // carries no secret, and minting it must never cost the caller their secret.
  if (row && !row.hookId) {
    const hookId = randomUUID();
    db.update(spaceSecrets).set({ hookId }).where(eq(spaceSecrets.space, space)).run();
    return c.json({ configured: true, hookId });
  }
  return c.json({ configured: row !== undefined, hookId: row?.hookId ?? null });
});

api.post("/spaces/:name/secret", async (c) => {
  const space = c.req.param("name");
  const body = await c.req.json<{ secret?: string }>().catch(() => null);
  const pasted = body?.secret?.trim();
  if (pasted !== undefined && pasted.length > 0 && pasted.length < 16) {
    return c.json({ error: "secret must be at least 16 characters" }, 400);
  }
  const secret = pasted || randomBytes(32).toString("base64url");
  const existing = db.select().from(spaceSecrets).where(eq(spaceSecrets.space, space)).get();
  // Rotating a secret must not move the URL, so the id is kept once minted.
  const hookId = existing?.hookId ?? randomUUID();
  db.insert(spaceSecrets)
    .values({ space, secret, hookId })
    .onConflictDoUpdate({ target: spaceSecrets.space, set: { secret, hookId } })
    .run();
  return c.json({ secret, hookId });
});

api.delete("/spaces/:name/secret", (c) => {
  db.delete(spaceSecrets).where(eq(spaceSecrets.space, c.req.param("name"))).run();
  return c.json({ ok: true });
});

/**
 * Spaces are a GROUP BY over `agents.space`, not a table, so renaming one means
 * rewriting every member. Case-insensitive collision is rejected because two
 * spaces differing only by case render as two identical-looking chips. The
 * default space is fixed: it is where removed spaces' agents go.
 */
const isDefaultSpace = (name: string) => name.toLowerCase() === DEFAULT_SPACE.toLowerCase();

api.patch("/spaces/:name", async (c) => {
  const from = c.req.param("name");
  const body = await c.req.json<{ name?: unknown }>().catch(() => null);
  if (body === null) return c.json({ error: "expected a JSON body" }, 400);

  const to = typeof body.name === "string" ? body.name.trim() : "";
  if (to.length === 0 || to.length > 60) return c.json({ error: "name must be 1-60 characters" }, 400);
  if (isDefaultSpace(from)) return c.json({ error: `the ${DEFAULT_SPACE} space cannot be renamed` }, 400);
  if (isDefaultSpace(to)) return c.json({ error: `"${DEFAULT_SPACE}" is reserved` }, 409);

  const all = listAgents();
  const members = all.filter((a) => a.space === from);
  if (members.length === 0) return c.json({ error: "not found" }, 404);

  if (to.toLowerCase() !== from.toLowerCase()) {
    const clash = all.some((a) => a.space && a.space.toLowerCase() === to.toLowerCase());
    if (clash) return c.json({ error: `a space named "${to}" already exists` }, 409);
  }

  db.update(agents).set({ space: to }).where(eq(agents.space, from)).run();
  const carried = db.select().from(spaceSecrets).where(eq(spaceSecrets.space, from)).get();
  if (carried) {
    db.delete(spaceSecrets).where(eq(spaceSecrets.space, from)).run();
    const { space: _from, ...rest } = carried;
    db.insert(spaceSecrets)
      .values({ ...rest, space: to })
      .onConflictDoUpdate({ target: spaceSecrets.space, set: rest })
      .run();
  }
  if (defaultSpace() === from) setDefaultSpace(to);
  return c.json({ moved: members.length, name: to });
});

/** Removing a space moves its agents to the default one; its secret and env go with the space, not the agents. */
api.delete("/spaces/:name", (c) => {
  const name = c.req.param("name");
  if (isDefaultSpace(name)) return c.json({ error: `the ${DEFAULT_SPACE} space cannot be removed` }, 400);
  const members = listAgents().filter((a) => a.space === name);
  const hadRow = db.select().from(spaceSecrets).where(eq(spaceSecrets.space, name)).get() !== undefined;
  if (members.length === 0 && !hadRow) return c.json({ error: "not found" }, 404);
  db.update(agents).set({ space: DEFAULT_SPACE }).where(eq(agents.space, name)).run();
  db.delete(spaceSecrets).where(eq(spaceSecrets.space, name)).run();
  if (defaultSpace() === name) setDefaultSpace(null);
  return c.json({ moved: members.length, name: DEFAULT_SPACE });
});

/** Which space a cold load opens. Unset, each browser reopens whichever it used last. */
api.put("/spaces/:name/default", (c) => {
  const name = c.req.param("name");
  if (!isDefaultSpace(name) && !listAgents().some((a) => a.space === name)) {
    return c.json({ error: "not found" }, 404);
  }
  setDefaultSpace(name);
  return c.json({ defaultSpace: name });
});

api.delete("/spaces/:name/default", (c) => {
  if (defaultSpace() === c.req.param("name")) setDefaultSpace(null);
  return c.json({ defaultSpace: defaultSpace() });
});

api.post("/agents/:id/webhook-secret", (c) => {
  const id = c.req.param("id");
  if (!getAgent(id)) return c.json({ error: "not found" }, 404);
  const webhookSecret = randomBytes(32).toString("base64url");
  db.update(agents).set({ webhookSecret }).where(eq(agents.id, id)).run();
  return c.json({ webhookSecret });
});

/** Some senders issue the secret themselves — Slack's signing secret, say. */
api.put("/agents/:id/webhook-secret", async (c) => {
  const id = c.req.param("id");
  if (!getAgent(id)) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ webhookSecret?: string }>().catch(() => null);
  const webhookSecret = body?.webhookSecret?.trim();
  if (!webhookSecret || webhookSecret.length < 16) {
    return c.json({ error: "webhookSecret must be at least 16 characters" }, 400);
  }
  db.update(agents).set({ webhookSecret }).where(eq(agents.id, id)).run();
  return c.json({ ok: true });
});

/** Clears the secret so a sender that runs its own handshake can set one. */
api.delete("/agents/:id/webhook-secret", (c) => {
  const id = c.req.param("id");
  if (!getAgent(id)) return c.json({ error: "not found" }, 404);
  db.update(agents).set({ webhookSecret: null }).where(eq(agents.id, id)).run();
  return c.json({ ok: true });
});

/** Runs one poll now, so a new endpoint can be proved before waiting on cron. */
/** The poll editor's "Check now" before anything is saved: the draft's URL, headers and path, with the env a run would get. */
api.post("/poll/probe", async (c) => {
  const body = await c.req
    .json<{ url?: string; headers?: Record<string, string>; path?: string | null; space?: string | null; env?: Record<string, string> }>()
    .catch(() => null);
  if (!body?.url) return c.json({ error: "url is required" }, 400);
  try {
    const env = resolveEnv({ space: body.space ?? null, env: body.env ?? {} });
    return c.json(await probePoll({ url: body.url, headers: body.headers ?? {}, path: body.path ?? null, env }));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

api.post("/agents/:id/poll", async (c) => {
  const agent = getAgent(c.req.param("id"));
  if (!agent) return c.json({ error: "not found" }, 404);
  return c.json(await pollOnce(agent));
});

/** Forgets the last seen response, so the next poll primes again. */
api.delete("/agents/:id/poll-state", (c) => {
  const id = c.req.param("id");
  if (!getAgent(id)) return c.json({ error: "not found" }, 404);
  db.update(agents).set({ pollState: null, pollStatus: null }).where(eq(agents.id, id)).run();
  return c.json({ ok: true });
});

/** Fires the agent's own webhook the way an outside caller would. */
api.post("/agents/:id/test-fire", async (c) => {
  const agent = getAgent(c.req.param("id"));
  if (!agent?.webhookSecret) return c.json({ error: "not found" }, 404);
  const body = await c.req.text();
  const payload = body || "{}";

  const preset = presetFor(agent);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (preset.scheme === "slack") {
    const ts = String(Math.floor(Date.now() / 1000));
    headers["x-slack-request-timestamp"] = ts;
    headers[preset.signatureHeader] =
      `v0=${createHmac("sha256", agent.webhookSecret).update(`v0:${ts}:${payload}`).digest("hex")}`;
  } else {
    headers[preset.signatureHeader] =
      preset.scheme === "hmac"
        ? `${preset.signaturePrefix}${createHmac("sha256", agent.webhookSecret).update(payload).digest("hex")}`
        : agent.webhookSecret;
  }

  const event = (agent.webhookEvents as string[])[0];
  if (event && preset.eventHeader) headers[preset.eventHeader] = event;

  const res = await fetch(new URL(`/api/hooks/${agent.id}`, c.req.url), {
    method: "POST",
    headers,
    body: payload,
  });
  return c.json({ status: res.status, body: await res.json().catch(() => null) });
});

api.delete("/agents/:id", (c) => {
  const id = c.req.param("id");
  if (!getAgent(id)) return c.json({ error: "not found" }, 404);
  db.delete(agents).where(eq(agents.id, id)).run();
  rescheduleAgent(id);
  return c.json({ ok: true });
});

/**
 * Counts the client can't compute: /runs is capped, so "how many ran today" has
 * to be asked rather than derived from the page it already has.
 */
/** The paragraph bullpen appends to every run's system prompt, so the operator can read what agents are told. */
api.get("/system-prompt", (c) => {
  // The config-dir paragraph is conditional, so report it as null rather than
  // as prose every box gets: on a laptop `~/.claude` is right and saying so is noise.
  const configDir = noteworthyConfigDir();
  return c.json({
    files: SYSTEM_NOTE.files,
    delivery: SYSTEM_NOTE.delivery("webhook"),
    config: configDir ? SYSTEM_NOTE.config(configDir) : null,
  });
});

api.get("/stats", (c) => {
  const now = Math.floor(Date.now() / 1000);
  // `?space=` scopes the counters to that space's agents, so a space's landing
  // page reports its own day rather than the whole roster's.
  const space = c.req.query("space");
  const inSpace = space ? inArray(runs.agentId, db.select({ id: agents.id }).from(agents).where(eq(agents.space, space))) : undefined;
  const count = (...conds: (SQL | undefined)[]) =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(and(...conds.filter((x): x is SQL => x !== undefined), inSpace))
      .get()?.n ?? 0;

  const last24h = count(gte(runs.startedAt, now - 86_400));
  const prev24h = count(gte(runs.startedAt, now - 172_800), lt(runs.startedAt, now - 86_400));
  const failed24h = count(gte(runs.startedAt, now - 86_400), eq(runs.status, "failed"));

  // Micro-dollars in the column; the client wants dollars.
  const spend24h =
    (db
      .select({ n: sql<number>`coalesce(sum(cost_usd), 0)` })
      .from(runs)
      .where(and(gte(runs.startedAt, now - 86_400), inSpace))
      .get()?.n ?? 0) / 1_000_000;

  // Each agent's newest run, regardless of how many other agents ran since.
  // Derived from the capped /runs list this went wrong the moment one agent
  // was busy enough to push another's last run out of the window.
  const latest = db.all<{ agentId: string; id: string; status: string; startedAt: number }>(sql`
    select agent_id as agentId, id, status, started_at as startedAt
    from runs r
    where started_at = (select max(started_at) from runs where agent_id = r.agent_id)
  `);
  const active = db.all<{ agentId: string; n: number }>(sql`
    select agent_id as agentId, count(*) as n from runs
    where status in ('running', 'awaiting_approval') group by agent_id
  `);
  const queued = db.all<{ agentId: string; n: number }>(sql`
    select agent_id as agentId, count(*) as n from runs where status = 'queued' group by agent_id
  `);

  return c.json({
    last24h,
    prev24h,
    failed24h,
    spend24h,
    total: db.select({ n: sql<number>`count(*)` }).from(runs).get()?.n ?? 0,
    latest: Object.fromEntries(latest.map((r) => [r.agentId, r])),
    active: Object.fromEntries(active.map((r) => [r.agentId, r.n])),
    queued: Object.fromEntries(queued.map((r) => [r.agentId, r.n])),
  });
});

/**
 * Deliveries that were refused for a reason worth knowing about. A filter or
 * event-allowlist miss is the system working — with one URL fanning out to a
 * whole space, most deliveries are dropped by design — so those are excluded.
 */
/** Every delivery the space's shared URL fanned out, newest first. */
api.get("/spaces/:name/deliveries", (c) =>
  c.json(
    db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.viaSpace, c.req.param("name")))
      .orderBy(desc(webhookDeliveries.ts))
      .limit(25)
      .all(),
  ));

api.get("/deliveries", (c) => {
  // Bounded by age, not count: a standing list of problems already fixed is one
  // you learn to ignore, which is the opposite of what this is for.
  const hours = Number(c.req.query("hours") ?? 24);
  const since = Math.floor(Date.now() / 1000) - Math.max(1, hours) * 3600;
  const rows = db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.accepted, false), gte(webhookDeliveries.ts, since)))
    .orderBy(desc(webhookDeliveries.ts))
    .limit(200)
    .all();
  return c.json(rows.filter((r) => !isByDesign(r)).slice(0, 20));
});

api.get("/runs", (c) => {
  const agentId = c.req.query("agentId");
  const base = db.select().from(runs).orderBy(desc(runs.startedAt)).limit(50);
  return c.json(agentId ? base.where(eq(runs.agentId, agentId)).all() : base.all());
});

api.get("/runs/:id", (c) => {
  const run = db.select().from(runs).where(eq(runs.id, c.req.param("id"))).get();
  if (!run) return c.json({ error: "not found" }, 404);
  // A completed run keeps its session open, so it can still be talked to.
  return c.json({ run: { ...run, resumable: isResumable(run) }, events: eventsSince(run.id, 0) });
});

api.post("/agents/:id/run", async (c) => {
  const agent = getAgent(c.req.param("id"));
  if (!agent) return c.json({ error: "no such agent" }, 404);
  if (!agent.enabled) return c.json({ error: "agent is disabled" }, 409);
  if (agent.concurrency === "skip" && agentHasActiveRun(agent.id)) {
    return c.json({ error: "agent already has an active run" }, 409);
  }
  type RunBody = { prompt?: string; permissionMode?: string; ephemeral?: boolean };
  const body = await c.req.json<RunBody>().catch(() => ({}) as RunBody);
  if (body.permissionMode && !isPermissionMode(body.permissionMode)) {
    return c.json({ error: `unknown permission mode: ${body.permissionMode}` }, 400);
  }
  try {
    const { runId, queued } = requestRun({
      agent,
      trigger: "manual",
      ...(body.prompt ? { prompt: body.prompt } : {}),
      ...(body.permissionMode ? { permissionMode: body.permissionMode } : {}),
      ...(body.ephemeral ? { ephemeralWorkspace: true } : {}),
    });
    return c.json(queued ? { runId, queued: true } : { runId }, 202);
  } catch (err) {
    if (err instanceof QueueFullError) return c.json({ error: err.message }, 429);
    // A workspace that can't be prepared — missing directory, failed clone —
    // is the user's problem to see, not a bare 500.
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

api.post("/runs/:id/messages", async (c) => {
  const body = await c.req.json<{ text: string }>();
  const ok = sendToRun(c.req.param("id"), body.text);
  return ok ? c.json({ ok: true }) : c.json({ error: "run has no session to reply to" }, 409);
});

/** Git actions only make sense on a git workspace with a branch to push. */
function gitRun(id: string) {
  const run = db.select().from(runs).where(eq(runs.id, id)).get();
  if (!run?.workspacePath || !run.branch) return null;
  return run;
}

/** Files the run handed back through .bullpen/out, kept under the data dir after the workspace is gone. */
api.get("/runs/:id/artifacts", (c) => c.json(listArtifacts(c.req.param("id"))));

api.get("/runs/:id/artifacts/:name{.+}", async (c) => {
  const p = artifactPath(c.req.param("id"), c.req.param("name"));
  if (!p) return c.json({ error: "not found" }, 404);
  const base = basename(p);
  const file = await readFile(p);
  // `?inline=1` previews instead of downloading. An agent wrote this markup, and
  // it would otherwise render on the dashboard's own origin, so the response is
  // sandboxed: an opaque origin with no scripts, plugins, forms or top-level
  // navigation, and nosniff so a mislabelled file can't become something else.
  // Both headers are inline-only — a download has no origin to abuse, and
  // nosniff on one would stop the browser rendering a screenshot saved under an
  // extension `MIME` doesn't know, which is how `<img>` in the timeline works.
  const inline = c.req.query("inline") === "1" && INLINE_TYPES.has(extname(base).toLowerCase());
  return c.body(file, 200, {
    "content-type": mimeOf(base),
    "content-length": String(file.byteLength),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename="${base.replace(/"/g, "")}"`,
    ...(inline ? { "content-security-policy": "sandbox", "x-content-type-options": "nosniff" } : {}),
  });
});

/** The run as a file: a plain-text transcript, or `?format=json` for the run record plus every event. */
api.get("/runs/:id/export", (c) => {
  const run = db.select().from(runs).where(eq(runs.id, c.req.param("id"))).get();
  if (!run) return c.json({ error: "not found" }, 404);
  const agentName = getAgent(run.agentId)?.name ?? "agent";
  const events = eventsSince(run.id, 0);
  const json = c.req.query("format") === "json";
  const body = json
    ? JSON.stringify({ exportedAt: new Date().toISOString(), agent: { id: run.agentId, name: agentName }, run, events }, null, 2)
    : renderTranscript(run, agentName, events, claudeCredential().source === "api-key");
  return c.body(body, 200, {
    "content-type": json ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="${exportFilename(agentName, run, json ? "json" : "txt")}"`,
  });
});

api.get("/runs/:id/git", (c) => {
  const run = gitRun(c.req.param("id"));
  if (!run) return c.json({ error: "not a git workspace" }, 409);
  try {
    return c.json({ branch: run.branch, files: gitStatus(run.workspacePath!), diff: gitDiff(run.workspacePath!) });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

api.post("/runs/:id/git/commit", async (c) => {
  const run = gitRun(c.req.param("id"));
  if (!run) return c.json({ error: "not a git workspace" }, 409);
  const body = await c.req.json<{ message: string }>().catch(() => null);
  if (!body?.message) return c.json({ error: "message is required" }, 400);
  try {
    return c.json({ sha: gitCommit(run.workspacePath!, body.message) });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

api.post("/runs/:id/git/push", (c) => {
  const run = gitRun(c.req.param("id"));
  if (!run) return c.json({ error: "not a git workspace" }, 409);
  try {
    gitPush(run.workspacePath!, run.branch!);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

api.post("/runs/:id/git/pr", async (c) => {
  const run = gitRun(c.req.param("id"));
  if (!run) return c.json({ error: "not a git workspace" }, 409);
  const body = await c.req.json<{ title: string; body?: string }>().catch(() => null);
  if (!body?.title) return c.json({ error: "title is required" }, 400);
  try {
    const pr = await openPullRequest({
      cwd: run.workspacePath!,
      branch: run.branch!,
      title: body.title,
      ...(body.body ? { body: body.body } : {}),
    });
    return c.json(pr);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

api.get("/runs/:id/approvals", (c) => c.json(pendingApprovals(c.req.param("id"))));

api.post("/approvals/:approvalId", async (c) => {
  const body = await c.req
    .json<{ allow: boolean; reason?: string; answers?: Record<string, string | string[]> }>()
    .catch(() => null);
  if (!body || typeof body.allow !== "boolean") return c.json({ error: "allow must be a boolean" }, 400);
  const ok = decideApproval(c.req.param("approvalId"), body.allow, body.reason, body.answers);
  return ok ? c.json({ ok: true }) : c.json({ error: "no pending approval with that id" }, 409);
});

api.post("/runs/:id/permission-mode", async (c) => {
  const body = await c.req.json<{ mode: string }>().catch(() => null);
  if (!body?.mode) return c.json({ error: "mode is required" }, 400);
  if (!isPermissionMode(body.mode)) return c.json({ error: `unknown mode ${body.mode}` }, 400);
  const result = await setRunPermissionMode(c.req.param("id"), body.mode);
  if (result.ok) return c.json({ ok: true });
  return result.live
    ? c.json({ error: result.error ?? "the run refused that mode" }, 409)
    : c.json({ error: "run has no session to reply to" }, 409);
});

api.post("/runs/:id/stop", async (c) => {
  const ok = await stopRun(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "run has no session to reply to" }, 409);
});
