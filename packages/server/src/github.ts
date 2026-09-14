import { config } from "./config.ts";

export type Repo = { fullName: string; owner: string; cloneUrl: string; private: boolean; pushedAt: string };
export type RepoList = {
  configured: boolean;
  viewer: string | null;
  /** How the list was built, since the fallback is meaningfully different. */
  source: "contributions" | "activity" | "none";
  sinceDays: number;
  repos: Repo[];
};

const WINDOW_DAYS = 183;
const TTL_MS = 5 * 60_000;
let cache: { at: number; value: RepoList } | null = null;

const headers = () => ({
  authorization: `Bearer ${config.githubToken}`,
  accept: "application/vnd.github+json",
});

function toRepo(nameWithOwner: string, isPrivate: boolean, pushedAt: string): Repo {
  return {
    fullName: nameWithOwner,
    owner: nameWithOwner.split("/")[0]!,
    cloneUrl: `https://github.com/${nameWithOwner}.git`,
    private: isPrivate,
    pushedAt,
  };
}

/** Repos this user actually committed to or opened PRs in, within the window. */
async function fromContributions(since: string): Promise<{ viewer: string; repos: Repo[] }> {
  const query = `query($from: DateTime!) {
    viewer {
      login
      contributionsCollection(from: $from) {
        commitContributionsByRepository(maxRepositories: 100) {
          repository { nameWithOwner isPrivate pushedAt }
        }
        pullRequestContributionsByRepository(maxRepositories: 100) {
          repository { nameWithOwner isPrivate pushedAt }
        }
      }
    }
  }`;

  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { from: since } }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}`);
  const json = (await res.json()) as {
    errors?: unknown[];
    data?: {
      viewer: {
        login: string;
        contributionsCollection: Record<string, { repository: { nameWithOwner: string; isPrivate: boolean; pushedAt: string } }[]>;
      };
    };
  };
  if (json.errors?.length || !json.data) throw new Error("GitHub GraphQL rejected the contributions query");

  const { login, contributionsCollection } = json.data.viewer;
  const byName = new Map<string, Repo>();
  for (const group of Object.values(contributionsCollection)) {
    for (const entry of group) {
      const r = entry.repository;
      if (!byName.has(r.nameWithOwner)) byName.set(r.nameWithOwner, toRepo(r.nameWithOwner, r.isPrivate, r.pushedAt));
    }
  }
  return { viewer: login, repos: [...byName.values()] };
}

/** Fallback when GraphQL is unavailable: anything pushed in the window, by anyone. */
async function fromActivity(since: string): Promise<{ viewer: string; repos: Repo[] }> {
  const me = await fetch("https://api.github.com/user", { headers: headers() });
  if (!me.ok) throw new Error(`GitHub ${me.status}`);
  const viewer = ((await me.json()) as { login: string }).login;

  const repos: Repo[] = [];
  for (let page = 1; page <= 4; page++) {
    const res = await fetch(
      `https://api.github.com/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
      { headers: headers() },
    );
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const batch = (await res.json()) as { full_name: string; private: boolean; pushed_at: string }[];
    for (const r of batch) {
      if (r.pushed_at < since) return { viewer, repos }; // sorted, so the rest are older
      repos.push(toRepo(r.full_name, r.private, r.pushed_at));
    }
    if (batch.length < 100) break;
  }
  return { viewer, repos };
}

export async function listRepos(force = false): Promise<RepoList> {
  if (!config.githubToken) {
    return { configured: false, viewer: null, source: "none", sinceDays: WINDOW_DAYS, repos: [] };
  }
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  let source: RepoList["source"] = "contributions";
  let found: { viewer: string; repos: Repo[] };
  try {
    found = await fromContributions(since);
  } catch {
    source = "activity";
    found = await fromActivity(since);
  }

  found.repos.sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
  const value = { configured: true, viewer: found.viewer, source, sinceDays: WINDOW_DAYS, repos: found.repos };
  cache = { at: Date.now(), value };
  return value;
}
