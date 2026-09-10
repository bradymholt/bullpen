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
      allowPromptOverride: true,
      concurrency: "allow",
    });
    expect(parsed).toEqual({
      webhookEvents: ["issues", "pull_request"],
      webhookMode: "hmac",
      allowPromptOverride: true,
      concurrency: "allow",
    });
  });

  it("defaults a new agent to the safe end of every switch", () => {
    const parsed = agentCreateSchema.parse({ name: "Fresh" });
    expect(parsed).toMatchObject({
      permissionMode: "supervised",
      inheritMachineMcp: false,
      allowPromptOverride: false,
      concurrency: "skip",
      webhookMode: "token",
      workspaceConfig: { kind: "persistent" },
    });
  });

  it("requires a repo url for a git workspace", () => {
    expect(agentCreateSchema.safeParse({ name: "x", workspaceConfig: { kind: "git" } }).success).toBe(false);
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
