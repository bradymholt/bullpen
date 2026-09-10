import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { config, detectClaudeCredential } from "../config.ts";
import { db } from "../db/index.ts";
import { runs } from "../db/schema.ts";
import { eventsSince } from "../runs/eventLog.ts";
import { getAgent, listAgents, sendToRun, startRun, stopRun } from "../runs/RunManager.ts";

export const api = new Hono();

api.get("/health", (c) => {
  const credential = detectClaudeCredential();
  return c.json({ ok: credential.source !== "none", dataDir: config.dataDir, claudeCredential: credential });
});

api.get("/agents", (c) => c.json(listAgents()));

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
