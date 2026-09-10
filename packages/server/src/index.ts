import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { config, detectClaudeCredential } from "./config.ts";
import { runMigrations } from "./db/migrate.ts";

process.on("unhandledRejection", (reason) => {
  console.error("[bullpen] unhandled rejection:", reason);
});

runMigrations();

const app = new Hono();

app.get("/api/health", (c) => {
  const credential = detectClaudeCredential();
  return c.json({
    ok: credential.source !== "none",
    dataDir: config.dataDir,
    claudeCredential: credential,
  });
});

const webDist = resolve(import.meta.dirname, "../../web/dist");
if (existsSync(webDist)) {
  app.use("/*", serveStatic({ root: webDist }));
  app.get("/*", serveStatic({ path: "index.html", root: webDist }));
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  const credential = detectClaudeCredential();
  console.log(`[bullpen] listening on http://localhost:${info.port}`);
  console.log(`[bullpen] data dir ${config.dataDir}`);
  if (credential.source === "none") {
    console.warn(`[bullpen] no Claude credential: ${credential.detail}`);
  } else {
    console.log(`[bullpen] claude credential: ${credential.source} (${credential.detail})`);
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "hello" }));
});
