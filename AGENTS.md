# Bullpen — notes for Claude

A dashboard for a roster of Claude Code agents. Read `README.md` for what it does and how to
run it, and [`docs/using-bullpen.md`](docs/using-bullpen.md) for how agents are set up. This file
covers what the code alone won't teach you.

## Working on bullpen

Ship each change end to end without being asked: commit to a feature branch, open a PR, and
merge it. Merging `main` is what deploys — `build` pushes the image, `deploy` runs on
`workflow_run` after it and cuts a release — so an unmerged PR is an undeployed change.
`.claude/settings.json` carries the `gh pr merge` allow rule that makes this possible.

Run `npm run typecheck` and `npm test` before merging, then merge with
`gh pr merge --squash --auto`. The `default` ruleset on `main` requires the `test` check, so a
plain merge is refused while it is pending; `--auto` merges when it passes and is the standing
instruction, not something to ask about. Keep unrelated work out of the commit — the tree often holds more than one
change in progress. Don't use `--admin`, and stop rather than merge when something looks wrong.

Dependabot opens weekly npm, Actions and Docker PRs. The routine npm bumps come grouped;
`@anthropic-ai/claude-agent-sdk` is deliberately excluded from that group and arrives on its
own, because it carries the harness binary — an SDK bump is a Claude Code upgrade, and it is
the one dependency that can break the invariants below (and in `docs/dev/`) without failing a test.

## Commands

```bash
npm run dev        # API on :4322, Vite on :5173 — open :5173
npm test           # vitest, server package
npm run typecheck  # both packages
npm run build && npm start   # single port, the way the container runs
npm run dev:standalone       # sandbox: own data dir + CLAUDE_CONFIG_DIR, so Settings is editable
npm run dev:standalone:fresh # same, after wiping ~/.bullpen-standalone
npm run deploy               # kamal deploy --skip-push --version <HEAD sha>; CI must have built it, BULLPEN_HOST exported
```

Deployment is Kamal 2 (`config/deploy.yml`, `.kamal/secrets`), one host, `proxy: false`, container
published on loopback, Tailscale as an accessory for exposure — 443 tailnet-only, 8443 funneled for `/api/hooks` alone, because Funnel is per port. Kamal never builds: CI tags the image
with the bare git sha for exactly this. `.kamal/secrets` holds `$VAR` references only, so it is
committed.

Local runs need no credential setup: the SDK finds the existing `~/.claude` login. The
container does need one — see README.

Both `dev` and `start` read the repo-root `.env` via `--env-file-if-exists`, so `GITHUB_TOKEN`
and `BULLPEN_DATA` no longer depend on which shell launched the server. `BULLPEN_DATA` expands a
leading `~/` itself; env files don't.

**Never regenerate a migration that has already run.** Drizzle decides what to apply by comparing
each journal entry's `when` against `created_at` in `__drizzle_migrations`, so a replaced file
looks new and re-runs — `duplicate column name` on boot, with the server dead until the row is
hand-edited. To undo a bad migration, add the next one.

Regenerate migrations after touching `db/schema.ts`:

```bash
npm run db:generate -w @bullpen/server
```

## Shape

One Node process owns everything that executes: agent subprocesses, the filesystem, git,
credentials. The browser is a thin client that can drop and reconnect at any time. This
boundary is worth preserving — it's what makes remote access and restart-resilience fall out
for free rather than needing design.

`runs/runner.ts` is the seam between bullpen and the thing that executes an agent. `RunManager`
speaks only `Runner`/`RunnerEvents`; `ClaudeRunner` is the one implementation and owns every
Claude-shaped detail — SDK message types, mode translation, `settingSources`. A second backend
is a second `Runner` plus its own Timeline renderer, not a change anywhere else. The seam is kept
narrow on purpose: it normalizes the few facts bullpen acts on (session id, MCP status, result),
and passes raw messages through for the log rather than inventing a universal event schema.

`run_events` is append-only with a monotonic `seq` per run, and it is the source of truth for
a run's timeline. A client subscribes with `sinceSeq`; the server replays from SQLite and then
streams live over the same path. Reconnect, fresh page load, and server restart are all the
same code path — keep it that way.

## Invariants that cost real debugging

**The system-prompt note goes through `systemPrompt: { type: "preset", preset: "claude_code",
append }`.** `appendSystemPrompt` is not an `Options` key — it exists only on an unrelated control
type — and because it was passed inside a spread, the compiler's excess-property check never saw
it. The payload note and the `.bullpen/out` rule were silently dropped for every run until this was
found by an agent saving a screenshot to the workspace root. Anything added to `Options` via spread
deserves a look at `sdk.d.ts` first.

**Always streaming-input mode.** `ClaudeRunner` passes an `AsyncIterable` prompt, never a
string. The SDK exposes `interrupt()`, `setPermissionMode()` and `setModel()` *only* in that
mode, so a string prompt silently costs the stop button and mid-run mode changes.

**Write to `run_events` before broadcasting.** A client asking for `sinceSeq` must never be
able to miss an event a live subscriber already saw.

