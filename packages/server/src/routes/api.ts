import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
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
import { agents, runs, webhookDeliveries, type Agent } from "../db/schema.ts";
import { eventsSince } from "../runs/eventLog.ts";
import { decideApproval, pendingApprovals } from "../runs/approvals.ts";
import {
  agentHasActiveRun,
  getAgent,
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

api.get("/agents/:id/schedule", (c) => {
  const agent = getAgent(c.req.param("id"));
  if (!agent?.cron) return c.json({ error: "agent has no cron expression" }, 409);
  try {
    return c.json({ next: nextRuns(agent.cron, agent.cronTimezone) });
  } catch (e) {
    return c.json({ error: String(e) }, 400);
  }
});

api.get("/agents/:id/deliveries", (c) =>
  c.json(
    db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.agentId, c.req.param("id")))
      .orderBy(desc(webhookDeliveries.ts))
      .limit(20)
      .all(),
  ));

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

  const event = eventNameOf(preset, headers);

  if (!decision.ok) {
    recordDelivery({
      agentId,
      sourceIp,
      deliveryKey,
      event,
      accepted: false,
      reason: decision.reason,
    });
    return c.json({ error: decision.reason }, decision.status as 400);
  }

  const duplicate = alreadyDelivered(agentId, deliveryKey);
  if (duplicate) return c.json({ runId: duplicate, duplicate: true }, 202);

  if (agent.concurrency === "skip" && agentHasActiveRun(agentId)) {
    recordDelivery({ agentId, sourceIp, deliveryKey, accepted: false, reason: "run already active" });
    return c.json({ error: "agent already has an active run" }, 409);
  }

  const runId = startRun({
    agent,
    trigger: "webhook",
    prompt: decision.prompt,
    onWorkspace: (path) => writePayload(path, rawBody),
  });
  recordDelivery({
    agentId,
    sourceIp,
    deliveryKey,
    event,
    accepted: true,
    runId,
  });
  return c.json({ runId }, 202);
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

api.get("/runs", (c) => {
  const agentId = c.req.query("agentId");
  const base = db.select().from(runs).orderBy(desc(runs.startedAt)).limit(50);
  return c.json(agentId ? base.where(eq(runs.agentId, agentId)).all() : base.all());
});

api.get("/runs/:id", (c) => {
  const run = db.select().from(runs).where(eq(runs.id, c.req.param("id"))).get();
  if (!run) return c.json({ error: "not found" }, 404);
  return c.json({ run, events: eventsSince(run.id, 0) });
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
