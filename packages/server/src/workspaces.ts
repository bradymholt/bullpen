import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

export type WorkspaceSpec =
  | { kind: "persistent" }
  | { kind: "git"; repoUrl: string; baseBranch?: string };

export type Workspace = { path: string; branch?: string };

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "agent";
}

/**
 * A token in the remote URL ends up in .git/config and in every error message
 * the agent can read. Passing it per-command keeps it out of both.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (config.githubToken) {
    env.GIT_ASKPASS = "";
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "credential.https://github.com.helper";
    env.GIT_CONFIG_VALUE_0 = `!f() { echo username=x-access-token; echo password=${config.githubToken}; }; f`;
  }
  return env;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/**
 * `persistent` doubles as the "no workspace" answer: agents that never touch a
 * repo still need a cwd, and one that survives runs lets a digest agent keep
 * notes between them.
 */
export function resolveWorkspace(
  spec: WorkspaceSpec,
  ctx: { agentId: string; agentName: string; runId: string },
): Workspace {
  if (spec.kind === "persistent") {
    const path = join(config.agentDataDir, ctx.agentId);
    mkdirSync(path, { recursive: true });
    return { path };
  }

  const path = join(config.workspacesDir, ctx.runId);
  mkdirSync(path, { recursive: true });
  const branch = `bullpen/${slug(ctx.agentName)}/${ctx.runId.slice(0, 8)}`;

  try {
    const args = ["clone", "--depth", "50"];
    if (spec.baseBranch) args.push("--branch", spec.baseBranch);
    args.push(spec.repoUrl, ".");
    git(path, args);
    git(path, ["checkout", "-b", branch]);
  } catch (err) {
    rmSync(path, { recursive: true, force: true });
    throw new Error(`clone failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { path, branch };
}

export function removeWorkspace(path: string): void {
  if (!path.startsWith(config.workspacesDir)) return; // never delete a persistent dir
  rmSync(path, { recursive: true, force: true });
}
