import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// Managed mode: a temp CLAUDE_CONFIG_DIR that bullpen owns and may write.
const dir = mkdtempSync(join(tmpdir(), "bullpen-mcp-"));
process.env.CLAUDE_CONFIG_DIR = dir;
const { addMachineMcp, applyMcpCatalog, exportMachineMcp, importMachineMcp, mcpCatalog, readMachineMcp, removeMachineMcp } = await import("./machineMcp.ts");
const file = join(dir, ".claude.json");

beforeEach(() => {
  writeFileSync(file, JSON.stringify({ mcpServers: {} }));
});

describe("machine MCP (managed)", () => {
  it("adds and removes user-scope servers by rewriting the managed file", () => {
    addMachineMcp("cf", { type: "http", url: "https://mcp.cloudflare.com/mcp" });
    expect(readMachineMcp().global.map((s) => s.name)).toEqual(["cf"]);
    removeMachineMcp("cf");
    expect(readMachineMcp().global).toEqual([]);
  });

  it("summarizes without leaking header or env values", () => {
    addMachineMcp("dd", { type: "http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer x" } });
    const m = readMachineMcp();
    expect(m.global[0]).toMatchObject({ name: "dd", transport: "http", detail: "https://mcp.example/mcp", secretKeys: ["Authorization"] });
    expect(JSON.stringify(m)).not.toContain("Bearer x");
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.dd.headers.Authorization).toBe("Bearer x");
  });

  it("round-trips servers with their secrets through export and import, replacing by name", () => {
    addMachineMcp("dd", { type: "http", url: "https://old.example/mcp", headers: { Authorization: "Bearer old" } });
    const exported = exportMachineMcp();
    expect(exported.dd).toMatchObject({ headers: { Authorization: "Bearer old" } });
    const n = importMachineMcp({
      dd: { type: "http", url: "https://new.example/mcp", headers: { Authorization: "Bearer new" } },
      gh: { command: "npx", args: ["-y", "gh-mcp"] },
      junk: { nonsense: true },
    });
    expect(n).toBe(2);
    const file = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).mcpServers;
    expect(Object.keys(file).sort()).toEqual(["dd", "gh"]);
    expect(file.dd.headers.Authorization).toBe("Bearer new");
  });

  it("rejects a config that is neither http nor stdio", () => {
    expect(() => addMachineMcp("bad", { nonsense: true })).toThrow(/url.*command/);
  });
});

describe("mcp catalog", () => {
  it("offers playwright only when the image has the wrapper, and marks what is installed", () => {
    const dir = mkdtempSync(join(tmpdir(), "bullpen-cat-"));
    let cat = mcpCatalog({ wrapper: join(dir, "missing") });
    expect(cat.find((c) => c.key === "playwright")?.unavailable).toMatch(/WITH_BROWSER=0/);
    expect(cat.find((c) => c.key === "memory")).toMatchObject({ unavailable: null, installed: false });
    writeFileSync(join(dir, "playwright-mcp"), "#!/bin/sh\n");
    cat = mcpCatalog({ wrapper: join(dir, "playwright-mcp") });
    expect(cat.find((c) => c.key === "playwright")?.unavailable).toBeNull();
  });

  it("applies a selection declaratively: adds what is checked, removes catalog entries that are not", () => {
    const dir = mkdtempSync(join(tmpdir(), "bullpen-cat-"));
    const wrapper = join(dir, "playwright-mcp");
    writeFileSync(wrapper, "");
    expect(applyMcpCatalog(["playwright", "memory"], { dataDir: dir, wrapper })).toEqual({ added: ["playwright", "memory"], removed: [] });
    const cfg = JSON.parse(readFileSync(file, "utf8")).mcpServers;
    expect(cfg.memory.env.MEMORY_FILE_PATH).toBe(join(dir, "mcp", "memory.json"));
    expect(existsSync(join(dir, "mcp"))).toBe(true);
    expect(applyMcpCatalog(["memory"], { dataDir: dir, wrapper })).toEqual({ added: [], removed: ["playwright"] });
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).mcpServers)).toEqual(["memory"]);
    // a server the user added by hand is not the catalog's to remove
    addMachineMcp("mine", { type: "http", url: "https://x/mcp" });
    expect(applyMcpCatalog([], { dataDir: dir, wrapper })).toEqual({ added: [], removed: ["memory"] });
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).mcpServers)).toEqual(["mine"]);
  });
});
