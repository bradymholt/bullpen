# ---- build the SPA -----------------------------------------------------
FROM node:22-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY packages/web packages/web
RUN npm run build -w @bullpen/web

# ---- runtime -----------------------------------------------------------
FROM node:22-slim
ENV NODE_ENV=production BULLPEN_DATA=/data

# git for workspace clones; ripgrep because Claude Code's search tools use it;
# ca-certificates for HTTPS to the API and remote MCP servers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The harness itself. The Agent SDK spawns this binary.
RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev -w @bullpen/server --include-workspace-root

COPY packages/server packages/server
COPY --from=web /app/packages/web/dist packages/web/dist

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "packages/server/src/index.ts"]
