# Using bullpen

How to set up agents and wire them to the things that trigger them. For installing and deploying
bullpen itself, see the [top-level README](../README.md).

- [Agents and runs](#agents-and-runs)
- [Permissions](#permissions)
- [Triggers](#triggers)
- [Connect a GitHub webhook](#connect-a-github-webhook)
- [Environment and secrets](#environment-and-secrets)
- [MCP servers](#mcp-servers)
- [Email (gog)](#email-gog)

## Agents and runs

An **agent** is a saved definition — prompt, model, permission mode, tools, MCP servers, env. A
**run** is one execution of one. Every agent belongs to a **space**; `General` is the one that is
always there, and a space can share a webhook URL and env across its agents.

Each agent has a **workspace**, one of:

- **Fresh directory** (the default) — a new empty folder per run, removed a while after the run
  completes (Settings sets how long) and kept if it fails. Nothing carries over, which is what
  lets several runs of one agent work at once.
- **Scratch directory** — one folder the agent reuses every run, so it can keep notes or caches.
  The answer for agents that never touch code.
- **Existing directory** — a folder you name, such as your real checkout, edited in place and
  never cleaned up.
- **Git clone** — a fresh clone on its own branch per run. Review the diff a run produced, then
  commit, push, and open a PR from the run page.

Runs of one agent can overlap by default. On a scratch or existing directory, that means they
overwrite each other's files — the editor warns about it.

Files an agent hands back go in `.bullpen/out/` in its workspace. When the run ends they are
listed on the run page to download, and web types such as `report.html` can be previewed in place.

Every run streams live. Reconnecting replays from the event log, so a closed tab or a server
restart loses nothing.

## Permissions

Tool calls route through the SDK's `canUseTool`. The modes are:

| Mode | Behaviour |
|---|---|
| **Auto** (default) | A classifier rules on each call and never prompts; a denial is final. What an unattended cron or webhook run needs. |
| **Manual** | Pauses on each tool call until you allow or deny it. |
| **Accept edits** | File edits go through; commands still ask. |
| **Plan** | Read and plan only, no changes. |
| **Bypass permissions** | Accepts everything. A run can only be in it if it started there. |
| **Locked** | Denies anything not in the agent's allowed tools. |

An approval nobody answers is denied after 15 minutes, so a forgotten prompt can't wedge an
agent.

**Use the shared skills and global CLAUDE.md** is on by default, since that is what makes your
skills invokable. It also brings along the `permissions.allow` rules in that config's
`settings.json`, which run without asking even on a Manual agent. Turn it off for an agent whose
approvals must actually be asked.

Allow rules for MCP tools need a real server name: `mcp__linear__*` works; `mcp__*` is ignored
with a warning and grants nothing.

## Triggers

Run an agent by hand, on a cron with its own timezone, or from a webhook.

**Cron doesn't catch up.** A fire missed while bullpen was down is skipped, not replayed.

**Webhooks** are verified the way each sender actually signs: GitHub, Slack, Asana, GroupMe,
Telegram, a plain token header or `?token=` query parameter, or custom header names for anything
else. Every request lands in the agent's **Recent webhook deliveries**, including the ones that were
dropped and why. **Test fire** in the agent editor sends a request signed exactly as the
configured sender would, using the saved settings.

The sender has to be able to reach bullpen, so `/api/hooks` needs a public route — on a deployed
server, whatever exposes it (see [Deploying to a server](../README.md#deploying-to-a-server)); on
a laptop, a tunnel such as `tailscale funnel --set-path=/api/hooks 4322`. Or skip webhooks
and have a cron agent poll the sender's API instead, which needs no public surface at all. The URL
bullpen shows is built from your browser's address, so substitute the public hostname when
pasting it elsewhere.

> **An agent that pushes to the repo whose webhook triggered it will re-trigger itself.** There
> is no loop guard yet. Don't give a repo-cloning agent a `push` trigger on the same repo it
> commits to.

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
> shows up in **Recent webhook deliveries** as a drop — so if nothing runs, look there first.

## Environment and secrets

Env comes in three scopes, later winning:

1. **Settings → Global environment** — things every agent shares. `GITHUB_TOKEN` goes here; the
   server's own GitHub calls read it too.
2. A space's **Environment** — things its agents share.
3. The agent editor — the agent's own.

Values are stored once and shown as `••••` from then on. Leave a masked value alone to keep it,
type over it to replace it, or remove the row to delete it.

When the Claude OAuth token is revoked or expires, every agent fails at once; the home page's
"last run failed" panel is how you find out.

## MCP servers

**Shared servers are off by default per agent.** They live in the Claude config
(`~/.claude.json`, or `CLAUDE_CONFIG_DIR/.claude.json` in standalone mode) and are listed under
Settings → MCP servers. An agent gets them only with **Use the shared MCP servers** checked — and
then gets all of them, plus the repo's `.mcp.json` and claude.ai connectors, unless you pick
specific servers. Otherwise an agent sees only the servers defined on it.

**Secrets** are referenced as `${NAME}` in a server's config and resolved from the run's env
(global, space, or agent). The API never returns their values.

**OAuth servers** (Datadog, Cloudflare, …) get an **Authorize** button under Settings: open the
link, approve, and paste back the `localhost` URL the browser lands on. claude.ai connectors need
no setup — they come with the login.

**Moving servers to a headless box:** under Settings → Export / import, export with a
passphrase on your Mac — the servers ride
along encrypted with the other secrets — and import on the box. On a Mac, import reports them
but leaves your own `~/.claude.json` alone.

**Suggested servers.** In standalone mode, onboarding's last step and Settings offer servers that
need no account:

- **Playwright** — a headless browser. The image carries the server and Chromium's libraries
  unless built with `WITH_BROWSER=0`; the browser itself downloads into `/data/browsers` on first
  use. `npx @playwright/mcp` alone is not enough on a box: it downloads the server, not a browser,
  and the browser needs system libraries the slim image lacks.
- **Memory** — a local knowledge graph under `/data`, so an agent can remember across runs.

A server that fails to connect doesn't fail the run — the agent just lacks those tools. The run's
timeline shows each server's status, and Settings shows the last-known state.

## Email (gog)

Agents reach Gmail through [gog](https://gogcli.sh) — the `gmail-archive` skill shells out
to it, so anything that archives a notification needs it working. Setup is one copy from a
Mac; there is no OAuth flow to run on the box.

**The image ships a wrapper, not the binary.** The first time an agent runs `gog`, the
wrapper downloads the release into `/data/bin` and execs it. That is on the volume, so it
happens once per box and survives deploys, and a box whose agents never touch email never
fetches it. `GOG_VERSION` moves the pin; `GOG_URL` points at your own binary or tarball.

**No MCP server to configure.** The skill uses the CLI. gog does have a `gog mcp`
subcommand, but it is the same binary reading the same credentials — nothing is gained by
adding it, and it would need this same setup anyway.

**The box needs the `file` keyring backend.** Not a preference — the others are unavailable
there. `keychain` fails outright with "Specified keyring backend not available", and `auto`
resolves to `file` anyway. So `GOG_KEYRING_PASSWORD` is required on the box no matter how
the credentials arrive: it is what encrypts the stored tokens.

**Auth travels from a machine with a browser.** OAuth needs one, so you sign in where you
have one and carry the result over. Two ways, and the difference is what they carry:

| | Copy the keyring directory | `gog auth tokens export` / `import` |
|---|---|---|
| Source machine's backend | must be `file` | any, Keychain included |
| Carries the OAuth client secret | yes | no — set it separately on the box |
| Accounts | all at once | one per run |

The copy is simpler when the source is already on `file`; export/import is the way in from
a machine you would rather leave on Keychain. It moves tokens only, so the box still needs
`gog auth credentials set` with the client JSON from Google Cloud Console.

To switch a Mac over — worth doing anyway if anything there runs gog unattended, since the
Keychain is locked in launchd and cron contexts and gog then fails or stores empty tokens:

```bash
gog auth keyring set file     # once; then re-add accounts if prompted
```

The copy route follows. `GOG_HOME` lays the directory out differently than a Mac does, so
stage a rearranged copy — `gog-home/` here is just a scratch folder, and it becomes
`/data/gog` on the box:

```bash
SRC=~/Library/Application\ Support/gogcli
mkdir -p gog-home/config gog-home/data/keyring
cp "$SRC/config.json"      gog-home/config/
cp "$SRC/credentials.json" gog-home/data/            # note: data/, not config/
cp "$SRC/keyring/"*        gog-home/data/keyring/
```

That `credentials.json` placement is the one trap. Put it next to `config.json` and
`gog auth list` still shows every account while `gog auth credentials list` reports
"No OAuth client credentials stored" — which reads like a token problem and is not one.
The OAuth client secret lives in the keyring, never in `credentials.json`.

Ship it to the volume as `/data/gog`, owned by uid 1000 (the container runs as `node`):

```bash
tar -czf gog-home.tgz gog-home
scp gog-home.tgz root@<host>:/tmp/
ssh root@<host> 'tar -xzf /tmp/gog-home.tgz -C /tmp \
  && rm -rf /srv/bullpen/data/gog && mv /tmp/gog-home /srv/bullpen/data/gog \
  && chown -R 1000:1000 /srv/bullpen/data/gog && rm /tmp/gog-home.tgz'
```

Then set `GOG_KEYRING_PASSWORD` in the env of the agent that uses gog — agent scope, not
global, since nothing else reads it. Without it a run fails with "Secret not found in
keyring (refresh token missing)", which is also what a missing *client secret* reports.

Verify, which doubles as warming the download so the first real run does not pay for it:

```bash
kamal app exec 'gog auth doctor'
```

Want `status ok` and a line reporting readable OAuth tokens. That staged directory holds
refresh tokens for every account you copied — treat it like a credential.
