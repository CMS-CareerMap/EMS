# syntax=docker/dockerfile:1
#
# The EMS API image. One image runs three things (deploy/compose.yml):
#   api    the server itself:                node dist/src/main.js
#   jobs   the nightly and monthly jobs:     supercronic /app/crontab
#   (run)  one-off commands on the server:   docker compose run --rm api npm run backup -- --list
#
# Built from the repository root (deploy/build.sh):
#   docker build -f deploy/api.Dockerfile -t ems-api:v1.0 .
# Only what deploy/api.Dockerfile.dockerignore lets through reaches the build —
# never a .env, never node_modules or dist from this machine.

# ── The scheduler for the jobs container ─────────────────────────────────────
# supercronic: cron made for containers. It passes the container's environment
# on to each job and writes every job's output to stdout, where `docker compose
# logs jobs` shows it. Fetched by version and checked against the SHA-1 that
# its release page publishes, so a changed download fails the build.
FROM node:22-trixie-slim AS cron
ARG SUPERCRONIC_VERSION=v0.2.49
ARG SUPERCRONIC_SHA1SUM=e63c11a9726b775a6a11801e81af4f3fb926aa68
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL -o /supercronic "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
 && echo "${SUPERCRONIC_SHA1SUM}  /supercronic" | sha1sum -c - \
 && chmod 0755 /supercronic

# ── The image ────────────────────────────────────────────────────────────────
FROM node:22-trixie-slim
#   openssl               Prisma's query engine links against it
#   postgresql-client-17  pg_dump, pg_restore and psql for the backups — the same
#                         major version as the database container (postgres:17),
#                         because pg_dump refuses a server newer than itself
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=cron /supercronic /usr/local/bin/supercronic

WORKDIR /app
# The last three keep the logs to the app's own lines: no Prisma usage report,
# no "a newer npm exists", no note from dotenv that there is no .env file (the
# settings come from the container's environment).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    CHECKPOINT_DISABLE=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    DOTENV_CONFIG_QUIET=true

# Every dependency, the dev ones too: the jobs and the one-off commands run the
# TypeScript scripts with tsx, and `prisma migrate deploy` needs the Prisma CLI.
# (--include=dev because NODE_ENV=production above would otherwise leave them out.)
# The schema comes first because installing runs `prisma generate`.
COPY server/package.json server/package-lock.json ./
COPY server/prisma ./prisma
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force

COPY server/tsconfig.json ./
COPY server/assets ./assets
COPY server/scripts ./scripts
COPY server/src ./src
RUN npm run build

COPY deploy/crontab /app/crontab

# Files kept on this container's disk: only by the local storage driver, which
# the rehearsal on a laptop uses (deploy/local). Production keeps files in R2.
RUN mkdir -p /app/uploads && chown node:node /app/uploads

ARG EMS_VERSION=dev
LABEL org.opencontainers.image.title="ems-api" \
      org.opencontainers.image.version="${EMS_VERSION}"

# Never root. The code is root's and read-only to this user.
USER node
EXPOSE 4000
CMD ["node", "dist/src/main.js"]
