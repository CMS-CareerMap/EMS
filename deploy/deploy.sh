#!/usr/bin/env bash
# Switches EMS on this box to a version whose images are already here.
#
#   ./deploy.sh v1.2         back up, migrate, then run ems-api:v1.2 and ems-web:v1.2
#   ./deploy.sh --rollback   go back to the version that ran before the last switch
#   ./deploy.sh --status     which version runs, and the state of each container
#
# Lives in /srv/ems beside compose.yml, .env and postgres/ (DEPLOY.md). The
# images arrive by `docker load` (DEPLOY.md, "On the box"); this script never
# builds them and never pulls them.
#
# The containers always run the `current` tags. Three more tags keep the way
# back: `good` is the last version that came up healthy, and a switch makes it
# `previous` — so a version that failed never becomes the one to return to.
# A rollback puts the CODE back, never the database: if the new version changed
# the database, the old code may need the backup this script took just before
# the switch (DEPLOY.md, "Rolling back").
#
# Stopped half-way (a dropped SSH session, say), run the same command again.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n== %s\n' "$*"; }
fail() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }
has_image() { docker image inspect "$1" >/dev/null 2>&1; }
image_id() { docker image inspect "$1" --format '{{.Id}}'; }
version_of() {
  # Asked only of an image that exists: for one that does not, inspect still
  # prints an empty line before failing.
  if has_image "$1"; then
    docker image inspect "$1" --format '{{ index .Config.Labels "org.opencontainers.image.version" }}'
  else
    echo "none"
  fi
}

# One run at a time: two would move the same tags under each other.
lock_dir=.deploy.lock
take_lock() {
  mkdir "$lock_dir" 2>/dev/null ||
    fail "another deploy is running (or one was killed: if none is, remove $PWD/$lock_dir)"
  trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT
}

status() {
  echo "Running: $(version_of ems-api:current) (api), $(version_of ems-web:current) (web)." \
       "Previous: $(version_of ems-api:previous). Last healthy: $(version_of ems-api:good)."
  docker compose ps
}

# Does the database hold the app's tables? Prints t or f. A failed question is
# never taken for "empty": that would skip the backup of a live database.
db_in_use() {
  local answer
  answer=$(docker compose exec -T db psql -v ON_ERROR_STOP=1 -U ems -d ems -Atc \
    "SELECT to_regclass('public._prisma_migrations') IS NOT NULL") ||
    fail "could not ask the database whether it holds data (above) — nothing was changed"
  case "$answer" in
    t | f) echo "$answer" ;;
    *) fail "the database gave an unexpected answer (\"$answer\") — nothing was changed" ;;
  esac
}

# Points two tags at two images (by tag or id): api first, then web.
tag_pair() {
  docker tag "$1" "ems-api:$3"
  docker tag "$2" "ems-web:$3"
}

# Keeps the images of the three highest versions (a release above its -rc
# builds), and the version tags of whatever current, previous and good point
# at — so the way back can always be deployed again by its version too.
prune_old_versions() {
  local repo tag id in_use
  for repo in ems-api ems-web; do
    in_use=" "
    for tag in current previous good; do
      has_image "$repo:$tag" && in_use+="$(image_id "$repo:$tag") "
    done
    { docker image ls "$repo" --format '{{.Tag}}' | grep -E '^v[0-9]' |
        sed 's/-/~/' | sort -V | sed 's/~/-/' | head -n -3 || true; } |
      while read -r tag; do
        id=$(image_id "$repo:$tag")
        [[ $in_use == *" $id "* ]] || docker rmi "$repo:$tag" >/dev/null 2>&1 || true
      done
  done
  # Only EMS's own untagged images — the box is shared.
  docker image prune -f --filter label=org.opencontainers.image.title=ems-api >/dev/null 2>&1 || true
  docker image prune -f --filter label=org.opencontainers.image.title=ems-web >/dev/null 2>&1 || true
}

