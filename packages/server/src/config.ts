import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ClaudeCredential = {
  source: "global-env" | "oauth-token" | "api-key" | "config-dir" | "existing-login" | "none";
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
  /**
   * Where senders on the internet reach /api/hooks, when that differs from the
   * address the dashboard is opened on — a funneled port beside a tailnet-only
   * one, say. The UI builds every webhook URL from this when set.
   */
  publicUrl: process.env.BULLPEN_PUBLIC_URL?.replace(/\/+$/, "") || undefined,
  /**
   * The port config/tailscale-serve.json funnels /api/hooks on. When the
   * dashboard is reached through Tailscale serve, the public base is derived
   * from the request's host plus this — the one convention that saves a
   * config value per deployment.
   */
  tailscaleHooksPort: 8443,
  /**
   * An approval nobody answers holds the run in awaiting_approval, and a
   * concurrency-skip agent then refuses every later trigger. Unattended runs
   * have no one to answer at all, so prompts expire instead of wedging.
   */
  approvalTimeoutMs: Number(process.env.BULLPEN_APPROVAL_TIMEOUT_MS ?? 15 * 60_000),
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
  // A bare config dir is not a login — the container image creates one so
  // skills can be mounted into it. `~/.claude.json` only exists after the
  // harness has actually been signed in on this machine — and that sign-in is
  // invisible to a harness pointed at another CLAUDE_CONFIG_DIR (measured:
  // "Not logged in" with the Keychain login present).
  if (!process.env.CLAUDE_CONFIG_DIR && existsSync(join(homedir(), ".claude.json"))) {
    return {
      source: "existing-login",
      detail: `${join(homedir(), ".claude.json")} exists; credentials may live in the OS keychain`,
    };
  }

  return {
    source: "none",
    detail: "set CLAUDE_CODE_OAUTH_TOKEN (see `claude setup-token`), CLAUDE_CONFIG_DIR, or ANTHROPIC_API_KEY",
  };
}
