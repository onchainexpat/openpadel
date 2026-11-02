#!/bin/sh
# Runs once, when Docker first makes the database (docker-entrypoint-initdb.d). The image makes POSTGRES_USER
# (kumi) a superuser; the server connects as kumi_app instead, which owns the club's database and nothing else,
# so a flaw that let someone run SQL couldn't run commands in this container. deploy/docker/update.sh moves a
# database made before this over once.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v pw="$KUMI_DB_PASSWORD" <<'SQL'
CREATE ROLE kumi_app LOGIN NOSUPERUSER NOCREATEROLE CREATEDB PASSWORD :'pw';
ALTER DATABASE kumi OWNER TO kumi_app;
SQL
