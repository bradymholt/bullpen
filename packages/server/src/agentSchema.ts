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

export const agentInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  model: z.string().max(120).nullish(),
  prompt: z.string().default(""),
  permissionMode: z.enum(["supervised", "acceptEdits", "plan", "full", "locked"]).default("supervised"),
  workspaceConfig: workspaceConfigSchema.default({ kind: "persistent" }),
  allowedTools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
  mcpServers: mcpServersSchema.default({}),
  inheritMachineMcp: z.boolean().default(false),
  env: z.record(z.string(), z.string()).default({}),
  maxTurns: z.number().int().positive().nullish(),
  cron: z.string().max(120).nullish(),
  cronTimezone: z.string().max(120).nullish(),
  enabled: z.boolean().default(true),
});

export const agentPatchSchema = agentInputSchema.partial();

export type AgentInput = z.infer<typeof agentInputSchema>;
