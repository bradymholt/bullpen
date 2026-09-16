import { describe, expect, it } from "vitest";
import { foldMcpHealth, interpolateSecrets, selectMcp, summarizeMcpStatus } from "./mcp.ts";

describe("interpolateSecrets", () => {
  const env = { LINEAR_TOKEN: "abc123", OTHER: "xyz" };

  it("substitutes into nested config wherever it appears", () => {
    const config = {
      linear: {
        type: "http",
        url: "https://api.example.com",
        headers: { Authorization: "Bearer ${LINEAR_TOKEN}" },
      },
      local: { command: "npx", args: ["-y", "server", "--key=${OTHER}"] },
    };
    expect(interpolateSecrets(config, env)).toEqual({
      linear: {
        type: "http",
        url: "https://api.example.com",
        headers: { Authorization: "Bearer abc123" },
      },
      local: { command: "npx", args: ["-y", "server", "--key=xyz"] },
    });
  });

  it("leaves an unknown placeholder alone rather than emptying it", () => {
    expect(interpolateSecrets({ k: "${NOPE}" }, env)).toEqual({ k: "${NOPE}" });
  });

  it("does not disturb config without placeholders", () => {
    const config = { a: { command: "node", timeout: 5000, alwaysLoad: true } };
    expect(interpolateSecrets(config, env)).toEqual(config);
  });
});

describe("summarizeMcpStatus", () => {
  it("pulls name, status, error, and tool count off the init message", () => {
    const init = {
      mcp_servers: [
        { name: "linear", status: "connected", tools: [{ name: "a" }, { name: "b" }] },
        { name: "broken", status: "failed", error: "spawn ENOENT" },
      ],
    };
    expect(summarizeMcpStatus(init)).toEqual([
      { name: "linear", status: "connected", toolCount: 2 },
      { name: "broken", status: "failed", error: "spawn ENOENT" },
    ]);
  });

  it("returns nothing when the session has no MCP servers", () => {
    expect(summarizeMcpStatus({})).toEqual([]);
    expect(summarizeMcpStatus(null)).toEqual([]);
  });
});

describe("selectMcp", () => {
  const shared = {
    dd: { type: "http", url: "https://dd/mcp", headers: { Authorization: "Bearer ${DD}" } },
    cf: { type: "http", url: "https://cf/mcp" },
  };
  const own = { mine: { command: "npx", args: ["x"] } };
  const env = { DD: "secret" };

  it("hands over only the agent's own servers, strictly, when sharing is off", () => {
    expect(selectMcp({ mcpServers: own, inheritMachineMcp: false, sharedMcpPick: ["dd"] }, shared, env)).toEqual({
      mcpServers: own,
      strictMcpConfig: true,
    });
  });

  it("lets the harness read everything shared when no pick is made — connectors live only there", () => {
    expect(selectMcp({ mcpServers: own, inheritMachineMcp: true, sharedMcpPick: null }, shared, env)).toEqual({
      mcpServers: own,
      strictMcpConfig: false,
    });
  });

  it("passes a pick explicitly, interpolated, with strict on so nothing unpicked leaks in", () => {
    const r = selectMcp({ mcpServers: own, inheritMachineMcp: true, sharedMcpPick: ["dd", "gone"] }, shared, env);
    expect(r.strictMcpConfig).toBe(true);
    expect(Object.keys(r.mcpServers).sort()).toEqual(["dd", "mine"]);
    expect((r.mcpServers.dd as { headers: { Authorization: string } }).headers.Authorization).toBe("Bearer secret");
  });
});

describe("foldMcpHealth", () => {
  it("keeps the newest status per server", () => {
    const h = foldMcpHealth([
      { ts: 20, payload: { servers: [{ name: "dd", status: "connected" }] } },
      { ts: 10, payload: { servers: [{ name: "dd", status: "failed", error: "boom" }, { name: "cf", status: "needs-auth" }] } },
    ]);
    expect(h).toEqual({ dd: { status: "connected", at: 20 }, cf: { status: "needs-auth", at: 10 } });
  });
});
