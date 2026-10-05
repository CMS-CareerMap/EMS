#!/bin/sh
# Runs once, by the postgres image itself, the first time the database volume
# is created (it is mounted into /docker-entrypoint-initdb.d by
# deploy/compose.yml). Never again — a changed password later is changed with
# ALTER ROLE, by hand.
#
# The app gets its own login, `ems`, which owns the `ems` database and may
# create databases (the monthly restore drill restores into a scratch one, and
# every restore goes into a new, empty database). It is not a superuser: the
# superuser's password stays with the database container alone.
set -eu

if [ -z "${EMS_DB_PASSWORD:-}" ]; then
	echo "EMS_DB_PASSWORD is not set" >&2
	exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v pw="$EMS_DB_PASSWORD" <<'SQL'
CREATE ROLE ems LOGIN CREATEDB PASSWORD :'pw';
CREATE DATABASE ems OWNER ems;
SQL
