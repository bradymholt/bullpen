# Bullpen — notes for Claude

A dashboard for a roster of Claude Code agents. Read `README.md` for what it does and how to
run it. This file covers what the code alone won't teach you.

## Commands

```bash
npm run dev        # API on :3000, Vite on :5173 — open :5173
npm test           # vitest, server package
npm run typecheck  # both packages
npm run build && npm start   # single port, the way the container runs
```

Local runs need no credential setup: the SDK finds the existing `~/.claude` login. The
container does need one — see README.

Regenerate migrations after touching `db/schema.ts`:

```bash
npm run db:generate -w @bullpen/server
```

## Shape

One Node process owns everything that executes: agent subprocesses, the filesystem, git,
credentials. The browser is a thin client that can drop and reconnect at any time. This
boundary is worth preserving — it's what makes remote access and restart-resilience fall out
for free rather than needing design.

`run_events` is append-only with a monotonic `seq` per run, and it is the source of truth for
a run's timeline. A client subscribes with `sinceSeq`; the server replays from SQLite and then
streams live over the same path. Reconnect, fresh page load, and server restart are all the
same code path — keep it that way.

## Invariants that cost real debugging

**Always streaming-input mode.** `ClaudeRunner` passes an `AsyncIterable` prompt, never a
string. The SDK exposes `interrupt()`, `setPermissionMode()` and `setModel()` *only* in that
mode, so a string prompt silently costs the stop button and mid-run mode changes.

**`canUseTool` must never resolve to `null`.** There is no timeout on a permission prompt; a
null reply blocks that tool for the life of the process. An abort resolves to an explicit deny.

**Auto-approved tools never reach `canUseTool`.** A bare `allowedTools: ["Read"]` entry, or
`bypassPermissions`, skips the approval UI entirely. Prefer scoped rules like `Bash(ls *)`.
Separately, Claude Code auto-approves commands it classifies as trivially safe — a supervised
agent running `echo` never prompts, but a file write does. Test approval changes with a write.

**Write to `run_events` before broadcasting.** A client asking for `sinceSeq` must never be
able to miss an event a live subscriber already saw.

**Zod defaults must not apply on PATCH.** They apply even under `.partial()`, which once meant
renaming an agent reset its permission mode and tool lists. `agentSchema.ts` declares fields
without defaults and applies `AGENT_DEFAULTS` only on create. The schema is `.strict()` so a
misspelled field errors instead of vanishing — that is how the webhook allowlist was silently
dead for a while. Server-owned fields are stripped before that check, since the UI round-trips
whole agent records.

**Secrets in `agents.env` are stored plaintext and masked in every API response.** A PATCH
carrying the mask back must keep the stored value — otherwise editing an unrelated field
destroys the agent's credentials. MCP config references them as `${NAME}` and interpolates once
at run start, so the stored JSON stays credential-free.

**`strictMcpConfig` is on unless the agent opts out.** Without it a run inherits MCP servers
from `~/.claude.json` (read regardless of `settingSources`), the cloned repo's `.mcp.json`, and
claude.ai connectors. That makes agents non-deterministic and leaks one agent's MCP credentials
to another.

**MCP allow rules need a literal server name.** `mcp__linear__*` works; `mcp__*` is ignored with
a startup warning and grants nothing.

**MCP startup is non-blocking.** A server that fails to connect does not fail the run — the
agent just quietly lacks those tools. That's why the init message's per-server status is logged
as an `mcp.status` event and rendered.

**A deliberate stop must not read as a failure.** The interrupted turn's `result` arrives after
we set `cancelled` and would overwrite it, so `RunManager` tracks intentionally-stopped runs.

**Child processes are reparented, not killed.** Shutdown awaits each runner's stream ending
before the process exits, or a `docker stop` leaves agents running against the API. SIGKILL
can't be caught — boot-time `recoverOrphanedRuns()` covers that by marking orphaned runs
interrupted and denying their pending approvals.

## Build and packaging

**`better-sqlite3` publishes no prebuilt binaries at all.** It always compiles from source, so
the Dockerfile has a build stage with python3/make/g++ and the runtime stage ships no compiler.

**Don't add a global `@anthropic-ai/claude-code`.** The Agent SDK spawns the harness binary it
bundles; a global install is a second 200MB copy nothing runs. The build also deletes the musl
variants, which a glibc base never executes.

**The server runs TypeScript directly** via `node --experimental-strip-types`. That means type
annotations only — no enums, namespaces, or parameter properties — and relative imports must
carry the `.ts` extension.

## Known gaps

- **Webhook loop guard is not built.** An agent that pushes to the repo whose webhook triggered
  it will re-trigger itself. Only the rate limit exists; the planned `sender.login` check
  against the `GITHUB_TOKEN` identity is missing.
- **PR creation's happy path is unverified** — it needs a real token and repo. Error paths work.
- **No failure notification.** A nightly agent that starts failing produces nothing, which looks
  like nothing to report. Status is visible in the UI and nowhere else.
- **Cron doesn't catch up** on fires missed while the container was down. Deliberate.
- **Single instance assumed.** Two containers on one DB double-fire every cron job.
- **No UI auth by design** — private network only. Webhooks carry their own per-agent secret
  because they're reachable by anything that can route to the box.

## Testing

`npm test` covers the event log, permission mapping, approvals, webhook verification and
payload handling, cron timezones, the agent schema, and MCP interpolation — no API spend.

Anything touching the run loop deserves a real run against the live SDK; the mocked-executable
integration test in the plan was never built, so the stream-protocol path has only ever been
verified by hand.
