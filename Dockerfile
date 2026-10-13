FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git python3 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY architecture/BOT_GUIDE.md ./architecture/BOT_GUIDE.md
# Tests run in the CI test job before deploy, not in the image build.
RUN npm run build
RUN npm prune --omit=dev
# The runtime is Alpine; retain its DAVE encryption binary alongside the build's glibc binary.
RUN node -e 'const {version}=require("@snazzah/davey/package.json"); const r=require("node:child_process").spawnSync("npm",["install","--no-save","--omit=dev","--package-lock=false","--force",`@snazzah/davey-linux-${process.arch}-musl@${version}`],{stdio:"inherit"}); process.exit(r.status ?? 1)'
COPY site ./site
RUN cd site && npm ci && npm run build

FROM tailscale/tailscale:stable AS tailscale
FROM docker.io/searxng/searxng:2026.10.11-ad46ebd7d@sha256:ddd642cae6eac75412938fd846ddbf440a2df029cfeae8a562b8b205f4e35e25 AS runtime
USER root
RUN mkdir -p /app /data && chown -R 1000:1000 /app /data /etc/searxng /var/cache/searxng
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
RUN node --version
WORKDIR /app
ENV NODE_ENV=production DATABASE_PATH=/data/slopbot.sqlite3 SEARXNG_URL=http://127.0.0.1:8080
COPY --from=build --chown=1000:1000 /app/package.json ./
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/dist/src ./dist/src
COPY --from=build --chown=1000:1000 /app/dist/architecture ./dist/architecture
COPY --from=build --chown=1000:1000 /app/web ./web
COPY --from=build --chown=1000:1000 /app/site/out ./site/out
COPY --chown=1000:1000 scripts/deployment ./scripts/deployment
COPY --chown=1000:1000 scripts/container-health.mjs ./scripts/container-health.mjs
COPY --chown=1000:1000 services/search/settings.yml /etc/searxng/settings.yml
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 CMD ["node", "scripts/container-health.mjs"]
ENTRYPOINT ["node", "scripts/deployment/supervisor.mjs"]

FROM runtime AS migration
COPY --chown=1000:1000 .deployment-build/seed.enc /app/seed.enc

FROM runtime AS production
ARG SLOPBOT_BUILD_SHA
ARG SLOPBOT_BUILD_TIME
ENV SLOPBOT_BUILD_SHA=$SLOPBOT_BUILD_SHA SLOPBOT_BUILD_TIME=$SLOPBOT_BUILD_TIME
