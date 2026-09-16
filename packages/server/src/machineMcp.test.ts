import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// Managed mode: a temp CLAUDE_CONFIG_DIR that bullpen owns and may write.
const dir = mkdtempSync(join(tmpdir(), "bullpen-mcp-"));
process.env.CLAUDE_CONFIG_DIR = dir;
const { addMachineMcp, exportMachineMcp, importMachineMcp, readMachineMcp, removeMachineMcp, seedDefaultMcp } = await import("./machineMcp.ts");
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

describe("seedDefaultMcp", () => {
  it("adds playwright once when the image has the wrapper, and never re-adds after a removal", () => {
    const markerDir = mkdtempSync(join(tmpdir(), "bullpen-seed-"));
    const wrapper = join(markerDir, "playwright-mcp");
    writeFileSync(wrapper, "#!/bin/sh\n");
    expect(seedDefaultMcp({ markerDir, wrapper })).toEqual(["playwright"]);
    expect(readMachineMcp().global.map((s) => s.name)).toEqual(["playwright"]);
    expect(existsSync(join(markerDir, ".mcp-seeded"))).toBe(true);
    removeMachineMcp("playwright");
    expect(seedDefaultMcp({ markerDir, wrapper })).toEqual([]);
    expect(readMachineMcp().global).toEqual([]);
  });

  it("does nothing without the wrapper or outside managed mode", () => {
    const markerDir = mkdtempSync(join(tmpdir(), "bullpen-seed-"));
    expect(seedDefaultMcp({ markerDir, wrapper: join(markerDir, "missing") })).toEqual([]);
    writeFileSync(join(markerDir, "playwright-mcp"), "");
    expect(seedDefaultMcp({ markerDir, wrapper: join(markerDir, "playwright-mcp"), managed: false })).toEqual([]);
    expect(readMachineMcp().global).toEqual([]);
  });
});
