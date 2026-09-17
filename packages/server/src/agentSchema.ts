import { z } from "zod";

/**
 * Where an agent lives when nobody chose a space. It is an ordinary space in
 * every way but two: it cannot be renamed or removed, so there is always
 * somewhere for an agent to land.
 */
export const DEFAULT_SPACE = "General";

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
  space: z.string().trim().min(1).max(60),
  model: z.string().max(120).nullish(),
  prompt: z.string(),
  permissionMode: z.enum(["supervised", "acceptEdits", "plan", "auto", "full", "locked"]),
  workspaceConfig: workspaceConfigSchema,
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()),
  mcpServers: mcpServersSchema,
  inheritMachineMcp: z.boolean(),
  sharedMcpPick: z.array(z.string().min(1).max(64)).max(50).nullable(),
  inheritUserSettings: z.boolean(),
  env: z.record(z.string(), z.string()),
  maxTurns: z.number().int().positive().nullish(),
  pollUrl: z.string().url().max(2000).nullish(),
  pollHeaders: z.record(z.string(), z.string()),
  pollPath: z.string().max(200).nullish(),
  cron: z.string().max(120).nullish(),
  cronTimezone: z.string().max(120).nullish(),
  // "hmac" is the pre-preset spelling of "github"; kept so old records round-trip.
  trigger: z.enum(["manual", "schedule", "poll", "webhook"]),
  webhookMode: z.enum(["token", "github", "slack", "asana", "custom", "hmac"]),
  filterPath: z.string().max(200).nullish(),
  filterValues: z.array(z.string().max(200)).max(100),
  filters: z.array(filterConditionSchema).max(10),
  labelTemplate: z.string().max(300).nullish(),
  webhookSignatureHeader: z.string().max(120).nullish(),
  webhookSignaturePrefix: z.string().max(40).nullish(),
  webhookEvents: z.array(z.string()),
  concurrency: z.enum(["skip", "allow", "queue"]),
  enabled: z.boolean(),
};

/**
 * Cautious by default, with one deliberate exception: `auto` rather than
 * `supervised`, because an unattended run that stops for approval never
 * resumes — there is no prompt timeout and no one watching a cron fire.
 */
/** The question tool, which holds a run open until somebody answers it. */
export const ASK_TOOL = "AskUserQuestion";

/**
 * A mode that never shows a permission prompt has nobody watching to answer a
 * question either, so the question would just hold the run until it times out.
 * Only a create decides this; a PATCH must leave the agent's own list alone.
 */
export function defaultDisallowedTools(mode: string | undefined): string[] {
  const prompts = mode === "supervised" || mode === "acceptEdits" || mode === "plan";
  return prompts ? [] : [ASK_TOOL];
}

export const AGENT_DEFAULTS = {
  prompt: "",
  space: DEFAULT_SPACE,
  permissionMode: "auto",
  workspaceConfig: { kind: "ephemeral" },
  allowedTools: [],
  disallowedTools: [],
  mcpServers: {},
  inheritMachineMcp: false,
  sharedMcpPick: null,
  inheritUserSettings: true,
  env: {},
  pollHeaders: {},
  trigger: "manual",
  webhookMode: "custom",
  webhookEvents: [],
  filterValues: [],
  filters: [],
  labelTemplate: null,
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
).transform((v) => ({
  ...AGENT_DEFAULTS,
  ...(v.disallowedTools === undefined ? { disallowedTools: defaultDisallowedTools(v.permissionMode) } : {}),
  ...v,
}));

export const agentPatchSchema = z.preprocess(withoutServerFields, base.partial());

export type AgentInput = z.infer<typeof agentCreateSchema>;

/**
 * Exports written before `trigger` existed carry no such field; recover it the
 * way the editor used to guess it, so an old webhook agent doesn't import as manual.
 */
export function inferTrigger(a: {
  pollUrl?: unknown;
  cron?: unknown;
  webhookEvents?: unknown;
  webhookMode?: unknown;
}): "manual" | "schedule" | "poll" | "webhook" {
  if (a.pollUrl) return "poll";
  if (a.cron) return "schedule";
  const events = Array.isArray(a.webhookEvents) ? a.webhookEvents : [];
  if (events.length > 0 || (a.webhookMode && a.webhookMode !== "token" && a.webhookMode !== "custom")) return "webhook";
  return "manual";
}
