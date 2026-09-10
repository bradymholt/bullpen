import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.BULLPEN_DATA = mkdtempSync(join(tmpdir(), "bullpen-test-"));
const { nextRuns } = await import("./cron.ts");

describe("cron", () => {
  it("returns the requested number of upcoming fires, in order", () => {
    const runs = nextRuns("0 8 * * *", "UTC", 3);
    expect(runs).toHaveLength(3);
    expect([...runs].sort()).toEqual(runs);
  });

  it("respects the agent's timezone rather than the server's", () => {
    const utc = nextRuns("0 8 * * *", "UTC", 1)[0]!;
    const chicago = nextRuns("0 8 * * *", "America/Chicago", 1)[0]!;
    expect(utc).not.toEqual(chicago);
    expect(new Date(utc).getUTCHours()).toBe(8);
    expect(new Date(chicago).getUTCHours()).not.toBe(8);
  });

  it("throws on a nonsense expression so the editor can say so", () => {
    expect(() => nextRuns("not a cron", "UTC")).toThrow();
  });
});
