import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Set in every runner process's env so its descendants can be found after it
 * exits. A process group would not do: the harness puts background shells in
 * their own, and git's auto-maintenance calls setsid. The env survives both.
 */
export const PROCESS_TAG_VAR = "BULLPEN_PROCESS_TAG";

/** Linux only: without `/proc` there is nothing to find. */
export function pidsTagged(tag: string, procDir = "/proc"): number[] {
  let entries: string[];
  try {
    entries = readdirSync(procDir);
  } catch {
    return [];
  }
  const want = `${PROCESS_TAG_VAR}=${tag}`;
  const found: number[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      if (readFileSync(join(procDir, entry, "environ"), "latin1").split("\0").includes(want)) found.push(pid);
    } catch {
      // Exited mid-scan, or not ours to read.
    }
  }
  return found;
}

function parentOf(pid: number): number | null {
  try {
    return Number(/^PPid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]);
  } catch {
    return null;
  }
}

function commandOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "latin1").split("\0").join(" ").trim().slice(0, 80);
  } catch {
    return "?";
  }
}

/** The harness kills a background task's shell, not what the shell started; those outlive the session. */
export function killLeftovers(tag: string): void {
  // Our own child is the harness itself, which may still be writing its transcript on the way out.
  const pids = pidsTagged(tag).filter((pid) => parentOf(pid) !== process.pid);
  if (pids.length === 0) return;
  const commands = pids.map(commandOf);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  console.warn(`[bullpen] killed ${pids.length} leftover process(es): ${commands.join(" | ")}`);
}

/** Tasks (threads included) in this container's cgroup against its cap; null when uncapped or not cgroup v2. */
export function pidsUsage(cgroupDir = "/sys/fs/cgroup"): { current: number; max: number } | null {
  try {
    const current = Number(readFileSync(join(cgroupDir, "pids.current"), "utf8"));
    const max = Number(readFileSync(join(cgroupDir, "pids.max"), "utf8"));
    return Number.isFinite(current) && Number.isFinite(max) ? { current, max } : null;
  } catch {
    return null;
  }
}