deploy() {
  local version=$1
  [[ $version =~ ^v[0-9]+(\.[0-9]+){1,2}(-[0-9A-Za-z.]+)?$ ]] ||
    fail "\"$version\" is not a version such as v1.2 or v1.2.3"
  has_image "ems-api:$version" && has_image "ems-web:$version" ||
    fail "ems-api:$version and ems-web:$version are not on this box — load them first"
  [ -f .env ] || fail ".env is missing (copy env.example, then fill it in)"
  docker compose config --quiet || fail "compose.yml or .env is not valid (see above)"
  take_lock

  say "Database"
  docker compose up -d --wait db
  # Asked before anything stops, so a failed question leaves the site running.
  # On a line of its own, so that failure stops the script (set -e) — inside
  # [ ] it would only make the test false.
  local in_use
  in_use=$(db_in_use)

  # Nothing may write between the backup and the switch, nor while the
  # database's shape changes: the site still opens, but its data waits.
  say "Stopping the API and the jobs"
  docker compose stop api jobs

  if [ "$in_use" = t ]; then
    say "Backup first, by the version running now"
    if ! docker compose run --rm --no-deps api npm run --silent backup; then
      docker compose up -d --wait --wait-timeout 180 || true
      fail "the backup failed, so nothing was changed (the running version was started again)"
    fi
  else
    say "The database is empty: nothing to back up"
  fi

  # What runs now, what ran before it, and the last healthy one: to put all
  # three back if a migration fails.
  local old_api="" old_web="" prev_api="" prev_web=""
  if has_image ems-api:current && has_image ems-web:current; then
    old_api=$(image_id ems-api:current)
    old_web=$(image_id ems-web:current)
  fi
  if has_image ems-api:previous && has_image ems-web:previous; then
    prev_api=$(image_id ems-api:previous)
    prev_web=$(image_id ems-web:previous)
  fi
  # The way back is the last healthy version (or, before any, what runs now),
  # unless that is the very version being deployed again.
  if has_image ems-api:good && has_image ems-web:good; then
    if [ "$(image_id ems-api:good)" != "$(image_id "ems-api:$version")" ] ||
       [ "$(image_id ems-web:good)" != "$(image_id "ems-web:$version")" ]; then
      tag_pair ems-api:good ems-web:good previous
    fi
  elif [ -n "$old_api" ]; then
    if [ "$old_api" != "$(image_id "ems-api:$version")" ] || [ "$old_web" != "$(image_id "ems-web:$version")" ]; then
      tag_pair "$old_api" "$old_web" previous
    fi
  fi
  tag_pair "ems-api:$version" "ems-web:$version" current

  say "Migrations"
  if ! docker compose run --rm --no-deps api npx --no-install prisma migrate deploy; then
    if [ -n "$old_api" ]; then
      tag_pair "$old_api" "$old_web" current
      if [ -n "$prev_api" ]; then
        tag_pair "$prev_api" "$prev_web" previous
      else
        # There was none: take back the one this run made (only the tag goes).
        docker rmi ems-api:previous ems-web:previous >/dev/null 2>&1 || true
      fi
      if docker compose up -d --wait --wait-timeout 180 --remove-orphans; then
        fail "a migration failed; the version from before runs again. A failed migration file is normally undone whole — read the error above, and see DEPLOY.md, \"A migration failed\"."
      fi
      fail "a migration failed, and the version from before did not come up healthy either: docker compose logs api"
    fi
    fail "a migration failed on the first deploy — read the error above."
  fi

  # --remove-orphans: a service a new version no longer has (only ever this
  # project's own, `ems`) is stopped rather than left running.
  say "Starting $version"
  if ! docker compose up -d --wait --wait-timeout 180 --remove-orphans; then
    docker compose logs --tail 40 api ems-web
    fail "$version did not come up healthy (logs above). To go back: ./deploy.sh --rollback"
  fi

  tag_pair ems-api:current ems-web:current good
  prune_old_versions
  say "Done"
  status
}

rollback() {
  has_image ems-api:previous && has_image ems-web:previous ||
    fail "there is no previous version on this box"
  take_lock
  local from_api from_web
  from_api=$(image_id ems-api:current)
  from_web=$(image_id ems-web:current)
  say "Back from $(version_of ems-api:current) to $(version_of ems-api:previous)"
  tag_pair ems-api:previous ems-web:previous current
  # Swapped, so a second --rollback returns to where this one started.
  tag_pair "$from_api" "$from_web" previous
  docker compose up -d --wait --wait-timeout 180 --remove-orphans ||
    fail "the version gone back to did not come up healthy either: docker compose logs api"
  tag_pair ems-api:current ems-web:current good
  say "Done. The database was not changed by the rollback."
  status
}

case "${1:-}" in
  --status) status ;;
  --rollback) rollback ;;
  v*) deploy "$1" ;;
  *) echo "Usage: ./deploy.sh <version> | --rollback | --status" >&2; exit 2 ;;
esac
