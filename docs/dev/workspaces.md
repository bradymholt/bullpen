# Workspaces and artifacts

Notes on workspace kinds, their lifetimes, and the files an agent hands back.

**Three workspace kinds, two old spellings.** `scratch` (a per-agent directory kept between runs,
and the answer for agents that never touch code), `existing` (a path you name, used in place — the
agent edits a live working tree and is never cleaned up), and `clone` (fresh clone on a new branch
per run, kept for its diff). Stored records may still say `persistent` and `git`; both parse and mean
`scratch` and `clone`. `removeWorkspace` only deletes below `workspacesDir`, which is what keeps an
`existing` directory safe.

**Agent workspaces must live outside any checkout.** `dataDir` defaults to `~/.bullpen`, not
`./data`. Claude Code collects CLAUDE.md from every parent of its cwd, so a workspace under
`packages/server/data/` hands an agent cloned into some other repo *bullpen's own* instructions
as project context — it then reports being in the wrong directory, and it's right.

**New agents default to `allow` + `ephemeral`, and the two go together.** A dropped trigger is
lost for good — there is no queue — so `skip` silently loses the second of two webhooks that land
close together. Running in parallel is only safe when runs do not share a directory, which is why
the workspace default moved with it. `allow` on a `scratch` or `existing` workspace means parallel
runs overwrite each other's files, `.bullpen/payload.json` included; the editor warns on that pair.
An ephemeral directory is now kept when a run does not reach `completed`, since it is the only
evidence a failure leaves. A completed one is kept for `workspaceRetentionHours` (global, default 24) and
removed by `sweepWorkspaces()` at boot and hourly; 0 restores removal at run end. A `failed`,
`cancelled` or `interrupted` one goes in the same sweep after `failedWorkspaceRetentionHours`
(7 days, `BULLPEN_FAILED_WORKSPACE_RETENTION_HOURS`), never sooner than a completed one. Clones are
kept for their diff until GitHub reports their branch's pull request closed (`sweepMergedClones`).

**Files an agent hands back live in `.bullpen/out/`, and only there.** Every run's system prompt
says so. When a run ends, `collectArtifacts` moves that directory to `artifacts/<runId>/` under
the data dir *before* an ephemeral workspace is deleted — that ordering is the whole point — and
appends an `artifacts` event. The run page lists them from disk (nothing in the database) and the
download route resolves names inside that one directory, refusing `..` outright. `?inline=1`
previews a web type in place instead of downloading — an agent's `report.html` is usually the
email it just sent, and downloading a file to find out what went out is a poor way to read it.
That response is served `Content-Security-Policy: sandbox` plus `nosniff`: the markup is an
agent's, it renders on the dashboard's own origin, and an opaque origin with no scripts is what
keeps a preview from reaching the API that origin serves. Anything not in `INLINE_TYPES` ignores
the parameter and downloads.
