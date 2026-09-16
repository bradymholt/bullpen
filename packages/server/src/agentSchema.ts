import { z } from "zod";

const mcpStdio = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().positive().optional(),
  alwaysLoad: z.boolean().optional(),
});
const mcpRemote = z.object({
  type: z.enum(["http", "sse"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  timeout: z.number().int().positive().optional(),
  alwaysLoad: z.boolean().optional(),
});

/** Mirrors the SDK's McpServerConfig union so bad config fails at save, not mid-run. */
export const mcpServersSchema = z.record(z.string(), z.union([mcpStdio, mcpRemote]));

/** ANDed payload conditions, checked before a run starts. */
export const filterConditionSchema = z.object({
  path: z.string().min(1).max(200),
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string().max(200)).min(1).max(100),
});

/** `persistent` and `git` are the old spellings of `scratch` and `clone`. */
export const workspaceConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scratch") }),
  /** A fresh directory per run, deleted after — what lets an agent run in parallel. */
  z.object({ kind: z.literal("ephemeral") }),
  z.object({ kind: z.literal("persistent") }),
  z.object({ kind: z.literal("existing"), path: z.string().min(1) }),
  z.object({
    kind: z.literal("clone"),
    repoUrl: z.string().min(1),
    baseBranch: z.string().optional(),
  }),
  z.object({
    kind: z.literal("git"),
    repoUrl: z.string().min(1),
    baseBranch: z.string().optional(),
  }),
]);

/**
 * Declared without defaults so a PATCH can't resurrect them: zod applies a
 * field's default even under .partial(), which would let a rename of one
 * field quietly reset an agent's permission mode and tool lists.
 */
const fields = {
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  space: z.string().trim().max(60).nullish(),
  model: z.string().max(120).nullish(),
  prompt: z.string(),
  permissionMode: z.enum(["supervised", "acceptEdits", "plan", "auto", "full", "locked"]),
  workspaceConfig: workspaceConfigSchema,
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()),
  mcpServers: mcpServersSchema,
  inheritMachineMcp: z.boolean(),
  inheritUserSettings: z.boolean(),
  env: z.record(z.string(), z.string()),
  maxTurns: z.number().int().positive().nullish(),
  pollUrl: z.string().url().max(2000).nullish(),
  pollHeaders: z.record(z.string(), z.string()),
  pollPath: z.string().max(200).nullish(),
  cron: z.string().max(120).nullish(),
  cronTimezone: z.string().max(120).nullish(),
  // "hmac" is the pre-preset spelling of "github"; kept so old records round-trip.
  webhookMode: z.enum(["token", "github", "slack", "asana", "custom", "hmac"]),
  filterPath: z.string().max(200).nullish(),
  filterValues: z.array(z.string().max(200)).max(100),
  filters: z.array(filterConditionSchema).max(10),
  webhookSignatureHeader: z.string().max(120).nullish(),
  webhookSignaturePrefix: z.string().max(40).nullish(),
  webhookEvents: z.array(z.string()),
  concurrency: z.enum(["skip", "allow"]),
  enabled: z.boolean(),
};

/**
 * Cautious by default, with one deliberate exception: `auto` rather than
 * `supervised`, because an unattended run that stops for approval never
 * resumes — there is no prompt timeout and no one watching a cron fire.
 */
export const AGENT_DEFAULTS = {
  prompt: "",
  permissionMode: "auto",
  workspaceConfig: { kind: "ephemeral" },
  allowedTools: [],
  disallowedTools: [],
  mcpServers: {},
  inheritMachineMcp: false,
  inheritUserSettings: true,
  env: {},
  pollHeaders: {},
  webhookMode: "custom",
  webhookEvents: [],
  filterValues: [],
  filters: [],
  concurrency: "allow",
  enabled: true,
} as const;

/**
 * Fields the server owns. Clients round-trip whole agent records, so these
 * arrive on every save; dropping them here leaves the strict check flagging
 * actual mistakes rather than normal traffic.
 */
const SERVER_OWNED = [
  "id",
  "workspaceKind",
  "webhookSecret",
  "createdAt",
  "updatedAt",
  "pollState",
  "pollStatus",
  "pollCheckedAt",
] as const;

function stripFields(value: unknown, keys: readonly string[]): unknown {
  if (!value || typeof value !== "object") return value;
  const copy = { ...(value as Record<string, unknown>) };
  for (const key of keys) delete copy[key];
  return copy;
}

const withoutServerFields = (value: unknown) => stripFields(value, SERVER_OWNED);

/**
 * Create is the one place a client may name the id and secret: the editor
 * shows both before the agent exists, and they have to survive the save.
 */
const CREATE_OWNED = SERVER_OWNED.filter((k) => k !== "id" && k !== "webhookSecret");
const withoutServerFieldsOnCreate = (value: unknown) => stripFields(value, CREATE_OWNED);

// Unknown keys are rejected rather than stripped: a misspelled field should
// not look like it saved and then quietly do nothing.
const base = z.object(fields).strict();

export const agentCreateSchema = z.preprocess(
  withoutServerFieldsOnCreate,
  base.partial().required({ name: true }).extend({
    id: z.uuid().optional(),
    // Either the 43-char base64url the server mints or a secret the sender
    // issued — Slack's signing secret is 32 hex, so shape can't be assumed.
    webhookSecret: z.string().min(16).max(200).optional(),
  }),
).transform((v) => ({ ...AGENT_DEFAULTS, ...v }));

export const agentPatchSchema = z.preprocess(withoutServerFields, base.partial());

export type AgentInput = z.infer<typeof agentCreateSchema>;
