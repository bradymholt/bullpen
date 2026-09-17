import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type McpServerConfig = Record<string, unknown>;

export type McpServerSummary = {
  name: string;
  transport: string;
  /** URL or command line — never env or header values. */
  detail: string;
  /** Names of env/header keys present, so a secret's existence is visible without its value. */
  secretKeys: string[];
};

export type MachineMcp = {
  configPath: string;
  found: boolean;
  /**
   * Whether bullpen may write this file. CLAUDE_CONFIG_DIR set means the config
   * dir is bullpen's (the container). Otherwise it is the user's own ~/.claude.json:
   * bullpen reads it and shows what agents inherit, and never changes it.
   */
  managed: boolean;
  /** Servers in the config's own `mcpServers` — inherited by every run. */
  global: McpServerSummary[];
  /** claude.ai connectors this machine has connected at some point. */
  connectors: string[];
};

function configPath(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(homedir(), ".claude.json");
}

function transportOf(value: unknown): string {
  if (!value || typeof value !== "object") return "unknown";
  const v = value as Record<string, unknown>;
  return typeof v.type === "string" ? v.type : v.command ? "stdio" : "unknown";
}

function summarize(name: string, cfg: unknown): McpServerSummary {
  const v = (cfg ?? {}) as Record<string, unknown>;
  const detail =
    typeof v.url === "string"
      ? v.url
      : typeof v.command === "string"
        ? [v.command, ...((v.args as string[] | undefined) ?? [])].join(" ")
        : "";
  const secretKeys = [
    ...Object.keys((v.env as object | undefined) ?? {}),
    ...Object.keys((v.headers as object | undefined) ?? {}),
  ];
  return { name, transport: transportOf(cfg), detail, secretKeys };
}

function readConfig(): Record<string, any> | null {
  const p = configPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function readMachineMcp(): MachineMcp {
  const p = configPath();
  const managed = Boolean(process.env.CLAUDE_CONFIG_DIR);
  const parsed = readConfig();
  if (!parsed) return { configPath: p, found: false, managed, global: [], connectors: [] };

  return {
    configPath: p,
    found: true,
    managed,
    global: Object.entries((parsed.mcpServers ?? {}) as Record<string, unknown>).map(([n, c]) => summarize(n, c)),
    connectors: Array.isArray(parsed.claudeAiMcpEverConnected) ? parsed.claudeAiMcpEverConnected : [],
  };
}

/** Managed mode only: rewrite the file atomically. */
function writeConfig(mutate: (cfg: Record<string, any>) => void): void {
  const p = configPath();
  const cfg = readConfig() ?? {};
  mutate(cfg);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  renameSync(tmp, p);
}

export function addMachineMcp(name: string, config: McpServerConfig): void {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error("name must be 1–64 letters, digits, _ . -");
  const transport = transportOf(config);
  if (transport === "unknown") throw new Error("config needs a `url` (http/sse) or a `command` (stdio)");
  if (!process.env.CLAUDE_CONFIG_DIR) throw new Error("this is the user's own ~/.claude.json, not managed by bullpen");
  writeConfig((cfg) => {
    cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: config };
  });
}

export function removeMachineMcp(name: string): void {
  if (!process.env.CLAUDE_CONFIG_DIR) throw new Error("this is the user's own ~/.claude.json, not managed by bullpen");
  writeConfig((cfg) => {
    if (cfg.mcpServers) delete cfg.mcpServers[name];
  });
}

/** The user-scope servers as stored, values included — for an encrypted export. */
export function exportMachineMcp(): Record<string, McpServerConfig> {
  return ((readConfig()?.mcpServers ?? {}) as Record<string, McpServerConfig>);
}

/**
 * Managed mode only: merge servers from an export into the config, replacing
 * any with the same name. Returns how many were written.
 */
export function importMachineMcp(servers: Record<string, McpServerConfig>): number {
  if (!process.env.CLAUDE_CONFIG_DIR) throw new Error("this is the user's own ~/.claude.json, not managed by bullpen");
  const entries = Object.entries(servers).filter(([name, cfg]) => /^[A-Za-z0-9_.-]{1,64}$/.test(name) && transportOf(cfg) !== "unknown");
  if (entries.length === 0) return 0;
  writeConfig((cfg) => {
    cfg.mcpServers = { ...(cfg.mcpServers ?? {}), ...Object.fromEntries(entries) };
  });
  return entries.length;
}

/**
 * A headless box should be able to browse out of the box. When the config dir
 * is bullpen's and the image carries the Playwright wrapper (WITH_BROWSER), the
 * shared config gets a `playwright` server on first boot. Once only: the marker
 * means a removal is respected, not undone at the next boot.
 */
export const DEFAULT_PLAYWRIGHT: McpServerConfig = {
  command: "playwright-mcp",
  // --output-dir: screenshots taken without a path land where the run keeps its files.
  args: ["--browser", "chromium", "--headless", "--no-sandbox", "--isolated", "--output-dir", ".bullpen/out"],
};

export function seedDefaultMcp(opts: { markerDir: string; wrapper?: string; managed?: boolean }): string[] {
  const managed = opts.managed ?? Boolean(process.env.CLAUDE_CONFIG_DIR);
  const wrapper = opts.wrapper ?? "/usr/local/bin/playwright-mcp";
  if (!managed || !existsSync(wrapper)) return [];
  const marker = join(opts.markerDir, ".mcp-seeded");
  if (existsSync(marker)) return [];
  const added: string[] = [];
  if (!(readConfig()?.mcpServers ?? {}).playwright) {
    addMachineMcp("playwright", DEFAULT_PLAYWRIGHT);
    added.push("playwright");
  }
  mkdirSync(opts.markerDir, { recursive: true });
  writeFileSync(marker, `${new Date().toISOString()}\n`);
  return added;
}
