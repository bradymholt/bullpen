import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch())`;

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  /** A label for filtering the roster — "work", "personal". Not isolation. */
  space: text("space"),
  model: text("model"),
  prompt: text("prompt").notNull().default(""),
  permissionMode: text("permission_mode").notNull().default("supervised"),

  workspaceKind: text("workspace_kind").notNull().default("persistent"),
  workspaceConfig: text("workspace_config", { mode: "json" }).notNull().default(sql`'{}'`),

  allowedTools: text("allowed_tools", { mode: "json" }).notNull().default(sql`'[]'`),
  disallowedTools: text("disallowed_tools", { mode: "json" }).notNull().default(sql`'[]'`),
  mcpServers: text("mcp_servers", { mode: "json" }).notNull().default(sql`'{}'`),
  inheritMachineMcp: integer("inherit_machine_mcp", { mode: "boolean" }).notNull().default(false),
  /** With inheritMachineMcp on: null = every shared server (and connectors); a list = only these, passed explicitly. */
  sharedMcpPick: text("shared_mcp_pick", { mode: "json" }).$type<string[] | null>(),
  inheritUserSettings: integer("inherit_user_settings", { mode: "boolean" }).notNull().default(false),
  env: text("env", { mode: "json" }).notNull().default(sql`'{}'`),
  maxTurns: integer("max_turns"),

  pollUrl: text("poll_url"),
  pollHeaders: text("poll_headers", { mode: "json" }).notNull().default(sql`'{}'`),
  /** Dot path into a JSON response; blank hashes the whole body. */
  pollPath: text("poll_path"),
  /** Hash of the last response, so an unchanged endpoint costs no model turn. */
  pollState: text("poll_state"),
  pollStatus: text("poll_status"),
  pollCheckedAt: integer("poll_checked_at"),

  cron: text("cron"),
  cronTimezone: text("cron_timezone"),
  webhookSecret: text("webhook_secret"),
  /** Which of the four trigger cards the agent is on. Explicit — the old inference from other fields misfired. */
  trigger: text("trigger").notNull().default("manual"),
  webhookMode: text("webhook_mode").notNull().default("token"),
  webhookEvents: text("webhook_events", { mode: "json" }).notNull().default(sql`'[]'`),
  /** Superseded by `filters`; still read so old records keep working. */
  filterPath: text("filter_path"),
  filterValues: text("filter_values", { mode: "json" }).notNull().default(sql`'[]'`),
  /** `[{ path, op, values }]`, ANDed. Empty means no payload filtering. */
  filters: text("filters", { mode: "json" }).notNull().default(sql`'[]'`),
  /** Template rendered per run to name it in lists, e.g. "{{payload.repository.full_name}} #{{payload.number}}". */
  labelTemplate: text("label_template"),
  webhookSignatureHeader: text("webhook_signature_header"),
  webhookSignaturePrefix: text("webhook_signature_prefix"),
  concurrency: text("concurrency").notNull().default("skip"),

  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

/**
 * A space is otherwise a GROUP BY over `agents.space`, not an entity. This is a
 * narrow side table, not a spaces table: it exists only so the fan-out URL has
 * one secret instead of N copies that have to be kept in sync by hand.
 */
export const spaceSecrets = sqliteTable("space_secrets", {
  space: text("space").primaryKey(),
  /** Stable id for the shared webhook URL, so renaming the space can't break it. */
  hookId: text("hook_id"),
  secret: text("secret").notNull(),
  /** Env every agent in the space inherits; the agent's own wins on a clash. */
  env: text("env", { mode: "json" }).notNull().default(sql`'{}'`),
  createdAt: integer("created_at").notNull().default(now),
});

/**
 * One row. Env every agent inherits before its space's and its own — the
 * place for a headless box's shared secrets, so `.env` only has to bootstrap.
 */
export const globalConfig = sqliteTable("global_config", {
  id: integer("id").primaryKey(),
  env: text("env", { mode: "json" }).notNull().default(sql`'{}'`),
  /** Hours between background skills pulls; 0 turns the timer off. */
  skillsRefreshHours: integer("skills_refresh_hours").notNull().default(24),
});

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    trigger: text("trigger").notNull(),
    /** Effective mode for this run: the agent's, an override, or a mid-run change. */
    permissionMode: text("permission_mode"),
    prompt: text("prompt").notNull(),
    title: text("title"),
    claudeSessionId: text("claude_session_id"),
    workspacePath: text("workspace_path"),
    branch: text("branch"),
    costUsd: integer("cost_usd"),
    /** What this run is about, from the agent's labelTemplate. Null when unset. */
    label: text("label"),
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
    /** What the delivery was about, from the agent's labelTemplate — so a drop names the thing it dropped. */
    label: text("label"),
    /** The space whose shared URL this arrived on; null when sent to the agent's own URL. */
    viaSpace: text("via_space"),
    runId: text("run_id"),
  },
  (t) => [index("webhook_deliveries_agent_ts_idx").on(t.agentId, t.ts)],
);

export type Agent = typeof agents.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
