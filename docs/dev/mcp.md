# MCP servers

Notes on how MCP servers reach a run, how they authenticate, and their health.

**`strictMcpConfig` is on unless the agent opts out — and a pick keeps it on.** Without it a run
inherits MCP servers from `~/.claude.json` (read regardless of `settingSources`), the cloned repo's
`.mcp.json`, and claude.ai connectors. That makes agents non-deterministic and leaks one agent's
MCP credentials to another. `selectMcp()` in `mcp.ts` is the one place this is decided: sharing off
→ own servers, strict; sharing on with `sharedMcpPick: null` → strict off, the harness reads
everything (the only way connectors reach a run, since they exist in no config file); sharing on
with a pick → the named shared configs are read by bullpen, `${NAME}`-interpolated from the run's
env, and passed explicitly with strict on, so nothing unpicked leaks in. Settings shows each
server's last-known state folded from runs' `mcp.status` events (`foldMcpHealth`), which is the
only health signal there is — the harness never fails a run for a server that won't connect.

**MCP allow rules need a literal server name.** `mcp__linear__*` works; `mcp__*` is ignored with
a startup warning and grants nothing.

**MCP startup is non-blocking.** A server that fails to connect does not fail the run — the
agent just quietly lacks those tools. That's why the init message's per-server status is logged
as an `mcp.status` event and rendered.

**An export carries the shared MCP servers, and import writes them only in standalone mode.** The
`SecretsBundle` has an optional `mcp` (older exports lack it) holding `mcpServers` verbatim, headers
and env included — which is why it lives inside the sealed part. `importMachineMcp` refuses without
`CLAUDE_CONFIG_DIR`, and the import route turns that refusal into `mcpNote` rather than failing the
import: on a laptop the agents still land, and the note says what did not. Onboarding has no MCP
step for the same reason there is nothing to list there: connectors come with the login, and the
config cache that names them is empty until an agent has run.

**MCP OAuth goes through `claude mcp login --no-browser`, under a pty, with bullpen delivering
the redirect.** Writing tokens ourselves would mean matching the harness's credential-store format
(`mcpOAuth["name|hash"]`, keychain on a Mac, `.credentials.json` elsewhere), so `mcpLogin.ts` runs
the CLI instead and relays: parse the authorization URL out of its output (an OSC 8 hyperlink
printed twice back to back — `parseAuthUrl`), show it, and when the user pastes the
`http://localhost:<port>/callback?code=…` URL their browser died on, write it to the CLI's stdin
*and* GET it against `127.0.0.1:<port>`, which reaches the CLI's callback listener because bullpen
shares its network namespace. The CLI refuses a non-tty stdin, hence the pty: util-linux `script`
in the container, Python's `pty` on macOS (BSD `script` wants a real tty of its own). Everything
else — token storage, refresh, the "needs-auth" status — stays the harness's.

**Shared MCP servers on a box come from a catalog the operator picks from, never from boot.**
`mcpCatalog`/`applyMcpCatalog` in `machineMcp.ts` offer Playwright (when the image has the wrapper)
and the reference memory server, pre-selected at onboarding step 4 and as "Suggested" chips under
Settings; applying is declarative over catalog keys only, so a hand-added server is never touched.
`NPM_CONFIG_CACHE=/data/npm-cache` keeps an npx-run server's download on the volume across deploys.
