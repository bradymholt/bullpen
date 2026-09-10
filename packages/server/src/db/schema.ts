import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch())`;

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  model: text("model"),
  prompt: text("prompt").notNull().default(""),
  permissionMode: text("permission_mode").notNull().default("supervised"),

  workspaceKind: text("workspace_kind").notNull().default("persistent"),
  workspaceConfig: text("workspace_config", { mode: "json" }).notNull().default(sql`'{}'`),

  allowedTools: text("allowed_tools", { mode: "json" }).notNull().default(sql`'[]'`),
  disallowedTools: text("disallowed_tools", { mode: "json" }).notNull().default(sql`'[]'`),
  mcpServers: text("mcp_servers", { mode: "json" }).notNull().default(sql`'{}'`),
  inheritMachineMcp: integer("inherit_machine_mcp", { mode: "boolean" }).notNull().default(false),
  env: text("env", { mode: "json" }).notNull().default(sql`'{}'`),
  maxTurns: integer("max_turns"),

  cron: text("cron"),
  cronTimezone: text("cron_timezone"),
  webhookSecret: text("webhook_secret"),
  webhookMode: text("webhook_mode").notNull().default("token"),
  webhookEvents: text("webhook_events", { mode: "json" }).notNull().default(sql`'[]'`),
  allowPromptOverride: integer("allow_prompt_override", { mode: "boolean" }).notNull().default(false),
  concurrency: text("concurrency").notNull().default("skip"),

  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    trigger: text("trigger").notNull(),
    prompt: text("prompt").notNull(),
    title: text("title"),
    claudeSessionId: text("claude_session_id"),
    workspacePath: text("workspace_path"),
    branch: text("branch"),
    costUsd: integer("cost_usd"),
    numTurns: integer("num_turns"),
    error: text("error"),
    startedAt: integer("started_at").notNull().default(now),
    endedAt: integer("ended_at"),
  },
  (t) => [index("runs_agent_started_idx").on(t.agentId, t.startedAt)],
);

/** Append-only. The run timeline renders entirely from this table. */
export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    ts: integer("ts").notNull().default(now),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
  },
  (t) => [unique("run_events_run_seq_uq").on(t.runId, t.seq)],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    toolUseId: text("tool_use_id"),
    toolName: text("tool_name").notNull(),
    input: text("input", { mode: "json" }).notNull(),
    title: text("title"),
    description: text("description"),
    status: text("status").notNull().default("pending"),
    decidedAt: integer("decided_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("approvals_run_status_idx").on(t.runId, t.status)],
);

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    ts: integer("ts").notNull().default(now),
    sourceIp: text("source_ip"),
    deliveryKey: text("delivery_key"),
    event: text("event"),
    accepted: integer("accepted", { mode: "boolean" }).notNull(),
    reason: text("reason"),
    runId: text("run_id"),
  },
  (t) => [index("webhook_deliveries_agent_ts_idx").on(t.agentId, t.ts)],
);

export type Agent = typeof agents.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
