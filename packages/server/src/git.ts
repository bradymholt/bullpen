import { config } from "./config.ts";
import { git } from "./workspaces.ts";

export type FileChange = { path: string; status: string };

export function status(cwd: string): FileChange[] {
  return git(cwd, ["status", "--porcelain=v1"])
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
}

/** Everything the run changed, staged or not, including new files. */
export function diff(cwd: string): string {
  git(cwd, ["add", "-AN"]);
  return git(cwd, ["diff"]);
}

export function commit(cwd: string, message: string): string {
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", "user.email=bullpen@localhost", "-c", "user.name=Bullpen", "commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

export function push(cwd: string, branch: string): void {
  git(cwd, ["push", "-u", "origin", branch]);
}

/** owner/repo from any of the URL shapes git remotes come in. */
export function parseRepo(remote: string): { owner: string; repo: string } | null {
  const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2] } : null;
}

export async function openPullRequest(opts: {
  cwd: string;
  branch: string;
  title: string;
  body?: string;
  base?: string;
}): Promise<{ url: string; number: number }> {
  if (!config.githubToken) throw new Error("GITHUB_TOKEN is not set");

  const remote = git(opts.cwd, ["remote", "get-url", "origin"]).trim();
  const repo = parseRepo(remote);
  if (!repo) throw new Error(`origin is not a GitHub remote: ${remote}`);

  const base =
    opts.base ??
    git(opts.cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]).trim().split("/").pop() ??
    "main";

  const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.githubToken}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: opts.title, body: opts.body ?? "", head: opts.branch, base }),
  });

  if (!res.ok) throw new Error(`GitHub rejected the pull request: ${res.status} ${await res.text()}`);
  const pr = (await res.json()) as { html_url: string; number: number };
  return { url: pr.html_url, number: pr.number };
}
