import { eq } from "drizzle-orm";
import { config, detectClaudeCredential, type ClaudeCredential } from "./config.ts";
import { db } from "./db/index.ts";
import { globalConfig, spaceSecrets, type Agent } from "./db/schema.ts";

type Env = Record<string, string>;

/** What the API sends in place of a value. Values never leave the server. */
export const MASK = "••••";

export function maskEnv(env: Env): Env {
  return Object.fromEntries(Object.keys(env).map((k) => [k, MASK]));
}

/**
 * A client edits a masked view, so a value that is still the mask means
 * "unchanged" — keep what is stored. A key it left out is deleted; a value
 * it typed replaces. Whitespace-only keys are dropped rather than saved.
 */
export function mergeMaskedEnv(current: Env, patch: Env): Env {
  const out: Env = {};
  for (const [rawKey, value] of Object.entries(patch)) {
    const key = rawKey.trim();
    if (!key) continue;
    out[key] = /^•+$/.test(value) ? (current[key] ?? "") : value;
  }
  return out;
}

export function globalEnv(): Env {
  return (db.select().from(globalConfig).where(eq(globalConfig.id, 1)).get()?.env as Env) ?? {};
}

export function setGlobalEnv(env: Env): void {
  db.insert(globalConfig)
    .values({ id: 1, env })
    .onConflictDoUpdate({ target: globalConfig.id, set: { env } })
    .run();
}

/** Hours between background skills pulls. 0 is off; the column defaults to 24. */
export function skillsRefreshHours(): number {
  return db.select().from(globalConfig).where(eq(globalConfig.id, 1)).get()?.skillsRefreshHours ?? 24;
}

export function setSkillsRefreshHours(hours: number): void {
  db.insert(globalConfig)
    .values({ id: 1, skillsRefreshHours: hours })
    .onConflictDoUpdate({ target: globalConfig.id, set: { skillsRefreshHours: hours } })
    .run();
}

export function spaceEnv(space: string | null | undefined): Env {
  if (!space) return {};
  return (db.select().from(spaceSecrets).where(eq(spaceSecrets.space, space)).get()?.env as Env) ?? {};
}

/**
 * The env a run actually gets, before the process's own is layered under it:
 * global, then the agent's space, then the agent. Later wins.
 */
export function resolveEnv(agent: Pick<Agent, "space" | "env">): Env {
  return { ...globalEnv(), ...spaceEnv(agent.space), ...(agent.env as Env) };
}

/**
 * The server's own GitHub calls — repo listing, PR creation, clone auth — take
 * the token from the process if the box has one, else from global env, so a
 * headless deployment can keep it in the dashboard rather than in `.env`.
 */
export function githubToken(): string | undefined {
  // Same order as a run's env: what the dashboard holds overrides the process.
  return globalEnv().GITHUB_TOKEN || config.githubToken || undefined;
}

/**
 * Where the Claude credential comes from, dashboard first — the same precedence
 * a run sees, since the harness reads CLAUDE_CODE_OAUTH_TOKEN from the env the
 * runner hands it and global env sits above the process in that stack.
 */
export function claudeCredential(): ClaudeCredential {
  const g = globalEnv();
  if (g.CLAUDE_CODE_OAUTH_TOKEN) return { source: "global-env", detail: "CLAUDE_CODE_OAUTH_TOKEN in global env" };
  if (g.ANTHROPIC_API_KEY) return { source: "api-key", detail: "ANTHROPIC_API_KEY in global env" };
  return detectClaudeCredential();
}
