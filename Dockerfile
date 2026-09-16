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
ENV NODE_ENV=production BULLPEN_DATA=/data \
    CLAUDE_CONFIG_DIR=/data/claude GOG_HOME=/data/gog

# git for workspace clones; ripgrep because Claude Code's search tools use it;
# ca-certificates for HTTPS to the API and remote MCP servers; gh because the
# agents drive GitHub through it and it is not something the SDK brings along.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl gnupg \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get purge -y gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# gog (Gmail CLI) has no apt package. Pass a release asset URL at build time —
# a bare linux binary or a .tar.gz containing one — or leave it unset and the
# image simply has no gog, which only the email-archiving agent notices.
ARG GOG_URL=""
RUN if [ -n "$GOG_URL" ]; then \
      case "$GOG_URL" in \
        *.tar.gz|*.tgz) curl -fsSL "$GOG_URL" | tar -xz -C /usr/local/bin --wildcards --no-anchored 'gog' ;; \
        *) curl -fsSL "$GOG_URL" -o /usr/local/bin/gog ;; \
      esac \
      && chmod +x /usr/local/bin/gog && gog --version ; \
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
