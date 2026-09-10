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

Then open **http://localhost:5173**. That starts the API on `:3000` and Vite on `:5173`
with hot reload, proxying `/api` and `/ws` to the server.

To run it the way the container does — one process, one port, no Vite:

```bash
npm run build && npm start
```

Then open **http://localhost:3000**.

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
- **Workspaces** are either a fresh git clone on its own branch per run, or a persistent
  directory that survives runs (also the answer for agents that never touch code).
- **Permissions** route through the SDK's `canUseTool`: supervised runs pause on a tool call
  and wait for you to allow or deny it. Modes are supervised / auto-accept edits / plan /
  full access / locked.
- **Triggers**: run by hand, on a cron with a per-agent timezone, or from a webhook —
  plain token or GitHub HMAC, with an event allowlist and a delivery log.
- **Git**: review the diff a run produced, then commit, push, and open a PR.
- **Live view**: every run streams over one WebSocket. Reconnecting replays from the event
  log, so a dropped tab or a server restart loses nothing.

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
- **GitHub webhooks need to reach this box.** A tailnet or LAN address won't work from
  GitHub's servers — either expose just `/api/hooks/*` (Tailscale Funnel, Cloudflare Tunnel),
  or skip webhooks and poll the API from a cron agent instead.
- **Cron doesn't catch up.** A fire missed while the container was down is skipped, not
  replayed.

## Security posture

No login — bind it to a private network or a tailnet. Anyone who can reach the UI can execute
code on the host. Webhook endpoints carry their own per-agent secret regardless.
