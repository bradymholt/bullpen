import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.BULLPEN_DATA = mkdtempSync(join(tmpdir(), "bullpen-test-"));
const { runDisallowedTools, toSdkPermissionMode } = await import("./ClaudeRunner.ts");

describe("permission mode mapping", () => {
  it("maps bullpen's modes onto the SDK's", () => {
    expect(toSdkPermissionMode("supervised")).toBe("default");
    expect(toSdkPermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(toSdkPermissionMode("plan")).toBe("plan");
    expect(toSdkPermissionMode("auto")).toBe("auto");
    expect(toSdkPermissionMode("full")).toBe("bypassPermissions");
    expect(toSdkPermissionMode("locked")).toBe("dontAsk");
  });

  it("falls back to the prompting mode, never to bypass", () => {
    expect(toSdkPermissionMode("nonsense")).toBe("default");
    expect(toSdkPermissionMode("")).toBe("default");
  });
});

describe("run disallowed tools", () => {
  it("always blocks the /loop scheduling tools, alongside the agent's own list", () => {
    expect(runDisallowedTools(["AskUserQuestion"])).toEqual([
      "AskUserQuestion",
      "ScheduleWakeup",
      "CronCreate",
      "CronDelete",
      "CronList",
    ]);
    expect(runDisallowedTools(["ScheduleWakeup"]).filter((t) => t === "ScheduleWakeup")).toHaveLength(1);
  });
});
