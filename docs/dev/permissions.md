# Permissions and approvals

Notes on permission modes, approvals and `canUseTool`.

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
