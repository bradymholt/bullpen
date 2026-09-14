import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.BULLPEN_DATA = mkdtempSync(join(tmpdir(), "bullpen-test-"));
const { toSdkPermissionMode } = await import("./RunManager.ts");

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
