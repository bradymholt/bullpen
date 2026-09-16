# Bullpen

A self-hosted dashboard for a roster of Claude Code agents — code agents that clone a repo and
open a PR, and non-code agents that fetch data and report back. Run them by hand, on a cron, or
from a webhook, and watch them work.

Agents run through [`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk),
which drives the real `claude` binary, so a Claude subscription works without an API key.

## Run it locally

Needs Node 22.16+. Nothing else — if you already use Claude Code on this machine, your
existing login is picked up automatically.

```bash
npm install
npm run dev
```

Then open **http://localhost:5173**. That starts the API on `:4322` and Vite on `:5173`
with hot reload, proxying `/api` and `/ws` to the server.

To run it the way the container does — one process, one port, no Vite:

```bash
npm run build && npm start
```

Then open **http://localhost:4322**.

To see what the container's Settings page looks like — skills pulled from a repo, MCP servers and
`CLAUDE.md` editable — without touching your own `~/.claude`:

```bash
npm run dev:managed
```

That runs against a throwaway `~/.bullpen-managed/` (its own database and `CLAUDE_CONFIG_DIR`),
so it starts at onboarding and needs a `claude setup-token` — your Mac login is invisible to a
harness pointed at another config dir. Stop it and run `npm run dev` to be back on your real
data. The sandbox keeps its state between runs; `npm run dev:managed:fresh` wipes it and starts
over at onboarding.

Other useful commands:

```bash
npm test
```

```bash
npm run typecheck
```

## Docker

```bash
cp .env.example .env   # then fill in CLAUDE_CODE_OAUTH_TOKEN
docker compose up -d
```

The container can't reach your Mac's Keychain, so it needs an explicit credential —
see below. The image builds `better-sqlite3` from source (it publishes no prebuilds),
so the first build takes a couple of minutes.

### Deploying to a server

One small Linux box, one container, deployed with [Kamal 2](https://kamal-deploy.org). The
dashboard has no login, so nothing is exposed publicly except signed webhooks: Tailscale runs
alongside the app and serves the dashboard to your tailnet, and funnels only `/api/hooks` to the
internet.

**1. Point the config at your box.** Everything deployment-specific is in two files:

- `config/deploy.yml` — the host IP, the image (`<your GitHub user>/bullpen`), and the
  Tailscale node name (`TS_HOSTNAME`).
- `.kamal/secrets` — names the secrets and reads them from your shell: `GITHUB_TOKEN` (needs
  `read:packages`, to pull the image) and `TS_AUTHKEY` (a Tailscale auth key, used once).

**2. First deploy**, from your machine, with `gem install kamal` done and SSH access to the box:

```bash
git push                      # CI builds the image and tags it with the commit sha
npm run deploy:setup          # installs Docker on the box and starts the app
kamal server exec 'chown -R 1000:1000 /srv/bullpen/data'   # the image runs unprivileged
npm run deploy
export TS_AUTHKEY=tskey-auth-…
kamal accessory boot tailscale
```

Then open `https://<node>.<tailnet>.ts.net` and walk through setup.

**3. Every deploy after that is a push to `main`.** The `build` workflow pushes the image; the
`deploy` workflow runs Kamal for that sha. For the deploy workflow to reach the box, add an Actions
secret `KAMAL_SSH_KEY` (a private key authorized on the box, used for nothing else) and a variable
`KAMAL_HOST_KEY` (the output of `ssh-keyscan -t ed25519 <host>`). To redeploy an older commit, run
the workflow by hand with its sha; `npm run deploy` does the same from your machine.

Nothing is ever built on your machine or the box — `better-sqlite3` compiles from source and a
small box hasn't the memory. A deploy stops the old container (waiting for running agents) and
starts the new one, so it costs a few seconds of downtime.

**Webhooks** go to `https://<node>.<tailnet>.ts.net:8443/api/hooks/...` — the dashboard shows
the right URL. Funnel needs the `funnel` attribute in your tailnet policy, and the tailnet's ACL
must let your devices reach each other (`{"src": ["autogroup:member"], "dst": ["autogroup:self:*"]}`
if it doesn't); until then, `kamal accessory boot tunnel` plus
`ssh -N -L 4322:127.0.0.1:4322 <user>@<host>` reaches the dashboard at `http://localhost:4322`.

**Afterwards:** `kamal app logs -f`, `kamal app details`, and
`kamal app exec -i --reuse 'claude login'` for a full Claude login on the box (what Usage and
claude.ai connectors need).

### Running headless

Everything the agents need lives in the `/data` volume, not on the box:

```
/data/bullpen.db          agents, runs, deliveries, webhook and space secrets, agent env
/data/claude/             CLAUDE_CONFIG_DIR — what ~/.claude is on your Mac
/data/claude/skills/      the skills agents invoke (pr-review, gmail-archive, …)
/data/claude/settings.json
/data/gog/                GOG_HOME — gog's OAuth tokens and keyring file
```

The image sets `CLAUDE_CONFIG_DIR=/data/claude` and `GOG_HOME=/data/gog`, and both the
harness and bullpen honour them. So `~/.claude` stops being machine state and becomes a
directory you can version. The simplest way to populate it is a git checkout of your
skills, pulled on deploy:

```bash
docker compose run --rm -v bullpen-data:/data bullpen \
  sh -c 'git clone https://github.com/<you>/claude-skills /data/claude/skills'
```

For gog, copy `~/Library/Application Support/gogcli` from a machine where both accounts
are signed in to `/data/gog`, and set `GOG_KEYRING_PASSWORD` on the agent that uses it.
gog itself is not in the image by default — pass a Linux release asset when building:

```bash
GOG_URL=https://github.com/.../gog_linux_amd64.tar.gz docker compose build
```

`.env` on the box is optional. Bring the container up with nothing but `TZ`, open the
dashboard over the tailnet, and a setup screen asks for the Claude token (from
`claude setup-token` on any logged-in machine) and, optionally, a GitHub token it verifies
before saving. Both land in global env. The screen only appears while no credential is
configured; to walk through it again later — a new token, a different skills repo — open
**`/?setup=1`**. Whatever you enter replaces the saved value; a skipped step leaves it as it is.
If you'd rather, `.env` still works and should be mode
600. Everything agents and the server need
for actual work goes in the dashboard instead: **Settings → Global environment** for things
every agent shares (`GITHUB_TOKEN` included — the server's own GitHub calls fall back to it),
a space's **Environment** for things its agents share, and the agent editor for its own. Later
scopes win. Values are stored once and never shown again. When the OAuth token
is revoked or expires, every agent fails at once; the home page's "last run failed" panel is
how you find out.

**Never put a `CLAUDE.md` in `/data`.** Agent workspaces live under it, and Claude Code
collects `CLAUDE.md` from every parent of its working directory.

## Claude credentials

Pick one, in order of preference:

1. **Subscription.** Run `claude setup-token` on a machine already logged in, and put the result
   in `CLAUDE_CODE_OAUTH_TOKEN`.
2. **Mounted config.** Point `CLAUDE_CONFIG_DIR` at a volume holding `.credentials.json`.
3. **API key.** Set `ANTHROPIC_API_KEY`.

`GET /api/health` reports which one resolved.

## What it does

- **Agents** are saved definitions — prompt, model, permission mode, tools, MCP servers, env.
  A **run** is one execution of one.
- **Workspaces** are a scratch directory kept between runs (also the answer for agents that never
  touch code), an existing directory you name — your real checkout, edited in place — or a fresh
  clone on its own branch per run.
- **Permissions** route through the SDK's `canUseTool`: supervised runs pause on a tool call
  and wait for you to allow or deny it. Modes are supervised / auto-accept edits / plan /
  auto / full access / locked. `auto` is the default — a classifier rules on each call and
  never prompts, which is what an unattended cron or webhook run needs.
- **Triggers**: run by hand, on a cron with a per-agent timezone, or from a webhook — GitHub,
  Slack, Asana (each verified the way that service actually signs), a plain token header, or
  custom header names for anything else, with an event allowlist and a delivery log.
- **Git**: review the diff a run produced, then commit, push, and open a PR.
- **Live view**: every run streams over one WebSocket. Reconnecting replays from the event
  log, so a dropped tab or a server restart loses nothing.

## Connect a GitHub webhook

**In bullpen** — open the agent, set **Trigger** to Webhook, and set **Sender** to
`GitHub — X-Hub-Signature-256`. Copy the **Webhook URL** and reveal the **Secret**; you need
both in a moment. Fill in **Only these events** with the events you want (`issues`,
`pull_request`) — leaving it empty means every event fires the agent.

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
> shows up in **Recent deliveries** as a drop — so if nothing runs, look there first.

**GitHub has to be able to reach this box.** Its servers can't route to localhost or a tailnet
address, so either expose just the hooks path publicly:

```bash
tailscale funnel --set-path=/api/hooks 4322
```

…or skip webhooks entirely and have a cron agent poll the GitHub API instead, which needs no
public surface at all. The URL bullpen shows you is built from your browser's address, so
substitute the public hostname when pasting it into GitHub.

Before pointing anything real at it, hit **Test fire** in the agent editor: it signs a request
exactly the way GitHub would, using the settings you just saved.

> **An agent that pushes to the repo whose webhook triggered it will re-trigger itself.** There
> is no loop guard yet. Don't give a repo-cloning agent a `push` trigger on the same repo it
> commits to.

## Layout

| Path | What |
|---|---|
| `packages/server` | Hono API, WebSocket, SQLite, the Agent SDK runner |
| `packages/web` | React SPA |

## Notes

- **MCP servers are shared, and off by default.** They live in the Claude config (`~/.claude.json`,
  or `CLAUDE_CONFIG_DIR/.claude.json` in the container) and are listed under Settings. An agent
  gets them only with "Use the shared MCP servers" checked — and then gets all of them, plus the
  repo's `.mcp.json` and claude.ai connectors. Reference secrets as `${NAME}` and define them
  in global, space, or agent env; the API never returns their values. To move servers from your
  Mac to a headless box, **Export** with a passphrase (the servers ride along encrypted with the
  other secrets) and **Import** on the box; on a Mac, import reports them but leaves your own
  `~/.claude.json` alone. claude.ai connectors need no setup — they come with the login.
- **Allow rules for MCP need a real server name.** `mcp__linear__*` works; `mcp__*` is ignored
  with a warning and grants nothing.
- **Cron doesn't catch up.** A fire missed while the container was down is skipped, not
  replayed.

## Security posture

No login — bind it to a private network or a tailnet. Anyone who can reach the UI can execute
code on the host. Webhook endpoints carry their own per-agent secret regardless.
