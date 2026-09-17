import { afterEach, describe, expect, it } from "vitest";
import { systemNote } from "./systemNote.ts";

const original = process.env.GOG_KEYRING_PASSWORD;

afterEach(() => {
  if (original === undefined) delete process.env.GOG_KEYRING_PASSWORD;
  else process.env.GOG_KEYRING_PASSWORD = original;
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

  it("keeps the delivery and files sections regardless", () => {
    delete process.env.GOG_KEYRING_PASSWORD;
    const note = systemNote("webhook", {});
    expect(note).toContain("payload.json");
    expect(note).toContain(".bullpen/out");
  });
});
