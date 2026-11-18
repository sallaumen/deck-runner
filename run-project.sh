#!/bin/sh
set -eu
export MIX_ENV=test AGENT_BOARD_ENV_FILE=/nonexistent-deck-runner-env
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$PWD"
case "$DECK_PROFILE" in
  mix)
    for cluster in /etc/postgresql/*/main; do
      [ -d "$cluster" ] || { echo "Missing PostgreSQL cluster" >&2; exit 1; }
      version=$(basename "$(dirname "$cluster")"); break
    done
    pg_conftool "$version" main set port "$DECK_DB_PORT"
    pg_ctlcluster "$version" main start
    if [ "$DECK_DB_USER" = postgres ]; then
      role_sql="ALTER ROLE postgres PASSWORD 'postgres';"
    else
      role_sql="CREATE ROLE $DECK_DB_USER WITH LOGIN CREATEDB PASSWORD '$DECK_DB_USER';"
    fi
    (cd /tmp && runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "$role_sql")
    runuser -u runner -- mix deps.get
    exec runuser -u runner -- "$@"
    ;;
  python) exec runuser -u runner -- "$@" ;;
  node)
    if [ -f package-lock.json ]; then npm ci --no-audit --no-fund;
    elif [ -f package.json ]; then npm install --no-audit --no-fund; fi
    exec "$@"
    ;;
esac
exit 2
