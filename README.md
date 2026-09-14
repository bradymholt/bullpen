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

- **MCP config is per agent and strict by default.** Turn on "inherit this machine's MCP
  config" to also pick up `~/.claude.json`, a repo's `.mcp.json`, and claude.ai connectors.
  Reference secrets as `${NAME}` and define them in the agent's env; the API never returns
  their values.
- **Allow rules for MCP need a real server name.** `mcp__linear__*` works; `mcp__*` is ignored
  with a warning and grants nothing.
- **Cron doesn't catch up.** A fire missed while the container was down is skipped, not
  replayed.

## Security posture

No login — bind it to a private network or a tailnet. Anyone who can reach the UI can execute
code on the host. Webhook endpoints carry their own per-agent secret regardless.
