# syntax=docker/dockerfile:1
#
# The EMS web image: the React app, built, served by Caddy with the security
# headers, and /api passed on to the API container (deploy/web/Caddyfile).
#
# Built from the repository root (deploy/build.sh):
#   docker build -f deploy/web.Dockerfile -t ems-web:v1.0 .
# Only what deploy/web.Dockerfile.dockerignore lets through reaches the build.

# ── Build the app ────────────────────────────────────────────────────────────
FROM node:22-trixie-slim AS build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ── Serve it ─────────────────────────────────────────────────────────────────
FROM caddy:2.11-alpine
# The official binary carries a file capability for ports below 1024. This
# server listens on 8080, and the container runs with every capability dropped
# (deploy/compose.yml) — where a binary that asks for one is refused outright.
RUN apk add --no-cache libcap \
 && setcap -r /usr/bin/caddy \
 && apk del libcap
COPY deploy/web/Caddyfile deploy/web/security-headers.caddy /etc/caddy/
COPY --from=build /web/dist /srv
# A Caddyfile that does not parse fails the build, not the deploy.
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

ARG EMS_VERSION=dev
LABEL org.opencontainers.image.title="ems-web" \
      org.opencontainers.image.version="${EMS_VERSION}"

# Never root: port 8080 needs no privilege.
USER nobody
EXPOSE 8080
