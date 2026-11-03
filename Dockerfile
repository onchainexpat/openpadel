# Kumi in containers. Two images from one build: `server` (the API, the jobs and the kumi command) and
# `web` (Caddy with both built apps, HTTPS and the security headers). compose.yaml runs them; see
# deploy/docker/README.md. Images are pinned to exact releases at least two weeks old (house rule 9).
FROM node:24.22.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/member/package.json apps/member/
COPY apps/manager/package.json apps/manager/
COPY packages/core/package.json packages/core/
COPY packages/i18n/package.json packages/i18n/
COPY packages/ui/package.json packages/ui/
RUN npm ci --no-audit --no-fund --loglevel=error
COPY . .
RUN npm run build -w @kumi/member -w @kumi/manager --silent

# Only what runs: no build tools. Node runs the TypeScript directly.
FROM build AS runtime-deps
RUN npm prune --omit=dev --no-audit --no-fund --loglevel=error && rm -rf apps/member apps/manager

FROM node:24.22.0-bookworm-slim AS server
# pg_dump and pg_restore, for backups and the restore test: Postgres 17's own, from the PostgreSQL project's
# repository (Debian's are older, and an older pg_dump refuses a newer server).
RUN apt-get update -q && apt-get install -yq --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update -q && apt-get install -yq --no-install-recommends postgresql-client-17 \
 && apt-get purge -yq curl && apt-get autoremove -yq && rm -rf /var/lib/apt/lists/*
# Every address in the container: Caddy is another container (the port isn't published outside the compose network).
ENV NODE_ENV=production PORT=8790 KUMI_LISTEN_ADDRESS=0.0.0.0 KUMI_CLUB_FILE=/etc/kumi/club.yaml KUMI_PG_BIN=/usr/lib/postgresql/17/bin KUMI_INSTALL=docker
WORKDIR /app
COPY --from=runtime-deps --chown=node:node /app /app
RUN printf '#!/bin/sh\nexec node /app/apps/server/src/cli.ts "$@"\n' > /usr/local/bin/kumi && chmod 755 /usr/local/bin/kumi
USER node
EXPOSE 8790
CMD ["node", "apps/server/src/main.ts"]

FROM caddy:2.11.7-alpine AS web
COPY --from=build /app/apps/member/dist /srv/apps/member/dist
COPY --from=build /app/apps/manager/dist /srv/apps/manager/dist
COPY deploy/docker/Caddyfile /etc/caddy/Caddyfile