**Zod defaults must not apply on PATCH.** They apply even under `.partial()`, which once meant
renaming an agent reset its permission mode and tool lists. `agentSchema.ts` declares fields
without defaults and applies `AGENT_DEFAULTS` only on create. The schema is `.strict()` so a
misspelled field errors instead of vanishing — that is how the webhook allowlist was silently
dead for a while. Server-owned fields are stripped before that check, since the UI round-trips
whole agent records.

**`handle.done` is not "the run finished."** In streaming-input mode the session stays open after
the `result` message until its input is closed, so `done` resolves only then. `RunManager` closes it
at the result — a reply sent mid-turn is folded into that same turn, so there is no later one to
wait for — and a later reply resumes the session from its transcript in a new process. Idle
sessions used to be kept for replies; each is a ~120MB `claude` process, and 42 of them from four
days without a deploy ran the 4GB box out of memory until it stopped answering ssh. The one
exception is a result that lands while the agent has background tasks live (`background_tasks_changed`,
ambient ones excluded): an agent that backgrounds a `sleep` and ends its turn to wait gets its
result at once, and closing there kills the task and the turn its completion would have started —
which is how a review agent told to wait three minutes never approved. `ResultGate` holds that
result until a later one arrives with nothing live, or `backgroundWaitMs` (30 minutes,
`BULLPEN_BACKGROUND_WAIT_MS`) passes. Each result's `num_turns` is its own turn's while its cost is
the process's running total, so the gate sums the one and keeps the latest of the other. Because a closed session can outlive its `live` entry, the
`done` cleanup only clears state that still belongs to its own handle. Anything one-shot (the setup
token test, say) must treat `onResult` as the finish line and then close the session itself.
Awaiting `done` without closing hangs until the timeout, which is exactly how the token test first
shipped.

**A deliberate stop must not read as a failure.** The interrupted turn's `result` arrives after
we set `cancelled` and would overwrite it, so `RunManager` tracks intentionally-stopped runs.

**Child processes are reparented, not killed.** Shutdown awaits each runner's stream ending
before the process exits, or a `docker stop` leaves agents running against the API. SIGKILL
can't be caught — boot-time `recoverOrphanedRuns()` covers that by marking orphaned runs
interrupted and denying their pending approvals.

**The server runs TypeScript directly** via `node --experimental-strip-types`. That means type
annotations only — no enums, namespaces, or parameter properties — and relative imports must
carry the `.ts` extension.

## Subsystem notes

The rest of the invariants are kept per area. Read the matching file before changing that area.

- [`docs/dev/permissions.md`](docs/dev/permissions.md) — permission modes, approvals,
  `canUseTool`, `settingSources`
- [`docs/dev/workspaces.md`](docs/dev/workspaces.md) — workspace kinds, retention, `.bullpen/out`
  artifacts
- [`docs/dev/triggers.md`](docs/dev/triggers.md) — concurrency, the queue, merged deliveries,
  webhook presets (GitHub, Slack, Telegram, Asana)
- [`docs/dev/mcp.md`](docs/dev/mcp.md) — `strictMcpConfig` and picks, MCP OAuth, export/import,
  the catalog
- [`docs/dev/env-and-spaces.md`](docs/dev/env-and-spaces.md) — env layers, masking, spaces
- [`docs/dev/container.md`](docs/dev/container.md) — the Docker image, `/data` layout, the
  browser and gog wrappers

## Known gaps

- **Webhook loop guard is not built.** An agent that pushes to the repo whose webhook triggered
  it will re-trigger itself. Only the rate limit exists; the planned `sender.login` check
  against the `GITHUB_TOKEN` identity is missing.
- **PR creation's happy path is unverified** — it needs a real token and repo. Error paths work.
- **No failure notification.** A nightly agent that starts failing produces nothing, which looks
  like nothing to report. Status is visible in the UI and nowhere else.
- **Clones without a pull request accumulate.** `sweepMergedClones()` removes an aged clone once
  GitHub says every PR for its branch is closed, but one that never got a PR is kept for its diff,
  and nothing else removes it. Needs `GITHUB_TOKEN`; a clone found to have no PR is not asked
  about again until the next boot, so the hourly sweep does not re-query every old clone.
- **claude.ai connectors don't reach runs in a fresh standalone config dir.** Measured: after
  `claude login` into the sandbox dir, `claude mcp list` there shows every connector, but a `-p`/SDK
  run in that same dir reports `mcp_servers: []`, while the identical run against `~/.claude` lists
  them all. Same account, same login type — some config-dir state we haven't identified. Until it
  is, a headless box gets your own MCP servers (export → import) and no connectors.
- **Cron doesn't catch up** on fires missed while the container was down. Deliberate.
- **Single instance assumed.** Two containers on one DB double-fire every cron job.
- **No UI auth by design** — private network only. Webhooks carry their own per-agent secret
  because they're reachable by anything that can route to the box.
- **Transcript exports use the server's clock**, since that is the one an agent's shell and
  everything it writes were on. The dashboard renders timestamps in the *browser's* zone, so a
  run page and its exported transcript can still disagree when you read them from elsewhere.

## Testing

`npm test` covers the event log, permission mapping, approvals, webhook verification and
payload handling, cron timezones, the agent schema, and MCP interpolation — no API spend.

Anything touching the run loop deserves a real run against the live SDK; the mocked-executable
integration test in the plan was never built, so the stream-protocol path has only ever been
verified by hand.
