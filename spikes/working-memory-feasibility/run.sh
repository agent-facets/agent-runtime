#!/usr/bin/env bash
#
# Bring up the database, run something, tear it down.
#
#   ./run.sh test     node --test over the real store
#   ./run.sh demo     the scripted four-turn run
#   ./run.sh check    typecheck only, no database
#
# No provider traffic and no credentials in any of these.

set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

TARGET="${1:-test}"
export COMPOSE_PROJECT_NAME="wmf-$(date -u +%H%M%S)"

cleanup() { docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

case "${TARGET}" in
  check) docker compose build app >/dev/null && docker compose run --rm --no-deps app -e 'process.exit(0)' \
           && docker compose run --rm --no-deps --entrypoint npx app tsc --noEmit ;;
  test)  docker compose run --rm app --test src/spike.test.ts ;;
  demo)  docker compose run --rm app src/demo.ts ;;
  *)     echo "usage: ./run.sh [test|demo|check]" >&2; exit 2 ;;
esac
