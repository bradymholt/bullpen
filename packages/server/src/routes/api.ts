import { randomBytes, randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { agentInputSchema, agentPatchSchema } from "../agentSchema.ts";
import { config, detectClaudeCredential } from "../config.ts";
import { db } from "../db/index.ts";
import { agents, runs, type Agent } from "../db/schema.ts";
import { eventsSince } from "../runs/eventLog.ts";
import {
  agentHasActiveRun,
  getAgent,
  listAgents,
  sendToRun,
  startRun,
  stopRun,
} from "../runs/RunManager.ts";

export const api = new Hono();

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

api.get("/agents/:id", (c) => {
  const agent = getAgent(c.req.param("id"));
  return agent ? c.json(redact(agent)) : c.json({ error: "not found" }, 404);
});

api.post("/agents", async (c) => {
  const parsed = agentInputSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid agent", issues: parsed.error.issues }, 400);

  const id = randomUUID();
  db.insert(agents)
    .values({
      id,
      ...parsed.data,
      workspaceKind: parsed.data.workspaceConfig.kind,
      webhookSecret: randomBytes(32).toString("base64url"),
    })
    .run();
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
  return c.json(redact(getAgent(id)!));
});

api.delete("/agents/:id", (c) => {
  const id = c.req.param("id");
  if (!getAgent(id)) return c.json({ error: "not found" }, 404);
  db.delete(agents).where(eq(agents.id, id)).run();
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
  const body = await c.req.json<{ prompt?: string }>().catch(() => ({}) as { prompt?: string });
  const runId = startRun({ agent, trigger: "manual", ...(body.prompt ? { prompt: body.prompt } : {}) });
  return c.json({ runId }, 202);
});

api.post("/runs/:id/messages", async (c) => {
  const body = await c.req.json<{ text: string }>();
  const ok = sendToRun(c.req.param("id"), body.text);
  return ok ? c.json({ ok: true }) : c.json({ error: "run is not live" }, 409);
});

api.post("/runs/:id/stop", async (c) => {
  const ok = await stopRun(c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "run is not live" }, 409);
});
