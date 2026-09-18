import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { noteworthyConfigDir, systemNote } from "./systemNote.ts";

const original = process.env.GOG_KEYRING_PASSWORD;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

afterEach(() => {
  if (original === undefined) delete process.env.GOG_KEYRING_PASSWORD;
  else process.env.GOG_KEYRING_PASSWORD = original;
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
});

describe("systemNote", () => {
  it("says nothing about gog when the agent has no keyring password", () => {
    delete process.env.GOG_KEYRING_PASSWORD;
    expect(systemNote("manual", {})).not.toContain("gog");
  });

  it("mentions gog when the agent's own env carries the password", () => {
    delete process.env.GOG_KEYRING_PASSWORD;
    expect(systemNote("manual", { GOG_KEYRING_PASSWORD: "p" })).toContain("gog");
  });

  it("mentions gog when the password comes from the process, as a run's env would", () => {
    process.env.GOG_KEYRING_PASSWORD = "p";
    expect(systemNote("manual", {})).toContain("gog");
  });

  it("gives two agents on one box different notes", () => {
    delete process.env.GOG_KEYRING_PASSWORD;
    expect(systemNote("manual", { GOG_KEYRING_PASSWORD: "p" })).toContain("gog");
    expect(systemNote("manual", {})).not.toContain("gog");
  });

  it("names a config dir that is not ~/.claude, so a run does not waste a turn guessing", () => {
    delete process.env.GOG_KEYRING_PASSWORD;
    process.env.CLAUDE_CONFIG_DIR = "/data/claude";
    const note = systemNote("manual", {});
    expect(note).toContain("/data/claude");
    expect(note).toContain(join("/data/claude", "skills"));
  });

  it("says nothing about a config dir that is already ~/.claude", () => {
    delete process.env.GOG_KEYRING_PASSWORD;
    process.env.CLAUDE_CONFIG_DIR = join(homedir(), ".claude");
    expect(systemNote("manual", {})).not.toContain("configuration directory");
  });

  it("says nothing about a config dir when none is set", () => {
    delete process.env.GOG_KEYRING_PASSWORD;
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(systemNote("manual", {})).not.toContain("configuration directory");
    expect(noteworthyConfigDir()).toBeNull();
  });

  it("lets an agent's own env override the process config dir, as a run's env does", () => {
    process.env.CLAUDE_CONFIG_DIR = "/data/claude";
    expect(noteworthyConfigDir({ CLAUDE_CONFIG_DIR: "/data/other" })).toBe("/data/other");
  });

  it("keeps the delivery and files sections regardless", () => {
    delete process.env.GOG_KEYRING_PASSWORD;
    const note = systemNote("webhook", {});
    expect(note).toContain("payload.json");
    expect(note).toContain(".bullpen/out");
  });
});
