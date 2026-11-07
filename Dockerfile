# Kumi in containers. Four images from one build: `server` (the API, the jobs and the kumi command), `web`
# (Caddy with both built apps, HTTPS and the security headers), `db` (Postgres with pgBackRest) and `pitr` (the
# point-in-time jobs beside it). compose.yaml runs them; see deploy/docker/README.md. Images and packages are pinned
# to exact releases at least two weeks old (house rule 9).
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
RUN printf '#!/bin/sh\nexec node /app/apps/server/src/cli.ts "$@"\n' > /usr/local/bin/kumi && chmod 755 /usr/local/bin/kumi && ln -sf /usr/local/bin/kumi /usr/local/bin/openpadel
USER node
EXPOSE 8790
CMD ["node", "apps/server/src/main.ts"]

FROM caddy:2.11.7-alpine AS web
COPY --from=build /app/apps/member/dist /srv/apps/member/dist
COPY --from=build /app/apps/manager/dist /srv/apps/manager/dist
COPY deploy/docker/Caddyfile /etc/caddy/Caddyfile

# Postgres for point-in-time backups (apps/server/src/pitr.ts): the same Postgres image as before (Alpine's, so the
# database's files, its owner and its text ordering stay exactly as they were), with pgBackRest to archive its log.
# Alpine's pgBackRest asks for Alpine's own Postgres package (18): a stand-in of that name answers, since the image
# has Postgres 17 of its own and pgBackRest only needs its client library.
FROM postgres:17.9-alpine AS db
RUN apk add --no-cache --virtual postgresql libpq && apk add --no-cache pgbackrest=2.57.0-r0 \
 && install -d -m 750 -o postgres -g postgres /var/lib/pgbackrest /var/spool/pgbackrest /var/log/pgbackrest /etc/pgbackrest
COPY deploy/docker/pgbackrest-archive-push /usr/local/bin/kumi-pgbackrest-archive-push

# The pitr service: the base backups, the monthly test and going back to a minute, as the db image's postgres user
# (the same Postgres and pgBackRest as the db service, so the archive and the scratch copies are made by the same
# programs), with Node to run the kumi command. It reads the database's folder (mounted read-only) for base backups;
# scratch copies, and the copy a restore takes, go in a volume of its own.
FROM db AS pitr
RUN apk add --no-cache libstdc++ libgcc \
 && install -d -m 700 -o postgres -g postgres /var/lib/kumi-pitr /var/lib/kumi-pitr/scratch
COPY --from=node:24.22.0-alpine3.23 /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime-deps /app /app
RUN printf '#!/bin/sh\nexec node /app/apps/server/src/cli.ts "$@"\n' > /usr/local/bin/kumi && chmod 755 /usr/local/bin/kumi && ln -sf /usr/local/bin/kumi /usr/local/bin/openpadel
COPY deploy/docker/pitr.sh /usr/local/bin/kumi-pitr-service
# KUMI_PITR_INLINE: `kumi restore --to` takes the copy from the archive itself, as this user (pitr_cli.ts).
ENV NODE_ENV=production KUMI_INSTALL=docker KUMI_PITR_INLINE=1 KUMI_PG_BIN=/usr/local/bin \
    KUMI_PITR_PG_PATH=/var/lib/postgresql/data KUMI_PITR_SCRATCH=/var/lib/kumi-pitr/scratch KUMI_BACKUP_DIR=/var/lib/kumi-pitr
WORKDIR /app
USER postgres
ENTRYPOINT ["/usr/local/bin/kumi-pitr-service"]
CMD []
