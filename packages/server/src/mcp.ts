/**
 * MCP configs reference secrets as ${NAME} so the stored JSON stays free of
 * credentials — the API serves that JSON, and an agent can read its own
 * config. Substitution happens once, at run start.
 */
export function interpolateSecrets<T>(config: T, env: Record<string, string>): T {
  if (typeof config === "string") {
    return config.replace(/\$\{(\w+)\}/g, (whole, name: string) => env[name] ?? whole) as T;
  }
  if (Array.isArray(config)) {
    return config.map((v) => interpolateSecrets(v, env)) as T;
  }
  if (config && typeof config === "object") {
    return Object.fromEntries(
      Object.entries(config).map(([k, v]) => [k, interpolateSecrets(v, env)]),
    ) as T;
  }
  return config;
}

export type McpStatus = { name: string; status: string; error?: string; toolCount?: number };

/** The init message reports connection state; a failed server never fails the run. */
export function summarizeMcpStatus(initPayload: unknown): McpStatus[] {
  const servers = (initPayload as { mcp_servers?: unknown[] })?.mcp_servers;
  if (!Array.isArray(servers)) return [];
  return servers.map((s) => {
    const row = s as { name?: string; status?: string; error?: string; tools?: unknown[] };
    return {
      name: row.name ?? "?",
      status: row.status ?? "unknown",
      ...(row.error ? { error: row.error } : {}),
      ...(Array.isArray(row.tools) ? { toolCount: row.tools.length } : {}),
    };
  });
}

export type McpSelection = { mcpServers: Record<string, unknown>; strictMcpConfig: boolean };

/**
 * What a run is handed. "All shared" has to go through the harness's own config
 * read (strict off) because claude.ai connectors exist nowhere else; a pick is
 * passed explicitly with strict on, so nothing unpicked — connectors included —
 * reaches the run. The agent's own servers ride along in every case.
 */
export function selectMcp(
  agent: { mcpServers: unknown; inheritMachineMcp: boolean; sharedMcpPick: string[] | null },
  shared: Record<string, unknown>,
  env: Record<string, string>,
): McpSelection {
  const own = (agent.mcpServers ?? {}) as Record<string, unknown>;
  if (!agent.inheritMachineMcp) return { mcpServers: interpolateSecrets(own, env), strictMcpConfig: true };
  if (agent.sharedMcpPick === null) return { mcpServers: interpolateSecrets(own, env), strictMcpConfig: false };
  const picked = Object.fromEntries(agent.sharedMcpPick.filter((n) => n in shared).map((n) => [n, shared[n]]));
  return { mcpServers: interpolateSecrets({ ...picked, ...own }, env), strictMcpConfig: true };
}

export type McpHealth = Record<string, { status: string; at: number; error?: string }>;

/** Newest status per server from the runs' init messages, newest event first. */
export function foldMcpHealth(events: { ts: number; payload: unknown }[]): McpHealth {
  const out: McpHealth = {};
  for (const e of events) {
    const servers = (e.payload as { servers?: McpStatus[] })?.servers;
    if (!Array.isArray(servers)) continue;
    for (const s of servers) {
      if (s.name in out) continue;
      out[s.name] = { status: s.status, at: e.ts, ...(s.error ? { error: s.error } : {}) };
    }
  }
  return out;
}
