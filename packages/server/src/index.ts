import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { config, detectClaudeCredential } from "./config.ts";
import { runMigrations } from "./db/migrate.ts";
import { hub } from "./hub.ts";
import { api } from "./routes/api.ts";
import { eventsSince } from "./runs/eventLog.ts";
import { recoverOrphanedRuns, shutdownLiveRuns } from "./runs/RunManager.ts";
import { seedScratchAgent } from "./seed.ts";
import { startScheduler, stopScheduler } from "./triggers/cron.ts";

process.on("unhandledRejection", (reason) => {
  console.error("[bullpen] unhandled rejection:", reason);
});

runMigrations();
const recovered = recoverOrphanedRuns();
if (recovered > 0) console.warn(`[bullpen] marked ${recovered} orphaned run(s) interrupted`);
seedScratchAgent();
const scheduled = startScheduler();
if (scheduled > 0) console.log(`[bullpen] scheduled ${scheduled} cron agent(s)`);

const app = new Hono();
app.route("/api", api);

const webDist = resolve(import.meta.dirname, "../../web/dist");
if (existsSync(webDist)) {
  app.use("/*", serveStatic({ root: webDist }));
  app.get("/*", serveStatic({ path: "index.html", root: webDist }));
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  const credential = detectClaudeCredential();
  console.log(`[bullpen] listening on http://localhost:${info.port}`);
  console.log(`[bullpen] data dir ${config.dataDir}`);
  console.log(
    credential.source === "none"
      ? `[bullpen] no Claude credential: ${credential.detail}`
      : `[bullpen] claude credential: ${credential.source} (${credential.detail})`,
  );
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg: { type?: string; runId?: string; sinceSeq?: number };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type !== "subscribe" || !msg.runId) return;

    hub.unsubscribeSocket(ws);
    // Replay first, then live: a client that drops mid-run resumes exactly
    // where it left off, and never sees an event twice.
    for (const e of eventsSince(msg.runId, msg.sinceSeq ?? 0)) {
      ws.send(
        JSON.stringify({
          type: "event",
          runId: e.runId,
          seq: e.seq,
          ts: e.ts,
          eventType: e.type,
          payload: e.payload,
        }),
      );
    }
    hub.subscribe(ws, msg.runId);
  });

  ws.on("close", () => hub.unsubscribeSocket(ws));
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void (async () => {
      stopScheduler();
      const stopped = await shutdownLiveRuns();
      if (stopped > 0) console.log(`[bullpen] stopped ${stopped} live run(s) on ${signal}`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    })();
  });
}
