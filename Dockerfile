FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git python3 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/contracts/package.json ./packages/contracts/
COPY site/package.json ./site/
COPY console/package.json ./console/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src
COPY src ./src
COPY share ./share
COPY architecture/BOT_GUIDE.md ./architecture/BOT_GUIDE.md
# Tests run in the CI test job before deploy, not in the image build.
RUN pnpm run build
COPY site ./site
RUN pnpm -F slopbot-page build
COPY console ./console
RUN pnpm -F slopbot-console build
RUN CI=true pnpm prune --prod
# The runtime is Alpine; retain its DAVE encryption binary alongside the build's glibc binary.
# Unpack the musl package by hand: a `pnpm`/`npm install` here would re-resolve the tree without the lockfile and pull newer undici.
# davey is a dependency of @discordjs/voice, so pnpm does not hoist it to the root: resolve it from there.
RUN V=$(node -p 'require("module").createRequire(require.resolve("@discordjs/voice"))("@snazzah/davey/package.json").version') && P="@snazzah/davey-linux-$(node -p process.arch)-musl" \
  && mkdir -p "node_modules/$P" && npm pack "$P@$V" --silent | xargs -I{} tar -xzf {} -C "node_modules/$P" --strip-components=1 && rm -f snazzah-davey-*.tgz

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
# node_modules/@slopbot/contracts is a symlink to packages/contracts, so the package must be at the same place.
COPY --from=build --chown=1000:1000 /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=1000:1000 /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=1000:1000 /app/dist/src ./dist/src
COPY --from=build --chown=1000:1000 /app/dist/architecture ./dist/architecture
COPY --from=build --chown=1000:1000 /app/share ./share
COPY --from=build --chown=1000:1000 /app/site/out ./site/out
COPY --from=build --chown=1000:1000 /app/console/dist ./console/dist
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
