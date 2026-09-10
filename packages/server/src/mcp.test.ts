import { describe, expect, it } from "vitest";
import { interpolateSecrets, summarizeMcpStatus } from "./mcp.ts";

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
