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

export const workspaceConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("persistent") }),
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
  model: z.string().max(120).nullish(),
  prompt: z.string(),
  permissionMode: z.enum(["supervised", "acceptEdits", "plan", "full", "locked"]),
  workspaceConfig: workspaceConfigSchema,
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()),
  mcpServers: mcpServersSchema,
  inheritMachineMcp: z.boolean(),
  env: z.record(z.string(), z.string()),
  maxTurns: z.number().int().positive().nullish(),
  cron: z.string().max(120).nullish(),
  cronTimezone: z.string().max(120).nullish(),
  webhookMode: z.enum(["token", "hmac"]),
  webhookEvents: z.array(z.string()),
  allowPromptOverride: z.boolean(),
  concurrency: z.enum(["skip", "allow"]),
  enabled: z.boolean(),
};

/** Every switch defaults to the cautious setting. */
export const AGENT_DEFAULTS = {
  prompt: "",
  permissionMode: "supervised",
  workspaceConfig: { kind: "persistent" },
  allowedTools: [],
  disallowedTools: [],
  mcpServers: {},
  inheritMachineMcp: false,
  env: {},
  webhookMode: "token",
  webhookEvents: [],
  allowPromptOverride: false,
  concurrency: "skip",
  enabled: true,
} as const;

/**
 * Fields the server owns. Clients round-trip whole agent records, so these
 * arrive on every save; dropping them here leaves the strict check flagging
 * actual mistakes rather than normal traffic.
 */
const SERVER_OWNED = ["id", "workspaceKind", "webhookSecret", "createdAt", "updatedAt"] as const;

function withoutServerFields(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const copy = { ...(value as Record<string, unknown>) };
  for (const key of SERVER_OWNED) delete copy[key];
  return copy;
}

// Unknown keys are rejected rather than stripped: a misspelled field should
// not look like it saved and then quietly do nothing.
const base = z.object(fields).strict();

export const agentCreateSchema = z.preprocess(
  withoutServerFields,
  base.partial().required({ name: true }),
).transform((v) => ({ ...AGENT_DEFAULTS, ...v }));

export const agentPatchSchema = z.preprocess(withoutServerFields, base.partial());

export type AgentInput = z.infer<typeof agentCreateSchema>;
