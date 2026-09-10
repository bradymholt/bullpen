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
