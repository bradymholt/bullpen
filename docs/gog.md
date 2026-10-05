# gog (Gmail)

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
