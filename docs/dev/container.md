# Container image

Notes on what the image carries and why. Deployment itself is in `AGENTS.md`.

**`better-sqlite3` publishes no prebuilt binaries at all.** It always compiles from source, so
the Dockerfile has a build stage with python3/make/g++ and the runtime stage ships no compiler.

**The container's Claude config is `/data/claude`, not `~/.claude`.** `CLAUDE_CONFIG_DIR` is
set in the image and honoured by both the harness and `detectClaudeCredential()`, so skills and
`settings.json` live in the data volume as files you can version, and `~/.claude.json` (machine
MCP) is simply absent — agents own their MCP config anyway. `GOG_HOME=/data/gog` does the same
for gog. **Never put a `CLAUDE.md` under `/data`**: workspaces live there, and the harness
collects `CLAUDE.md` from every parent of cwd — the same trap as `packages/server/data/`, one
level up. Because `HOME` is still `/home/node`, an agent reaching for `~/.claude/skills` — which
is the reflex — gets `No such file or directory` and burns a turn finding the real path, so
`systemNote` names the config dir whenever it is not `~/.claude`; it stays silent on a laptop,
where the default is already right.

**A browser is in the image by default (`WITH_BROWSER=0` opts out), and the binary is lazy.** `npx
@playwright/mcp` fetches the server, never a browser, and Chromium needs OS libraries the slim image
lacks — so the image installs `@playwright/mcp` globally plus those libraries (root-only), and
`/usr/local/bin/playwright-mcp` is a wrapper that downloads Chromium into
`PLAYWRIGHT_BROWSERS_PATH=/data/browsers` on first use (the full build, not the headless shell —
`--browser chromium` selects Playwright's chromium channel, which runs the full binary headless), through the Playwright version the package
pins (a mismatched Playwright looks for a different Chromium build). The volume keeps it across
deploys; an image nobody browses from never carries it. The MCP server
defaults to the `chrome` channel — Google Chrome at /opt/google/chrome, which is not there — so the
config needs `--browser chromium`; and under Docker's default seccomp profile Chromium's sandbox
cannot start, hence `--no-sandbox`.

**`gh`, `gog`, `python3` and `jq` are all in the image, and none of them arrive on their own.**
The SDK brings the `claude` binary and nothing else, so the agents' `gh api` calls need the CLI
installed separately. Plain `git` ignores `GITHUB_TOKEN`, so an agent's own `git clone` (or
`gh repo clone`, which shells out to it) of a private repo died on "could not read Username" until
`/etc/gitconfig` got `gh auth git-credential` as the github.com helper. Bullpen's own git calls
still pass their helper per command in `gitEnv()`, and the process env has no token on the box,
so the system helper finds nothing there and git falls through to it. `python3` and `jq` are there because agents reach for them unprompted to read
a payload, and a `command not found` costs a turn. `gog` used to install only when `GOG_URL` was
passed at build — but CI builds with no build args at all, so the deployed image never had it and
the email-archiving skill failed every run. It is now a wrapper that downloads the 44MB binary into
`/data/bin` on first use, the same trade the Chromium wrapper makes; `GOG_VERSION` and `GOG_URL` are
`ENV`, not `ARG`, because the wrapper reads them at run time. There is no npx path — `openclaw/gogcli`
publishes to GitHub releases, not npm — and `gog mcp` is a subcommand of that binary, so the MCP
server needs the wrapper too. Being a static Go binary with no OS library dependencies is what lets
the wrapper alone suffice, where Chromium also needed a root-time apt install.

**A gog `GOG_HOME` is portable, but its layout is not the Mac's.** The file keyring is encrypted
with `GOG_KEYRING_PASSWORD`, so copying the directory carries the OAuth tokens and no browser flow
runs on the box — but `credentials.json` sits at `$GOG_HOME/data/`, not beside `config.json` in
`$GOG_HOME/config/`, and a copy that puts it in the obvious place reports "No OAuth client
credentials stored" while `auth list` still shows both accounts, which reads like a token problem
and isn't. The client secret lives in the keyring, never in `credentials.json`. `GOG_KEYRING_PASSWORD`
belongs in the agent's own env; nothing else reads it. `file` is the only backend that works on
the box at all — `keychain` errors with "Specified keyring backend not available" and `auto` lands
on `file` — but it is not required on the *source* machine: `gog auth tokens export/import` reads
any backend and is the way in from one still on Keychain. It moves tokens only, so that route also
needs `gog auth credentials set`; the copy route carries the client secret with it.

**Don't add a global `@anthropic-ai/claude-code`.** The Agent SDK spawns the harness binary it
bundles; a global install is a second 200MB copy nothing runs. The build also deletes the musl
variants, which a glibc base never executes.
