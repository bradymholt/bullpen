# Using bullpen

How to set up agents and wire them to the things that trigger them. For installing and deploying
bullpen itself, see the [top-level README](../README.md).

- [Agents and runs](#agents-and-runs)
- [Permissions](#permissions)
- [Triggers](#triggers)
- [Connect a GitHub webhook](#connect-a-github-webhook)
- [Environment and secrets](#environment-and-secrets)
- [MCP servers](#mcp-servers)
- [Tool guides](#tool-guides)

## Agents and runs

An **agent** is a saved definition — prompt, model, permission mode, tools, MCP servers, env. A
**run** is one execution of one. Every agent belongs to a **space**; `General` is the one that is
always there, and a space can share a webhook URL and env across its agents.

Each agent has a **workspace**, one of:

- **Fresh directory** (the default) — a new empty folder per run, removed a while after the run
  completes (Settings sets how long). A failed or stopped run's folder is kept for 7 days, since
  it is the only evidence the failure leaves. Nothing carries over, which is what lets several
  runs of one agent work at once.
- **Scratch directory** — one folder the agent reuses every run, so it can keep notes or caches.
  The answer for agents that never touch code.
- **Existing directory** — a folder you name, such as your real checkout, edited in place and
  never cleaned up.
- **Git clone** — a fresh clone on its own branch per run. Review the diff a run produced, then
  commit, push, and open a PR from the run page.

**Overlapping runs** decides what happens when a trigger arrives while a run is active:

- **Allow** (the default) starts it anyway, in parallel. On a scratch or existing directory that
  means the runs overwrite each other's files — the editor warns about it.
- **Queue** holds it and runs one at a time, in order. Up to 20 can wait; beyond that a trigger
  is refused. This is the safe choice for a shared directory.
- **Skip** refuses it. A trigger that arrives mid-run is lost for good.

Files an agent hands back go in `.bullpen/out/` in its workspace. When the run ends they are
listed on the run page to download, and web types such as `report.html` can be previewed in place.

Every run streams live. Reconnecting replays from the event log, so a closed tab or a server
restart loses nothing. A run cut off by a restart is marked interrupted, with a **Restart**
button that picks it back up.

Commits and PRs an agent makes leave out Claude Code's "Generated with Claude Code" footer. Turn
it back on under Settings.

## Permissions

Tool calls route through the SDK's `canUseTool`. The modes are:

| Mode | Behaviour |
|---|---|
| **Auto** (default) | A classifier rules on each call and never prompts; a denial is final. What an unattended cron or webhook run needs. |
| **Manual** | Pauses on each tool call until you allow or deny it. |
| **Accept edits** | File edits go through; commands still ask. |
| **Plan** | Read and plan only, no changes. |
| **Bypass permissions** | Accepts everything. A run can only be in it if it started there. |
| **Locked** | Denies anything not in the agent's allowed tools. |

An approval nobody answers is denied after 15 minutes, so a forgotten prompt can't wedge an
agent.

**Always allow** on a prompt approves it and adds the narrowest matching rule to the agent's
allowed tools — `Bash(gh pr:*)` for a `gh pr view`, `Edit(src/**)` for an edit under `src/`,
`WebFetch(domain:api.github.com)` for a fetch — so later runs skip that prompt. The run that
asked is unchanged; its rules were fixed at launch.

**Use the shared skills and global CLAUDE.md** is on by default, since that is what makes your
skills invokable. It also brings along the `permissions.allow` rules in that config's
`settings.json`, which run without asking even on a Manual agent. Turn it off for an agent whose
approvals must actually be asked.

Allow rules for MCP tools need a real server name: `mcp__linear__*` works; `mcp__*` is ignored
with a warning and grants nothing.

## Triggers

Pick one in the agent editor:

- **Manual** — you start each run from the dashboard.
- **Schedule** — a cron expression with its own timezone.
- **Poll** — fetch a URL on a cron and run only when the response changes. Narrow it to a dot
  path such as `data.status` so fields that change on every request don't trigger it. The first
  check only records what is there, request headers can read `${NAME}` from the agent's env, and
  nothing needs to reach bullpen.
- **Webhook** — run when a sender calls the agent's URL.

**Cron doesn't catch up.** A fire missed while bullpen was down is skipped, not replayed.

**Webhooks** are verified the way each sender actually signs: GitHub, Slack, Asana, GroupMe,
Telegram, a plain token header or `?token=` query parameter, or custom header names for anything
else. Every request lands in the agent's **Recent webhook deliveries**, including the ones that were
dropped and why. **Test fire** in the agent editor sends a request signed exactly as the
configured sender would, using the saved settings.

Under **Which deliveries run**, a delivery has to pass filters before anything starts:

- **Only these events** — the event names to accept (GitHub only, since it is the one sender
  that names its event in a header).
- **Only run when** — conditions on dot paths into the body: *is one of*, *is not one of*,
  *contains*, or *does not contain*. All conditions in a set must hold. Split them into several
  sets when different kinds of delivery need different rules; the agent runs when any one set
  holds. Nothing is spent on a delivery that doesn't match.

Under **Each run**, **Merge deliveries** folds bursts into one run. Give it a key such as
`{{payload.pull_request.html_url}}` and a wait in seconds: a delivery waits that long, and any
with the same key that arrive meanwhile join its run. GitHub, for one, sends two
`review_requested` deliveries when you request a person and a team together.

The sender has to be able to reach bullpen, so `/api/hooks` needs a public route — on a deployed
server, whatever exposes it (see [Deploying to a server](../README.md#deploying-to-a-server)); on
a laptop, a tunnel such as `tailscale funnel --set-path=/api/hooks 4322`. Or skip webhooks
and use a **Poll** trigger on the sender's API instead, which needs no public surface at all. The URL
bullpen shows is built from your browser's address, so substitute the public hostname when
pasting it elsewhere.

> **An agent that pushes to the repo whose webhook triggered it will re-trigger itself.** There
> is no loop guard yet. Don't give a repo-cloning agent a `push` trigger on the same repo it
> commits to.

## Connect a GitHub webhook

**In bullpen** — open the agent, pick the **Webhook** trigger, and set **Sender** to
**GitHub**. Copy the **Webhook URL** and **Reveal** the **Secret**; you need both in a moment.
Fill in **Only these events** with the events you want (`issues`, `pull_request`) — leaving it
empty means every event fires the agent.

**In the repo** — Settings → Webhooks → Add webhook, then:

| Field | What to enter |
|---|---|
| **Payload URL** | The webhook URL from bullpen |
| **Content type** | **`application/json`** — the dropdown defaults to `application/x-www-form-urlencoded`, which bullpen rejects |
| **Secret** | The secret from bullpen |
| **SSL verification** | Leave **Enable SSL verification** on |
| **Which events…** | **Let me select individual events**, ticking the same ones you listed in bullpen. "Just the push event" is the default and rarely what you want |
| **Active** | Leave checked |

Then **Add webhook**. GitHub immediately sends a `ping`, which bullpen answers without starting
a run — a green tick on the hook means the URL and secret are both right.

> **Content type is the one that bites.** GitHub defaults to form-encoded, which wraps the JSON
> in a `payload=` field. Bullpen answers that with a message naming the fix, and the delivery
> shows up in **Recent webhook deliveries** as a drop — so if nothing runs, look there first.

## Environment and secrets

Env comes in three scopes, later winning:

1. **Settings → Global environment** — things every agent shares. `GITHUB_TOKEN` goes here; the
   server's own GitHub calls read it too.
2. A space's **Environment** — things its agents share.
3. The agent editor — the agent's own.

Values are stored once and shown as `••••` from then on. Leave a masked value alone to keep it,
type over it to replace it, or remove the row to delete it.

When the Claude OAuth token is revoked or expires, every agent fails at once; the home page's
"last run failed" panel is how you find out.

## MCP servers

**Shared servers are off by default per agent.** They live in the Claude config
(`~/.claude.json`, or `CLAUDE_CONFIG_DIR/.claude.json` in standalone mode) and are listed under
Settings → MCP servers. An agent gets them only with **Use the shared MCP servers** checked — and
then gets all of them, plus the repo's `.mcp.json` and claude.ai connectors, unless you pick
specific servers. Otherwise an agent sees only the servers defined on it.

**Secrets** are referenced as `${NAME}` in a server's config and resolved from the run's env
(global, space, or agent). The API never returns their values.

**OAuth servers** (Datadog, Cloudflare, …) get an **Authorize** button under Settings: open the
link, approve, and paste back the `localhost` URL the browser lands on. claude.ai connectors need
no setup — they come with the login.

**Moving servers to a headless box:** under Settings → Export / import, export with a
passphrase on your Mac — the servers ride
along encrypted with the other secrets — and import on the box. On a Mac, import reports them
but leaves your own `~/.claude.json` alone.

**Suggested servers.** In standalone mode, onboarding's last step and Settings offer servers that
need no account:

- **Playwright** — a headless browser. The image carries the server and Chromium's libraries
  unless built with `WITH_BROWSER=0`; the browser itself downloads into `/data/browsers` on first
  use. `npx @playwright/mcp` alone is not enough on a box: it downloads the server, not a browser,
  and the browser needs system libraries the slim image lacks.
- **Memory** — a local knowledge graph under `/data`, so an agent can remember across runs.

A server that fails to connect doesn't fail the run — the agent just lacks those tools. The run's
timeline shows each server's status, and Settings shows the last-known state.

## Tool guides

Setup for specific tools agents use, beyond what bullpen itself configures:

- [gog (Google Workspace)](gog.md) — giving agents Gmail, Calendar, Drive and Sheets through
  the gog CLI, and carrying its sign-in to a headless box.
