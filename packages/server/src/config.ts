import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ClaudeCredential = {
  source: "oauth-token" | "api-key" | "config-dir" | "existing-login" | "none";
  detail: string;
};

/**
 * Outside the checkout on purpose: a workspace nested under a repo inherits
 * that repo's CLAUDE.md, so an agent cloned into ./data reads the host
 * project's instructions as its own. The container sets BULLPEN_DATA=/data.
 */
function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

const dataDir = resolve(expandHome(process.env.BULLPEN_DATA || join(homedir(), ".bullpen")));

export const config = {
  dataDir,
  dbPath: resolve(dataDir, "bullpen.db"),
  workspacesDir: resolve(dataDir, "workspaces"),
  agentDataDir: resolve(dataDir, "agent-data"),
  port: Number(process.env.PORT ?? 4322),
  githubToken: process.env.GITHUB_TOKEN || undefined,
};

/**
 * Best-effort: the SDK resolves credentials itself and can reach places we
 * can't inspect — notably the macOS Keychain, where a working login leaves no
 * .credentials.json behind. So a Claude Code config dir counts as evidence,
 * and only the total absence of one is reported as unconfigured.
 */
export function detectClaudeCredential(): ClaudeCredential {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { source: "oauth-token", detail: "CLAUDE_CODE_OAUTH_TOKEN" };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { source: "api-key", detail: "ANTHROPIC_API_KEY" };
  }

  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  if (existsSync(join(configDir, ".credentials.json"))) {
    return { source: "config-dir", detail: join(configDir, ".credentials.json") };
  }
  if (existsSync(configDir) || existsSync(join(homedir(), ".claude.json"))) {
    return {
      source: "existing-login",
      detail: `${configDir} exists; credentials may live in the OS keychain`,
    };
  }

  return {
    source: "none",
    detail: "set CLAUDE_CODE_OAUTH_TOKEN (see `claude setup-token`), CLAUDE_CONFIG_DIR, or ANTHROPIC_API_KEY",
  };
}
