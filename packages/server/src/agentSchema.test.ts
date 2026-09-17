import { describe, expect, it } from "vitest";
import { agentCreateSchema, agentPatchSchema } from "./agentSchema.ts";

describe("agent schema", () => {
  it("accepts a whole agent record round-tripped from the UI", () => {
    const fromApi = {
      id: "abc",
      workspaceKind: "git",
      webhookSecret: "shh",
      createdAt: 1,
      updatedAt: 2,
      name: "Repo Bot",
      prompt: "do the thing",
      workspaceConfig: { kind: "git", repoUrl: "https://example.com/r.git" },
    };
    expect(agentPatchSchema.safeParse(fromApi).success).toBe(true);
  });

  it("rejects a misspelled field instead of dropping it", () => {
    const result = agentPatchSchema.safeParse({ name: "x", webhookEvent: ["issues"] });
    expect(result.success).toBe(false);
  });

  it("keeps the webhook fields that used to be silently discarded", () => {
    const parsed = agentPatchSchema.parse({
      webhookEvents: ["issues", "pull_request"],
      webhookMode: "hmac",
      concurrency: "allow",
    });
    expect(parsed).toEqual({
      webhookEvents: ["issues", "pull_request"],
      webhookMode: "hmac",
      concurrency: "allow",
    });
  });

  it("defaults a new agent so overlapping triggers all run, each in its own directory", () => {
    const parsed = agentCreateSchema.parse({ name: "Fresh" });
    expect(parsed).toMatchObject({
      // `auto` on purpose: an unattended run that stops for approval never resumes.
      permissionMode: "auto",
      inheritMachineMcp: false,
      // These two only make sense together: dropping a trigger loses it for good,
      // but running in parallel is only safe when runs do not share a directory.
      concurrency: "allow",
      workspaceConfig: { kind: "ephemeral" },
      webhookMode: "custom",
      trigger: "manual",
      space: "General",
      sharedMcpPick: null,
    });
  });

  it("takes a pick of shared MCP servers by name, or null for all", () => {
    expect(agentPatchSchema.parse({ sharedMcpPick: ["dd"] })).toEqual({ sharedMcpPick: ["dd"] });
    expect(agentPatchSchema.parse({ sharedMcpPick: null })).toEqual({ sharedMcpPick: null });
    expect(agentPatchSchema.safeParse({ sharedMcpPick: [""] }).success).toBe(false);
  });

  it("puts a blank or missing space in the default one, and never stores null", () => {
    expect(agentCreateSchema.parse({ name: "x", space: "  work " })).toMatchObject({ space: "work" });
    expect(agentCreateSchema.safeParse({ name: "x", space: "" }).success).toBe(false);
    expect(agentCreateSchema.safeParse({ name: "x", space: null }).success).toBe(false);
    expect(agentPatchSchema.safeParse({ space: null }).success).toBe(false);
  });

  it("takes an id on create so a webhook URL can be shown before saving, but never on patch", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    expect(agentCreateSchema.parse({ name: "Fresh", id })).toMatchObject({ id });
    expect(agentCreateSchema.safeParse({ name: "Fresh", id: "../etc/passwd" }).success).toBe(false);
    expect(agentPatchSchema.parse({ id, name: "Renamed" })).toEqual({ name: "Renamed" });
  });

  it("takes a webhook secret on create, but never on patch", () => {
    const secret = "a".repeat(43);
    expect(agentCreateSchema.parse({ name: "Fresh", webhookSecret: secret })).toMatchObject({
      webhookSecret: secret,
    });
    expect(agentCreateSchema.safeParse({ name: "Fresh", webhookSecret: "short" }).success).toBe(false);
    expect(agentPatchSchema.parse({ webhookSecret: secret, name: "Renamed" })).toEqual({ name: "Renamed" });
  });

  it("requires a repo url to clone and a path to use an existing directory", () => {
    expect(agentCreateSchema.safeParse({ name: "x", workspaceConfig: { kind: "clone" } }).success).toBe(false);
    expect(agentCreateSchema.safeParse({ name: "x", workspaceConfig: { kind: "existing" } }).success).toBe(false);
    expect(
      agentCreateSchema.safeParse({ name: "x", workspaceConfig: { kind: "existing", path: "~/dev/x" } }).success,
    ).toBe(true);
  });

  it("still accepts the pre-rename workspace kinds", () => {
    expect(agentCreateSchema.safeParse({ name: "x", workspaceConfig: { kind: "persistent" } }).success).toBe(true);
    expect(
      agentCreateSchema.safeParse({ name: "x", workspaceConfig: { kind: "git", repoUrl: "u" } }).success,
    ).toBe(true);
  });

  it("rejects an unknown permission mode", () => {
    expect(agentCreateSchema.safeParse({ name: "x", permissionMode: "yolo" }).success).toBe(false);
  });
});

describe("patching", () => {
  it("touches only the fields it was given", () => {
    const parsed = agentPatchSchema.parse({ name: "Renamed" });
    expect(parsed).toEqual({ name: "Renamed" });
  });

  it("does not reset permission mode when renaming", () => {
    const parsed = agentPatchSchema.parse({ name: "Renamed" }) as Record<string, unknown>;
    expect("permissionMode" in parsed).toBe(false);
    expect("allowedTools" in parsed).toBe(false);
  });
});

describe("the question tool", () => {
  it("is disallowed by default in modes that never prompt", () => {
    for (const permissionMode of ["auto", "full", "locked"]) {
      const agent = agentCreateSchema.parse({ name: "a", permissionMode });
      expect(agent.disallowedTools).toEqual(["AskUserQuestion"]);
    }
  });

  it("is allowed by default in modes that do prompt", () => {
    for (const permissionMode of ["supervised", "acceptEdits", "plan"]) {
      const agent = agentCreateSchema.parse({ name: "a", permissionMode });
      expect(agent.disallowedTools).toEqual([]);
    }
  });

  it("never overrides a list the caller sent", () => {
    const agent = agentCreateSchema.parse({ name: "a", permissionMode: "auto", disallowedTools: [] });
    expect(agent.disallowedTools).toEqual([]);
  });

  it("is not applied by a patch, which must leave the agent's own list alone", () => {
    const patched = agentPatchSchema.parse({ permissionMode: "auto" });
    expect(patched).not.toHaveProperty("disallowedTools");
  });
});
