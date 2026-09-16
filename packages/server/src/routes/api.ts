import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { agentCreateSchema, agentPatchSchema } from "../agentSchema.ts";
import { nextRuns, rescheduleAgent } from "../triggers/cron.ts";
import { pollOnce } from "../triggers/poll.ts";
import {
  alreadyDelivered,
  decideDelivery,
  eventNameOf,
  handshakeSecret,
  presetFor,
  recordDelivery,
  renderPrompt,
  urlVerificationChallenge,
  writePayload,
} from "../triggers/webhook.ts";
import { config, detectClaudeCredential } from "../config.ts";
import { readMachineMcp } from "../machineMcp.ts";
import { listRepos } from "../github.ts";
import { listSkills } from "../skills.ts";
import {
  commit as gitCommit,
  diff as gitDiff,
  openPullRequest,
  push as gitPush,
  status as gitStatus,
} from "../git.ts";
import { db } from "../db/index.ts";
import { agents, runs, spaceSecrets, webhookDeliveries, type Agent } from "../db/schema.ts";
import { eventsSince } from "../runs/eventLog.ts";
import { decideApproval, pendingApprovals } from "../runs/approvals.ts";
import {
  agentHasActiveRun,
  getAgent,
  isActive,
  isPermissionMode,
  listAgents,
  sendToRun,
  setRunPermissionMode,
  startRun,
  stopRun,
} from "../runs/RunManager.ts";

export const api = new Hono();

api.get("/machine-mcp", (c) => c.json(readMachineMcp()));

api.get("/skills", (c) => c.json(listSkills()));
api.get("/github/repos", async (c) => {
  try {
    return c.json(await listRepos(c.req.query("refresh") === "1"));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

api.get("/health", (c) => {
  const credential = detectClaudeCredential();
  return c.json({ ok: credential.source !== "none", dataDir: config.dataDir, claudeCredential: credential });
});

/** Secret env values never leave the server; the UI can set or clear, not read. */
function redact(agent: Agent): Agent {
  const env = agent.env as Record<string, string>;
  const masked = Object.fromEntries(Object.keys(env).map((k) => [k, "\u2022\u2022\u2022\u2022"]));
  return { ...agent, env: masked };
}

api.get("/agents", (c) => c.json(listAgents().map(redact)));

/** The whole roster's upcoming cron fires, flattened — the home view's "up next". */
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
const BY_DESIGN = /filter|allowlist|ping acknowledged|url_verification|handshake|duplicate/i;
const isByDesign = (reason: string | null) => BY_DESIGN.test(reason ?? "");

/**
 * `?all=1` includes deliveries refused by this agent's own filters, which is
 * what you want when working out why it didn't run. By default they are left
 * out: they arrive constantly on a shared space URL and would bury everything.
 */
api.get("/agents/:id/deliveries", (c) => {
  const rows = db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.agentId, c.req.param("id")))
    .orderBy(desc(webhookDeliveries.ts))
    .limit(200)
    .all();
  const all = c.req.query("all") === "1";
  return c.json((all ? rows : rows.filter((r) => r.accepted || !isByDesign(r.reason))).slice(0, 20));
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
  | { ok: true; agentId: string; runId: string; duplicate?: boolean }
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
  // Named up front so a refusal can say what it refused, not just why.
  const label = renderRunLabel(agent, payload);
  const decision = decideDelivery({ agent, rawBody, headers });

  if (!decision.ok) {
    recordDelivery({ agentId, sourceIp, deliveryKey, event, label, viaSpace, accepted: false, reason: decision.reason });
    return { ok: false, agentId, status: decision.status, reason: decision.reason };
  }

  const duplicate = alreadyDelivered(agentId, deliveryKey);
  if (duplicate) return { ok: true, agentId, runId: duplicate, duplicate: true };

  if (agent.concurrency === "skip" && agentHasActiveRun(agentId)) {
    recordDelivery({ agentId, sourceIp, deliveryKey, event, label, viaSpace, accepted: false, reason: "run already active" });
    return { ok: false, agentId, status: 409, reason: "agent already has an active run" };
  }

  const runId = startRun({
    agent,
    trigger: "webhook",
    prompt: decision.prompt,
    ...(label ? { label } : {}),
    onWorkspace: (path) => writePayload(path, rawBody),
  });
  recordDelivery({ agentId, sourceIp, deliveryKey, event, label, viaSpace, accepted: true, runId });
  return { ok: true, agentId, runId };
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
  const headers = Object.fromEntries(
    [...c.req.raw.headers].map(([k, v]) => [k.toLowerCase(), v]),
  ) as Record<string, string | undefined>;
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
    (a) => a.space === space && a.enabled && (shared ? true : a.webhookSecret),
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
  // Every header, since which ones matter is now per-agent configuration.
  const headers = Object.fromEntries(
    [...c.req.raw.headers].map(([k, v]) => [k.toLowerCase(), v]),
  ) as Record<string, string | undefined>;
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
    outcome.duplicate ? { runId: outcome.runId, duplicate: true } : { runId: outcome.runId },
    202,
  );
});

api.get("/agents/:id", (c) => {
  const agent = getAgent(c.req.param("id"));
  return agent ? c.json(redact(agent)) : c.json({ error: "not found" }, 404);
});

