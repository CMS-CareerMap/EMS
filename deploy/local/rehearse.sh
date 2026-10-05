#!/usr/bin/env bash
# A rehearsal of the box on this laptop: the same compose.yml, the same
# deploy.sh, the same images, behind a stand-in for the box's shared Caddy.
#
#   deploy/build.sh v1.2-rc1                 build the images first
#   deploy/local/rehearse.sh v1.2-rc1        deploy them → https://localhost:8443
#   deploy/local/rehearse.sh --down          stop everything (the data stays)
#   deploy/local/rehearse.sh --wipe          stop everything and DELETE the rehearsal's data
#
# The "box" is deploy/local/.box (never committed): compose.yml, deploy.sh and
# postgres/ copied from deploy/, plus this folder's compose.override.yml (files
# on a volume, not R2) and an .env of fresh random secrets made on first use.
# Nothing here touches the development database, Neon, or ports 4000/5173.
#
# The certificate is Caddy's own: the browser warns once ("not private") —
# continue to localhost. Then create the first Super Admin:
#   cd deploy/local/.box && docker compose run --rm \
#     -e BOOTSTRAP_ADMIN_EMAIL=superadmin@example.com -e BOOTSTRAP_ADMIN_PASSWORD='…' api npm run bootstrap
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
deploy_dir=$(cd "$here/.." && pwd)
box="$here/.box"

edge() { docker compose -f "$here/edge/compose.yml" "$@"; }

case "${1:-}" in
  --down)
    [ -f "$box/compose.yml" ] && (cd "$box" && docker compose down)
    edge down
    exit 0
    ;;
  --wipe)
    [ -f "$box/compose.yml" ] && (cd "$box" && docker compose down --volumes)
    edge down --volumes
    rm -rf "$box"
    exit 0
    ;;
  v*) version=$1 ;;
  *) echo "Usage: deploy/local/rehearse.sh <version> | --down | --wipe" >&2; exit 2 ;;
esac

mkdir -p "$box/postgres"
cp "$deploy_dir/compose.yml" "$deploy_dir/deploy.sh" "$box/"
cp "$deploy_dir/postgres/10-ems-role.sh" "$box/postgres/"
cp "$here/compose.override.yml" "$box/"

if [ ! -f "$box/.env" ]; then
  echo "== A new .env with fresh random secrets ($box/.env)"
  {
    echo "EMS_DOMAIN=localhost:8443"
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "EMS_DB_PASSWORD=$(openssl rand -hex 24)"
    echo "JWT_ACCESS_SECRET=$(openssl rand -hex 48)"
    echo "JWT_REFRESH_SECRET=$(openssl rand -hex 48)"
    echo "BACKUP_PASSPHRASE=$(openssl rand -base64 24)"
  } > "$box/.env"
fi

# The shared network the box's edge stack creates; here, this script does.
docker network inspect edge >/dev/null 2>&1 || docker network create edge >/dev/null
edge up -d --wait

"$box/deploy.sh" "$version"
echo
echo "Open https://localhost:8443"
