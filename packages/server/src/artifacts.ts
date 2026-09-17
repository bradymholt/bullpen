import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, cpSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { config } from "./config.ts";

/**
 * Files an agent wants to hand back. The convention is one directory in the
 * workspace, `.bullpen/out/`; when the run ends its contents move to
 * `artifacts/<runId>/` in the data dir, so they outlive a workspace that is
 * deleted (a fresh directory after a clean run) and can be downloaded from
 * the run page. Nothing is recorded in the database — the directory is the
 * record.
 */

export const OUT_DIR = join(".bullpen", "out");

export type Artifact = { name: string; size: number };

export function artifactsDir(runId: string): string {
  return join(config.artifactsDir, runId);
}

/** Moves `.bullpen/out/*` out of the workspace; returns how many files were kept. */
export function collectArtifacts(runId: string, workspacePath: string): number {
  const src = join(workspacePath, OUT_DIR);
  if (!existsSync(src) || !statSync(src).isDirectory()) return 0;
  const dest = artifactsDir(runId);
  mkdirSync(dest, { recursive: true });
  try {
    // Same filesystem in the common case; cpSync+rmSync covers a mounted workspace.
    for (const entry of readdirSync(src)) renameSync(join(src, entry), join(dest, entry));
  } catch {
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
  return listArtifacts(runId).length;
}

/** Every file under the run's artifact dir, nested paths flattened to `a/b.txt`. */
export function listArtifacts(runId: string): Artifact[] {
  const root = artifactsDir(runId);
  if (!existsSync(root)) return [];
  const out: Artifact[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out.push({ name: relative(root, p).split(sep).join("/"), size: statSync(p).size });
    }
  };
  walk(root);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The absolute path for a listed name, or null for anything that escapes the run's directory. */
export function artifactPath(runId: string, name: string): string | null {
  // `..` is refused outright, even where it would resolve back inside.
  if (name.split(/[\\/]/).includes("..")) return null;
  const root = resolve(artifactsDir(runId));
  const p = resolve(root, name);
  if (p !== root && !p.startsWith(root + sep)) return null;
  if (!existsSync(p) || !statSync(p).isFile()) return null;
  return p;
}
