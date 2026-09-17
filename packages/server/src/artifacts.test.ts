import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
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
