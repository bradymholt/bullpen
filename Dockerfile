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
ENV NODE_ENV=production BULLPEN_DATA=/data

# git for workspace clones; ripgrep because Claude Code's search tools use it;
# ca-certificates for HTTPS to the API and remote MCP servers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# No global @anthropic-ai/claude-code: the Agent SDK spawns the harness binary
# it bundles itself, so a global install is a second 200MB copy nothing runs.

WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/web/dist packages/web/dist
COPY package.json ./
COPY packages/server packages/server

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "packages/server/src/index.ts"]
