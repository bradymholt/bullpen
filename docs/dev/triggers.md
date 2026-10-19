# Queueing and webhooks

Notes on run concurrency, the queue, merged deliveries and per-sender webhook handling.

**`queue` serializes; it is the mode for a scratch-workspace agent.** `requestRun()` is the one
entry point every trigger uses. With `concurrency: queue` and an active run, the request becomes a
`runs` row with status `queued` and its payload spooled to `dataDir/queue/<runId>.json` — bodies
can be a megabyte, and the row already holds prompt and mode. `drainQueue()` starts the oldest one
when a run reaches its result — not when its session's process exits a moment later — and at boot, promoting the existing row rather than inserting a new one, so the id
a webhook delivery recorded is the id that eventually runs. Depth is capped at `QUEUE_DEPTH`;
beyond it a trigger is refused and recorded as a `queue full` delivery drop. `queued` is not an
active status: it must never count toward `agentHasActiveRun`, or the queue would block itself.

**Merged deliveries are queued rows with a `startAfter`.** An agent with `mergeKey` and
`mergeWaitSeconds` parks each webhook delivery as a `queued` row carrying the rendered key; a
later one with the same key overwrites that row's spool and prompt rather than adding a run —
GitHub sends two `review_requested` for one person-plus-team request, and each used to be its own
run. `drainQueue()` skips a row while `startAfter` is set; a timer clears it (rescheduled at boot),
then a `queue` agent's run waits its turn, a `skip` agent's is cancelled if a run is active
by then, and any other starts at once. A key that renders blank
runs unmerged.

**Webhook shape is per-agent, and header names are lowercased before lookup.** `presetFor()`
resolves `webhookMode` to a signature header, prefix, event header and handshake header — `github`
(`x-hub-signature-256`, `sha256=`), `asana` (`x-hook-signature`, bare hex, echoes `x-hook-secret`),
`telegram` (`x-telegram-bot-api-secret-token`, compared verbatim), `token`, or `custom` from the
agent's own fields. The route now forwards every request header, so
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

**A Telegram agent's typing indicator is bullpen's, not the agent's.** Asking the agent to send
it cost a full model turn before any work, and it then went out beside the reply, which clears
it at once. `startTelegramTyping` sends `sendChatAction` when a webhook run launches and every
4s until the result — not until the session's process exits, which `handle.done` waits for — reading the
chat from `.bullpen/payload.json` and the token from the run's `TELEGRAM_BOT_TOKEN`. Retries
dedup on the body's `update_id`, as Slack's do on `event_id`.

**An Asana handshake is only honoured while the agent has no secret.** Asana picks the secret and
asks for it back; accepting that unconditionally would let anyone who knows the URL replace a live
hook's secret and then sign their own payloads. Clear the secret to re-register.
