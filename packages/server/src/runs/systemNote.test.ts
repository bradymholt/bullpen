import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { noteworthyConfigDir, systemNote } from "./systemNote.ts";

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
});

describe("systemNote", () => {
  it("names a config dir that is not ~/.claude, so a run does not waste a turn guessing", () => {
    process.env.CLAUDE_CONFIG_DIR = "/data/claude";
    const note = systemNote("manual", {});
    expect(note).toContain("/data/claude");
    expect(note).toContain(join("/data/claude", "skills"));
  });

  it("says nothing about a config dir that is already ~/.claude", () => {
    process.env.CLAUDE_CONFIG_DIR = join(homedir(), ".claude");
    expect(systemNote("manual", {})).not.toContain("configuration directory");
  });

  it("says nothing about a config dir when none is set", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(systemNote("manual", {})).not.toContain("configuration directory");
    expect(noteworthyConfigDir()).toBeNull();
  });

  it("lets an agent's own env override the process config dir, as a run's env does", () => {
    process.env.CLAUDE_CONFIG_DIR = "/data/claude";
    expect(noteworthyConfigDir({ CLAUDE_CONFIG_DIR: "/data/other" })).toBe("/data/other");
  });

  it("keeps the delivery and files sections regardless", () => {
    const note = systemNote("webhook", {});
    expect(note).toContain("payload.json");
    expect(note).toContain(".bullpen/out");
    expect(note).toContain("end your turn");
  });
});
