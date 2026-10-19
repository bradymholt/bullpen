# Env and spaces

Notes on layered env, secret masking and spaces.

**Env is three layers, and the mask rule applies to all of them.** A run's env is
`process.env` → global (`global_config`, one row) → the agent's space (`space_secrets.env`) →
the agent's own, later winning; `resolveEnv()` in `env.ts` is the one place that order lives, and
MCP `${NAME}` interpolation uses the same result. All three are stored plaintext and masked as
`••••` in every response. A PUT or PATCH that sends the mask back keeps the stored value, a typed
value replaces it, an omitted key deletes it — `mergeMaskedEnv()` is the one implementation, so
don't hand-roll it for a new scope. The server's own GitHub calls read `githubToken()`, and
credential detection reads `claudeCredential()`; both put **global env above the process**, the
same order a run sees, so the dashboard and the agents can never disagree about which token is
in force. That is also what lets a fresh install with no `.env` at all be set up from the
browser: health reports `none`, the app renders `SetupView` instead of the dashboard, and the
tokens it collects go to global env. Setting env on a space with no row yet mints a webhook secret and id it may never use;
that's fine — neither is ever shown.

**Every agent is in a space, and `General` is the one that is always there.** `agents.space` is
still a nullable column, but the API never writes null: the schema requires a name, new agents
default to `DEFAULT_SPACE`, imports coerce a missing or null space, and migration 0017 backfilled
the old "unassigned" rows. Spaces are otherwise a GROUP BY over that column plus a `space_secrets`
side row, so removing a space (`DELETE /spaces/:name`) is "move the members to General and drop
the row". General itself cannot be renamed or removed — it is where those members go — but has a
shared webhook URL and env like any other. It shows in the rail only while it has agents.
