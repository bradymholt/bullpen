# Bullpen — notes for Claude

A dashboard for a roster of Claude Code agents. Read `README.md` for what it does and how to
run it. This file covers what the code alone won't teach you.

## Commands

```bash
npm run dev        # API on :4322, Vite on :5173 — open :5173
npm test           # vitest, server package
npm run typecheck  # both packages
npm run build && npm start   # single port, the way the container runs
```

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

`run_events` is append-only with a monotonic `seq` per run, and it is the source of truth for
a run's timeline. A client subscribes with `sinceSeq`; the server replays from SQLite and then
streams live over the same path. Reconnect, fresh page load, and server restart are all the
same code path — keep it that way.

## Invariants that cost real debugging

**Always streaming-input mode.** `ClaudeRunner` passes an `AsyncIterable` prompt, never a
string. The SDK exposes `interrupt()`, `setPermissionMode()` and `setModel()` *only* in that
mode, so a string prompt silently costs the stop button and mid-run mode changes.

**Three workspace kinds, two old spellings.** `scratch` (a per-agent directory kept between runs,
and the answer for agents that never touch code), `existing` (a path you name, used in place — the
agent edits a live working tree and is never cleaned up), and `clone` (fresh clone on a new branch
per run, deleted after). Stored records may still say `persistent` and `git`; both parse and mean
`scratch` and `clone`. `removeWorkspace` only deletes below `workspacesDir`, which is what keeps an
`existing` directory safe.

**Agent workspaces must live outside any checkout.** `dataDir` defaults to `~/.bullpen`, not
`./data`. Claude Code collects CLAUDE.md from every parent of its cwd, so a workspace under
`packages/server/data/` hands an agent cloned into some other repo *bullpen's own* instructions
as project context — it then reports being in the wrong directory, and it's right.

**Skills need `settingSources: ["project", "user"]`, and that switches off approvals.** Skills in
`~/.claude/skills` are invisible under `["project"]` alone, but adding `"user"` also loads
`~/.claude/settings.json` — and a `permissions.allow` entry there auto-approves that tool without
ever reaching `canUseTool`. Measured on a bare `Bash` allow rule: 1 approval prompt became 0.
`inheritUserSettings` is on by default because the skills are the point, so an agent's real
permission surface is `~/.claude/settings.json` plus its own — turn it off for an agent whose
approvals must actually be asked.

**`auto` never reaches the approval UI.** A classifier decides each call and a denial is final —
the agent is told to stop and explain, and `canUseTool` is never invoked. Measured: the same curl
that `default` escalated, `auto` approved with zero escalations. So it is closer to `full` than to
`supervised`, and it is the only sane mode for an unattended run, since a pending approval has no
timeout and a cron agent has nobody to answer it.

**A run cannot widen into `full` mid-flight.** The harness rejects
`setPermissionMode("bypassPermissions")` unless the session was launched with
`--dangerously-skip-permissions` — "Cannot set permission mode to bypassPermissions because the
session was not launched with ...". Every other mode switches fine. The run-view dropdown
therefore offers `full` only when the run already started there, and `setRunPermissionMode`
returns the refusal instead of a bare boolean so the UI can't claim a mode the run never entered.

**An unanswered approval expires rather than wedging the agent.** There is no timeout in the
SDK, so a prompt nobody answers holds the run in `awaiting_approval` forever — and a
`concurrency: skip` agent then refuses every later trigger with a 409, which is how one stuck
`AskUserQuestion` silenced a webhook agent for hours. `makeCanUseTool` denies after
`approvalTimeoutMs` (15 minutes, `BULLPEN_APPROVAL_TIMEOUT_MS`) with a message telling the agent
to continue without the tool or stop.

**`canUseTool` must never resolve to `null`.** There is no timeout on a permission prompt; a
null reply blocks that tool for the life of the process. An abort resolves to an explicit deny.

**Auto-approved tools never reach `canUseTool`.** A bare `allowedTools: ["Read"]` entry, or
`bypassPermissions`, skips the approval UI entirely. Prefer scoped rules like `Bash(ls *)`.
Separately, Claude Code auto-approves commands it classifies as trivially safe — a supervised
agent running `echo` never prompts, but a file write does. Test approval changes with a write.

**New agents default to `allow` + `ephemeral`, and the two go together.** A dropped trigger is
lost for good — there is no queue — so `skip` silently loses the second of two webhooks that land
close together. Running in parallel is only safe when runs do not share a directory, which is why
the workspace default moved with it. `allow` on a `scratch` or `existing` workspace means parallel
runs overwrite each other's files, `.bullpen/payload.json` included; the editor warns on that pair.
An ephemeral directory is now kept when a run does not reach `completed`, since it is the only
evidence a failure leaves.

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

**Webhook shape is per-agent, and header names are lowercased before lookup.** `presetFor()`
resolves `webhookMode` to a signature header, prefix, event header and handshake header — `github`
(`x-hub-signature-256`, `sha256=`), `asana` (`x-hook-signature`, bare hex, echoes `x-hook-secret`),
`token`, or `custom` from the agent's own fields. The route now forwards every request header, so
a configured name that isn't lowercased silently matches nothing — that cost a debugging round.
`hmac` is the pre-preset spelling of `github` and `token` of a bare `custom`; both still parse, so
old records round-trip. The event allowlist is GitHub's alone — it is the only sender that names
its event in a header — so `webhookEvents` does nothing for the others.

**Slack signs `v0:{timestamp}:{body}`, not the body.** Same algorithm, different input, so a
body-only HMAC never matches — that is why a generic custom preset can't carry Slack. It also needs
a five-minute skew window, `X-Slack-Retry-Num` dropped rather than run twice, `event_id` as the
dedup key (Slack puts it in the body), the event name read from `event.type`, and the
`url_verification` challenge echoed *in the body* where Asana echoes a header. Signature is checked
before the challenge is answered, so the signing secret must be pasted in first.

**An Asana handshake is only honoured while the agent has no secret.** Asana picks the secret and
asks for it back; accepting that unconditionally would let anyone who knows the URL replace a live
hook's secret and then sign their own payloads. Clear the secret to re-register.

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
- **Nothing sweeps `workspacesDir`.** A failed ephemeral run keeps its directory on purpose, and
  no boot-time or age-based cleanup removes it, so failures accumulate on disk.
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
