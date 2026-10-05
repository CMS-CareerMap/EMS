#!/usr/bin/env bash
# Builds the two EMS images from this checkout, for the client's box (linux/amd64):
#
#   deploy/build.sh v1.2            ems-api:v1.2 and ems-web:v1.2
#   deploy/build.sh v1.2-rc1        a trial build: allowed with uncommitted changes
#
# A release version (v1.2, v1.2.3) is built only from a clean checkout, so the
# version always names exactly one commit. Docker must be running.
set -euo pipefail
cd "$(dirname "$0")/.."

version=${1:-}
[[ $version =~ ^v[0-9]+(\.[0-9]+){1,2}(-[0-9A-Za-z.]+)?$ ]] ||
  { echo "Usage: deploy/build.sh <version>, such as v1.2 or v1.2-rc1" >&2; exit 2; }

if [[ $version != *-* ]] && [ -n "$(git status --porcelain)" ]; then
  echo "There are uncommitted changes. Commit them, or build a trial version (${version}-rc1)." >&2
  exit 1
fi
commit=$(git rev-parse --short HEAD)
# A trial build from uncommitted changes says so, rather than naming a commit it is not.
[ -z "$(git status --porcelain)" ] || commit="$commit-dirty"

for image in api web; do
  echo "== ems-$image:$version  (commit $commit)"
  docker build --platform linux/amd64 \
    -f "deploy/$image.Dockerfile" \
    --build-arg EMS_VERSION="$version" \
    --label org.opencontainers.image.revision="$commit" \
    -t "ems-$image:$version" .
done

echo
docker image ls --format '{{.Repository}}:{{.Tag}}  {{.Size}}' | grep -E "^ems-(api|web):$version "