api.post("/agents", async (c) => {
  const parsed = agentCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid agent", issues: parsed.error.issues }, 400);

  const { id: proposedId, webhookSecret: proposedSecret, ...values } = parsed.data;
  const id = proposedId ?? randomUUID();
  if (proposedId && getAgent(proposedId)) return c.json({ error: "agent id already exists" }, 409);

  // A sender that does its own handshake picks the secret, so start empty and
  // let the handshake fill it in — minting one here would refuse that handshake.
  const awaitsHandshake = presetFor({ ...values, id } as never).handshakeHeader !== null;

  db.insert(agents)
    .values({
      id,
      ...values,
      workspaceKind: parsed.data.workspaceConfig.kind,
      webhookSecret: proposedSecret ?? (awaitsHandshake ? null : randomBytes(32).toString("base64url")),
    })
    .run();
  rescheduleAgent(id);
  return c.json(redact(getAgent(id)!), 201);
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
  if (patch.env) {
    const current = existing.env as Record<string, string>;
    patch.env = Object.fromEntries(
      Object.entries(patch.env).map(([k, v]) => [k, /^\u2022+$/.test(v) ? (current[k] ?? "") : v]),
    );
  }

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
 * rewriting every member — and clearing it is the same call with a null target.
 * Case-insensitive collision is rejected because two spaces differing only by
 * case render as two identical-looking chips.
 */
api.patch("/spaces/:name", async (c) => {
  const from = c.req.param("name");
  const body = await c.req.json<{ name?: string | null }>().catch(() => null);
  if (body === null) return c.json({ error: "expected a JSON body" }, 400);

  const raw = body.name;
  const to = typeof raw === "string" ? raw.trim() : null;
  if (to !== null && (to.length === 0 || to.length > 60)) {
    return c.json({ error: "name must be 1-60 characters, or null to unassign" }, 400);
  }

  const all = listAgents();
  const members = all.filter((a) => a.space === from);
  if (members.length === 0) return c.json({ error: "not found" }, 404);

  if (to !== null && to.toLowerCase() !== from.toLowerCase()) {
    const clash = all.some((a) => a.space && a.space.toLowerCase() === to.toLowerCase());
    if (clash) return c.json({ error: `a space named "${to}" already exists` }, 409);
  }

  db.update(agents).set({ space: to }).where(eq(agents.space, from)).run();
  const carried = db.select().from(spaceSecrets).where(eq(spaceSecrets.space, from)).get();
  if (carried) {
    db.delete(spaceSecrets).where(eq(spaceSecrets.space, from)).run();
    // A null target unassigns everyone, so there is no space left to carry it to.
    if (to !== null) {
      db.insert(spaceSecrets)
        .values({ space: to, secret: carried.secret })
        .onConflictDoUpdate({ target: spaceSecrets.space, set: { secret: carried.secret } })
        .run();
    }
  }
  return c.json({ moved: members.length, name: to });
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
api.get("/stats", (c) => {
  const now = Math.floor(Date.now() / 1000);
  const since = (seconds: number) =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(gte(runs.startedAt, now - seconds))
      .get()?.n ?? 0;

  const last24h = since(86_400);
  const prev24h = Math.max(
    0,
    (db
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(and(gte(runs.startedAt, now - 172_800), lt(runs.startedAt, now - 86_400)))
      .get()?.n ?? 0),
  );
  const failed24h =
    db
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(and(gte(runs.startedAt, now - 86_400), eq(runs.status, "failed")))
      .get()?.n ?? 0;

  // Micro-dollars in the column; the client wants dollars.
  const spend24h =
    (db
      .select({ n: sql<number>`coalesce(sum(cost_usd), 0)` })
      .from(runs)
      .where(gte(runs.startedAt, now - 86_400))
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

  return c.json({
    last24h,
    prev24h,
    failed24h,
    spend24h,
    total: db.select({ n: sql<number>`count(*)` }).from(runs).get()?.n ?? 0,
    latest: Object.fromEntries(latest.map((r) => [r.agentId, r])),
    active: Object.fromEntries(active.map((r) => [r.agentId, r.n])),
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
  return c.json(rows.filter((r) => !isByDesign(r.reason)).slice(0, 20));
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
  return c.json({ run: { ...run, resumable: isActive(run.id) }, events: eventsSince(run.id, 0) });
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
    const runId = startRun({
      agent,
      trigger: "manual",
      ...(body.prompt ? { prompt: body.prompt } : {}),
      ...(body.permissionMode ? { permissionMode: body.permissionMode } : {}),
      ...(body.ephemeral ? { ephemeralWorkspace: true } : {}),
    });
    return c.json({ runId }, 202);
  } catch (err) {
    // A workspace that can't be prepared — missing directory, failed clone —
    // is the user's problem to see, not a bare 500.
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

api.post("/runs/:id/messages", async (c) => {
  const body = await c.req.json<{ text: string }>();
  const ok = sendToRun(c.req.param("id"), body.text);
  return ok ? c.json({ ok: true }) : c.json({ error: "run is not live" }, 409);
});

/** Git actions only make sense on a git workspace with a branch to push. */
function gitRun(id: string) {
  const run = db.select().from(runs).where(eq(runs.id, id)).get();
  if (!run?.workspacePath || !run.branch) return null;
  return run;
}

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
    : c.json({ error: "run is not live" }, 409);
});

api.post("/runs/:id/stop", async (c) => {
  const ok = await stopRun(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "run is not live" }, 409);
});
