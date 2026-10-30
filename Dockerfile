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
ENV NODE_ENV=production PORT=8790 KUMI_CLUB_FILE=/etc/kumi/club.yaml
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
