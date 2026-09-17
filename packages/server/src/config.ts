import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function gitHead(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** `repository` in the root package.json, normalized to a browsable GitHub URL. */
function repoUrlFromPackage(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { repository?: string | { url?: string } };
    const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    if (!raw) return null;
    const m = /^(?:github:|git\+)?(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(raw);
    return m ? `https://github.com/${m[1]}` : null;
  } catch {
    return null;
  }
}

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
  /** Files runs hand back (`.bullpen/out/` at run end), by run id. */
  artifactsDir: resolve(dataDir, "artifacts"),
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
  /** The running commit: Kamal sets KAMAL_VERSION on the container; dev falls back to git. */
  version: process.env.KAMAL_VERSION || gitHead() || null,
  /** The GitHub release this deploy was published as, when it came through the deploy workflow. */
  release: process.env.BULLPEN_RELEASE || null,
  repoUrl: repoUrlFromPackage(),
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
