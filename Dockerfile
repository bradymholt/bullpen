# ---- build: compile native deps and the SPA -----------------------------
# better-sqlite3 ships no prebuilt binaries, so node-gyp needs a toolchain.
# It lives here rather than in the runtime image.
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY packages/web packages/web
RUN npm run build -w @bullpen/web

# Drop dev dependencies but keep the compiled better-sqlite3 binding.
RUN npm prune --omit=dev

# The SDK ships one prebuilt harness binary per platform and picks at runtime.
# This base is glibc, so the musl copies are ~200MB of never-executed weight.
RUN rm -rf node_modules/@anthropic-ai/claude-agent-sdk-*-musl

# ---- runtime ------------------------------------------------------------
FROM node:22-slim
# CLAUDE_CONFIG_DIR: the harness reads skills, settings.json and a global
# CLAUDE.md from here instead of ~/.claude, so agent config is a directory in
# the data volume rather than state on the box. GOG_HOME does the same for gog.
# NPM_CONFIG_CACHE on the volume: an npx-run MCP server (the memory server, say)
# is fetched once per box, not once per deploy.
ENV NODE_ENV=production BULLPEN_DATA=/data \
    CLAUDE_CONFIG_DIR=/data/claude GOG_HOME=/data/gog NPM_CONFIG_CACHE=/data/npm-cache

# git for workspace clones; ripgrep because Claude Code's search tools use it;
# ca-certificates for HTTPS to the API and remote MCP servers; gh because the
# agents drive GitHub through it and it is not something the SDK brings along;
# python3 and jq because agents reach for them unprompted to read a payload or
# pipe JSON, and a `command not found` costs the run a turn to work around.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl gnupg python3 jq \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get purge -y gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# gog (Gmail CLI) has no apt package and is a 44MB Go binary, so the image ships
# a wrapper instead and the binary downloads into the data volume the first time
# an agent runs it — the same trade the Chromium wrapper below makes. A box whose
# agents never touch email never pays for it, and the volume keeps it across
# deploys. GOG_VERSION is an ENV, not an ARG, because the wrapper reads it at run
# time; GOG_URL overrides the whole URL with any binary or .tar.gz.
ENV GOG_VERSION="0.40.0" GOG_BIN=/data/bin/gog
RUN printf '%s\n' \
  '#!/bin/sh' \
  '# Downloads gog into the data volume on first use; the image ships only this wrapper.' \
  'if [ ! -x "$GOG_BIN" ]; then' \
  '  url="${GOG_URL:-https://github.com/openclaw/gogcli/releases/download/v${GOG_VERSION}/gogcli_${GOG_VERSION}_linux_$(dpkg --print-architecture).tar.gz}"' \
  '  mkdir -p "$(dirname "$GOG_BIN")" || exit 1' \
  '  tmp="$GOG_BIN.$$"' \
  '  echo "gog: fetching $url" >&2' \
  '  case "$url" in' \
  '    *.tar.gz|*.tgz) curl -fsSL "$url" | tar -xzO --wildcards --no-anchored "gog" > "$tmp" ;;' \
  '    *) curl -fsSL "$url" -o "$tmp" ;;' \
  '  esac || { rm -f "$tmp"; echo "gog: download failed" >&2; exit 1; }' \
  '  [ -s "$tmp" ] || { rm -f "$tmp"; echo "gog: empty download" >&2; exit 1; }' \
  '  chmod +x "$tmp" && mv -f "$tmp" "$GOG_BIN" || { rm -f "$tmp"; exit 1; }' \
  'fi' \
  'exec "$GOG_BIN" "$@"' \
  > /usr/local/bin/gog && chmod +x /usr/local/bin/gog

# A browser for agents, on by default (WITH_BROWSER=0 opts out). The image carries the Playwright MCP server and
# Chromium's OS libraries (root-only to install); the browser itself is
# downloaded the first time a run asks for it, into the data volume, by the
# wrapper below — so an image nobody browses from never pays for Chromium, and
# a box downloads it once. It fetches full Chromium, not just the headless
# shell: with `--browser chromium` Playwright runs the full binary in its new
# headless mode, and only a channel-less launch would use the shell. The Playwright inside the MCP package does the
# download, so the build matches. Configure the shared server as
# `playwright-mcp --browser chromium --headless --no-sandbox --isolated --output-dir .bullpen/out/playwright`: the
# server defaults to the `chrome` channel (Google Chrome, not present), and
# Chromium's own sandbox can't start under Docker's default seccomp profile.
ARG WITH_BROWSER="1"
ENV PLAYWRIGHT_BROWSERS_PATH=/data/browsers
RUN if [ -n "$WITH_BROWSER" ] && [ "$WITH_BROWSER" != "0" ]; then \
      npm install -g @playwright/mcp@0.0.81 \
      && MCP="$(npm root -g)/@playwright/mcp" \
      && node "$MCP/node_modules/playwright/cli.js" install-deps chromium \
      && rm -f /usr/local/bin/playwright-mcp \
      && printf '#!/bin/sh\n# Fetches the headless Chromium into PLAYWRIGHT_BROWSERS_PATH on first use; the image ships only its libraries.\nif [ -z "$(ls -d "$PLAYWRIGHT_BROWSERS_PATH"/chromium-* 2>/dev/null)" ]; then\n  node %s/node_modules/playwright/cli.js install chromium >&2\nfi\nexec node %s/cli.js "$@"\n' "$MCP" "$MCP" > /usr/local/bin/playwright-mcp \
      && chmod +x /usr/local/bin/playwright-mcp \
      && rm -rf /var/lib/apt/lists/* /root/.npm ; \
    fi

# No global @anthropic-ai/claude-code: the Agent SDK spawns the harness binary
# it bundles itself, so a global install is a second 200MB copy nothing runs.

WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/web/dist packages/web/dist
COPY package.json ./
COPY packages/server packages/server

RUN mkdir -p /data/claude /data/gog && chown -R node:node /data /app
# The harness the SDK bundles, on PATH for `kamal app exec 'claude login'` and
# the dashboard's MCP authorize — a symlink, not a second install.
RUN ln -s "$(ls -d /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude | head -1)" /usr/local/bin/claude
USER node
# Kamal deploys this image without building it, and checks for the label it would have added.
LABEL service=bullpen
VOLUME /data
EXPOSE 4322

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:4322/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "packages/server/src/index.ts"]
