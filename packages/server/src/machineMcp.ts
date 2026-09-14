import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MachineMcp = {
  configPath: string;
  found: boolean;
  /** Servers in the config's own `mcpServers` — inherited by every run. */
  global: { name: string; transport: string }[];
  /** claude.ai connectors this machine has connected at some point. */
  connectors: string[];
};

function transportOf(value: unknown): string {
  if (!value || typeof value !== "object") return "unknown";
  const v = value as Record<string, unknown>;
  return typeof v.type === "string" ? v.type : v.command ? "stdio" : "unknown";
}

export function readMachineMcp(): MachineMcp {
  const configPath = process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(homedir(), ".claude.json");

  const empty = { configPath, found: false, global: [], connectors: [] };
  if (!existsSync(configPath)) return empty;

  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return empty;
  }

  return {
    configPath,
    found: true,
    global: Object.entries(parsed.mcpServers ?? {}).map(([name, cfg]) => ({
      name,
      transport: transportOf(cfg),
    })),
    connectors: Array.isArray(parsed.claudeAiMcpEverConnected) ? parsed.claudeAiMcpEverConnected : [],
  };
}
