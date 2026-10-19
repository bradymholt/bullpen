import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pidsTagged, pidsUsage, PROCESS_TAG_VAR } from "./processes.ts";

function fakeProc(environs: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), "proc-"));
  for (const [pid, env] of Object.entries(environs)) {
    mkdirSync(join(dir, pid));
    writeFileSync(join(dir, pid, "environ"), env.join("\0") + "\0");
  }
  mkdirSync(join(dir, "self"));
  return dir;
}

describe("processes", () => {
  it("finds processes by exact tag, not by prefix", () => {
    const proc = fakeProc({
      "101": ["HOME=/home/node", `${PROCESS_TAG_VAR}=abc`],
      "102": [`${PROCESS_TAG_VAR}=abcd`],
      "103": ["PATH=/usr/bin"],
    });
    expect(pidsTagged("abc", proc)).toEqual([101]);
  });

  it("reads the cgroup's pids cap, and none when it is uncapped", () => {
    const capped = mkdtempSync(join(tmpdir(), "cg-"));
    writeFileSync(join(capped, "pids.current"), "4653\n");
    writeFileSync(join(capped, "pids.max"), "4653\n");
    expect(pidsUsage(capped)).toEqual({ current: 4653, max: 4653 });

    const uncapped = mkdtempSync(join(tmpdir(), "cg-"));
    writeFileSync(join(uncapped, "pids.current"), "12\n");
    writeFileSync(join(uncapped, "pids.max"), "max\n");
    expect(pidsUsage(uncapped)).toBeNull();
  });
});
