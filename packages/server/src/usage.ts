import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { globalEnv } from "./env.ts";

/**
 * Subscription usage, the way Claude Code's `/usage` shows it: how much of
 * each rate-limit window is used and when it resets. Read from the same
 * endpoint with the same OAuth login, so the numbers match the CLI's.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export type UsageWindow = {
  key: string;
  label: string;
  /** 0–100, how much of the window has been used. */
  utilization: number;
  resetsAt: string | null;
};

export type Usage = {
  windows: UsageWindow[];
  fetchedAt: number;
  /** Where the login came from, so an empty screen can say what to fix. */
  source: "config-dir" | "keychain" | "env";
};

const LABELS: Record<string, string> = {
  five_hour: "Session",
  seven_day: "Weekly",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
};

function labelFor(key: string): string {
  if (LABELS[key]) return LABELS[key];
  // `seven_day_<model>` for a model this list predates.
  const m = /^seven_day_(\w+)$/.exec(key);
  if (m) return `Weekly · ${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)}`;
  return key.replace(/_/g, " ");
}

type OauthFile = { claudeAiOauth?: { accessToken?: string } };

/**
 * The harness keeps its login in `.credentials.json` under the config dir,
 * except on macOS where it uses the Keychain. `CLAUDE_CODE_OAUTH_TOKEN` (the
 * `setup-token` kind) is tried last; the endpoint may not accept it.
 */
function accessToken(): { token: string; source: Usage["source"] } | null {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const file = join(configDir, ".credentials.json");
  if (existsSync(file)) {
    try {
      const token = (JSON.parse(readFileSync(file, "utf8")) as OauthFile).claudeAiOauth?.accessToken;
      if (token) return { token, source: "config-dir" };
    } catch {
      // unreadable file: fall through to the other sources
    }
  }
  if (process.platform === "darwin" && !process.env.CLAUDE_CONFIG_DIR) {
    // Several items share the service name (the VS Code extension keeps its own,
    // and one holds only MCP logins), so the user's own account is tried first.
    for (const account of [["-a", userInfo().username], []]) {
      try {
        const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", ...account, "-w"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        });
        const token = (JSON.parse(raw.trim()) as OauthFile).claudeAiOauth?.accessToken;
        if (token) return { token, source: "keychain" };
      } catch {
        // no such item, or the Keychain refused; try the next
      }
    }
  }
  const env = globalEnv().CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (env) return { token: env, source: "env" };
  return null;
}

export class UsageError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// The endpoint rate-limits aggressively; one fetch a minute is plenty for a dashboard.
let cache: { at: number; value: Usage } | null = null;
const CACHE_MS = 60_000;

export async function fetchUsage(): Promise<Usage> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const cred = accessToken();
  if (!cred) throw new UsageError("no Claude login to read usage with", 401);

  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${cred.token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `usage endpoint answered ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // not JSON
    }
    throw new UsageError(message, res.status === 429 ? 429 : 502);
  }

  const body = (await res.json()) as Record<string, unknown>;
  const windows: UsageWindow[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!value || typeof value !== "object") continue;
    const w = value as { utilization?: unknown; resets_at?: unknown };
    // A window is a utilization plus a reset; the response also carries
    // feature flags shaped like `{utilization: 0}` that are neither.
    if (typeof w.utilization !== "number" || typeof w.resets_at !== "string") continue;
    windows.push({
      key,
      label: labelFor(key),
      utilization: Math.max(0, Math.min(100, w.utilization)),
      resetsAt: typeof w.resets_at === "string" ? w.resets_at : null,
    });
  }
  // Session first, then the weekly windows in the order the API gave them.
  windows.sort((a, b) => (a.key === "five_hour" ? -1 : b.key === "five_hour" ? 1 : 0));

  const value: Usage = { windows, fetchedAt: Date.now(), source: cred.source };
  cache = { at: Date.now(), value };
  return value;
}

/** For the refresh button: the next call goes to the network. */
export function invalidateUsage(): void {
  cache = null;
}
