import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

process.env.BULLPEN_DATA = mkdtempSync(join(tmpdir(), "bullpen-test-"));
// Managed mode, so the routes may write the config instead of shelling out to `claude`.
const configDir = mkdtempSync(join(tmpdir(), "bullpen-mcp-routes-"));
process.env.CLAUDE_CONFIG_DIR = configDir;

const { runMigrations } = await import("../db/migrate.ts");
const { api } = await import("./api.ts");

runMigrations();

type Body = { global: { name: string }[]; health: Record<string, unknown> };

const body = async (r: Response) => (await r.json()) as Body;

const add = (name: string, config: unknown) =>
  api.request("/machine-mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, config }),
  });

beforeEach(() => {
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ mcpServers: {} }));
});

describe("machine-mcp routes", () => {
  it("answers a write with the same shape as the read, health included", async () => {
    const get = await body(await api.request("/machine-mcp"));
    const posted = await body(await add("test", { type: "http", url: "https://example.com" }));
    expect(Object.keys(posted).sort()).toEqual(Object.keys(get).sort());
    expect(posted.health).toEqual({});
    expect(posted.global.map((s) => s.name)).toEqual(["test"]);

    const deleted = await body(await api.request("/machine-mcp/test", { method: "DELETE" }));
    expect(Object.keys(deleted).sort()).toEqual(Object.keys(get).sort());
    expect(deleted.global).toEqual([]);
  });

  it("rejects a config with neither url nor command", async () => {
    expect((await add("bad", { nonsense: true })).status).toBe(400);
  });
});
