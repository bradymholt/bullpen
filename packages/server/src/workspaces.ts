import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

export type WorkspaceKind = "git" | "persistent";

export type WorkspaceSpec = {
  kind: WorkspaceKind;
  /** git only */
  repoUrl?: string;
  baseBranch?: string;
};

export type Workspace = { path: string; branch?: string; cleanup?: () => void };

/**
 * `persistent` doubles as the "no workspace" answer: agents that never touch
 * a repo still need a cwd, and one that survives runs lets a digest agent keep
 * notes between them.
 */
export function resolveWorkspace(
  spec: WorkspaceSpec,
  ctx: { agentId: string; runId: string },
): Workspace {
  if (spec.kind === "persistent") {
    const path = join(config.agentDataDir, ctx.agentId);
    mkdirSync(path, { recursive: true });
    return { path };
  }
  const path = join(config.workspacesDir, ctx.runId);
  mkdirSync(path, { recursive: true });
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
