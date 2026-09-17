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
 * Servers a headless box can use with no account and no key. Offered at
 * onboarding, pre-selected, and again under Settings; declarative — applying a
 * selection adds what is checked and removes catalog entries that are not.
 * Nothing here is ever installed without that choice.
 */
export type CatalogEntry = {
  key: string;
  name: string;
  description: string;
  /** Why it can't be offered on this box, or null. */
  unavailable: string | null;
  installed: boolean;
};

const PLAYWRIGHT_WRAPPER = "/usr/local/bin/playwright-mcp";

export const DEFAULT_PLAYWRIGHT: McpServerConfig = {
  command: "playwright-mcp",
  // --output-dir: unnamed screenshots, page snapshots and console logs land in a folder the
  // run keeps, kept apart from the files the agent names on purpose.
  args: ["--browser", "chromium", "--headless", "--no-sandbox", "--isolated", "--output-dir", ".bullpen/out/playwright"],
};

const CATALOG: { key: string; name: string; description: string; config: (dataDir: string) => McpServerConfig; unavailable: (wrapper: string) => string | null }[] = [
  {
    key: "playwright",
    name: "Playwright — a browser",
    description: "Headless Chromium the agent can drive: open pages, click, fill forms, take screenshots. The browser downloads on first use.",
    config: () => DEFAULT_PLAYWRIGHT,
    unavailable: (wrapper) => (existsSync(wrapper) ? null : "this image was built without WITH_BROWSER"),
  },
  {
    key: "memory",
    name: "Memory — remembers across runs",
    description: "A local knowledge graph in one file under /data. An agent that runs nightly can keep notes about what it saw last time. Nothing leaves the box.",
    config: (dataDir) => ({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory@2026.8.31"],
      env: { MEMORY_FILE_PATH: join(dataDir, "mcp", "memory.json") },
    }),
    unavailable: () => null,
  },
];

export function mcpCatalog(opts: { wrapper?: string } = {}): CatalogEntry[] {
  const installed = new Set(Object.keys(readConfig()?.mcpServers ?? {}));
  return CATALOG.map((c) => ({
    key: c.key,
    name: c.name,
    description: c.description,
    unavailable: c.unavailable(opts.wrapper ?? PLAYWRIGHT_WRAPPER),
    installed: installed.has(c.key),
  }));
}

/** Managed mode only. Returns what changed. */
export function applyMcpCatalog(keys: string[], opts: { dataDir: string; wrapper?: string }): { added: string[]; removed: string[] } {
  if (!process.env.CLAUDE_CONFIG_DIR) throw new Error("this is the user's own ~/.claude.json, not managed by bullpen");
  const want = new Set(keys);
  const state = mcpCatalog({ wrapper: opts.wrapper });
  const added: string[] = [];
  const removed: string[] = [];
  for (const entry of CATALOG) {
    const cur = state.find((e) => e.key === entry.key)!;
    if (want.has(entry.key) && !cur.installed) {
      if (cur.unavailable) continue;
      if (entry.key === "memory") mkdirSync(join(opts.dataDir, "mcp"), { recursive: true });
      addMachineMcp(entry.key, entry.config(opts.dataDir));
      added.push(entry.key);
    } else if (!want.has(entry.key) && cur.installed) {
      removeMachineMcp(entry.key);
      removed.push(entry.key);
    }
  }
  return { added, removed };
}
