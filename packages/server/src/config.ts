import { resolve } from "node:path";

export type ClaudeCredential =
  | { source: "oauth-token"; detail: "CLAUDE_CODE_OAUTH_TOKEN" }
  | { source: "config-dir"; detail: string }
  | { source: "api-key"; detail: "ANTHROPIC_API_KEY" }
  | { source: "none"; detail: string };

const dataDir = resolve(process.env.BULLPEN_DATA ?? "./data");

export const config = {
  dataDir,
  dbPath: resolve(dataDir, "bullpen.db"),
  workspacesDir: resolve(dataDir, "workspaces"),
  agentDataDir: resolve(dataDir, "agent-data"),
  port: Number(process.env.PORT ?? 3000),
  githubToken: process.env.GITHUB_TOKEN || undefined,
};

/**
 * The Agent SDK resolves credentials itself; this only reports which one it
 * will land on so a misconfigured container fails loudly at /api/health
 * instead of on the first run.
 */
export function detectClaudeCredential(): ClaudeCredential {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { source: "oauth-token", detail: "CLAUDE_CODE_OAUTH_TOKEN" };
  }
  if (process.env.CLAUDE_CONFIG_DIR) {
    return { source: "config-dir", detail: process.env.CLAUDE_CONFIG_DIR };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { source: "api-key", detail: "ANTHROPIC_API_KEY" };
  }
  return {
    source: "none",
    detail: "set CLAUDE_CODE_OAUTH_TOKEN (see `claude setup-token`), CLAUDE_CONFIG_DIR, or ANTHROPIC_API_KEY",
  };
}
