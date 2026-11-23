import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.BULLPEN_DATA = mkdtempSync(join(tmpdir(), "bullpen-artifacts-"));
const { artifactPath, collectArtifacts, listArtifacts } = await import("./artifacts.ts");

describe("artifacts", () => {
  it("moves .bullpen/out out of the workspace and lists it, nested paths included", () => {
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    mkdirSync(join(ws, ".bullpen", "out", "shots"), { recursive: true });
    writeFileSync(join(ws, ".bullpen", "out", "report.txt"), "hello");
    writeFileSync(join(ws, ".bullpen", "out", "shots", "linear.png"), "png!");
    writeFileSync(join(ws, "scratch.txt"), "not an output");

    expect(collectArtifacts("run-1", ws)).toBe(2);
    expect(listArtifacts("run-1")).toEqual([
      { name: "report.txt", size: 5 },
      { name: "shots/linear.png", size: 4 },
    ]);
    expect(existsSync(join(ws, ".bullpen", "out", "report.txt"))).toBe(false);
    expect(existsSync(join(ws, "scratch.txt"))).toBe(true);
  });

  it("leaves a copy in .bullpen/kept for a later run, and collects each file once", () => {
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    mkdirSync(join(ws, ".bullpen", "out"), { recursive: true });
    writeFileSync(join(ws, ".bullpen", "out", "budget.xlsx"), "v1");
    expect(collectArtifacts("run-3", ws)).toBe(1);
    expect(readFileSync(join(ws, ".bullpen", "kept", "budget.xlsx"), "utf8")).toBe("v1");

    expect(collectArtifacts("run-4", ws)).toBe(0);
    expect(existsSync(join(ws, ".bullpen", "kept", "budget.xlsx"))).toBe(true);
  });

  it("leaves no copy in a git checkout", () => {
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    execFileSync("git", ["init", "-q"], { cwd: ws });
    mkdirSync(join(ws, ".bullpen", "out"), { recursive: true });
    writeFileSync(join(ws, ".bullpen", "out", "report.txt"), "hello");
    expect(collectArtifacts("run-5", ws)).toBe(1);
    expect(existsSync(join(ws, ".bullpen", "kept"))).toBe(false);
  });

  it("is a no-op without the directory", () => {
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    expect(collectArtifacts("run-2", ws)).toBe(0);
    expect(listArtifacts("run-2")).toEqual([]);
  });

  it("refuses paths that leave the run's directory", () => {
    expect(artifactPath("run-1", "report.txt")).toMatch(/run-1[\\/]report\.txt$/);
    expect(artifactPath("run-1", "shots/linear.png")).toMatch(/linear\.png$/);
    expect(artifactPath("run-1", "../run-1/report.txt")).toBeNull();
    expect(artifactPath("run-1", "../../etc/passwd")).toBeNull();
    expect(artifactPath("run-1", "missing.txt")).toBeNull();
  });
});
