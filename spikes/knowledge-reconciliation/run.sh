#!/usr/bin/env bash
#
# Bring the pieces up, run one thing, and leave the reviewed demo alone.
#
#   ./run.sh build                 build the image
#   ./run.sh check                 typecheck only, no database, no network
#   ./run.sh test                  node --test against a real, disposable Neo4j
#   ./run.sh cli <args...>         the operator CLI against the retained demo
#   ./run.sh extract <args...>     ONE live request, against the ledger's cap
#   ./run.sh demo-down             stop the demo services, keep its data
#   ./run.sh demo-destroy          remove the demo data as well
#
# `test` and `cli` use different Compose projects, so the test teardown cannot
# delete demo evidence that an operator has already reviewed. Nothing here
# prunes images, touches another spike, or removes a volume it did not create.

set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ROOT="$(cd ../.. && pwd)"
ARTIFACT_ROOT="${ROOT}/tmp/spikes/knowledge-reconciliation"

HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
export HOST_UID HOST_GID

TARGET="${1:-test}"
shift || true

case "${TARGET}" in
  build)
    export COMPOSE_PROJECT_NAME="okr-build"
    export ARTIFACTS_DIR="${ARTIFACT_ROOT}/scratch"
    mkdir -p "${ARTIFACTS_DIR}"
    docker compose build app
    ;;

  check)
    export COMPOSE_PROJECT_NAME="okr-check"
    export ARTIFACTS_DIR="${ARTIFACT_ROOT}/scratch"
    mkdir -p "${ARTIFACTS_DIR}"
    trap 'docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose build app
    docker compose run --rm --no-deps --entrypoint npx app tsc --noEmit
    ;;

  test)
    export COMPOSE_PROJECT_NAME="okr-test"
    export ARTIFACTS_DIR="${ARTIFACT_ROOT}/test"
    mkdir -p "${ARTIFACTS_DIR}"
    # Disposable by construction: this project's volume is created here and
    # removed on the way out, whatever the test result was.
    trap 'docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true' EXIT
    docker compose run --rm --build app --test src/spike.test.ts src/extract.test.ts
    ;;

  cli)
    export COMPOSE_PROJECT_NAME="okr-demo"
    export ARTIFACTS_DIR="${ARTIFACT_ROOT}/demo"
    mkdir -p "${ARTIFACTS_DIR}"
    # No --build here: build output would land on stdout alongside the JSON
    # result. Run `./run.sh build` after changing the source.
    docker compose run --rm app src/cli.ts "$@"
    ;;

  extract)
    export COMPOSE_PROJECT_NAME="okr-demo"
    export ARTIFACTS_DIR="${ARTIFACT_ROOT}/demo"
    export CREDENTIAL_FILE="${CREDENTIAL_FILE:-${HOME}/.local/share/opencode/auth.json}"
    mkdir -p "${ARTIFACTS_DIR}/extraction/ledger"
    docker compose run --rm --no-deps extractor "$@"
    ;;

  demo-down)
    export COMPOSE_PROJECT_NAME="okr-demo"
    export ARTIFACTS_DIR="${ARTIFACT_ROOT}/demo"
    docker compose down --remove-orphans
    ;;

  demo-destroy)
    export COMPOSE_PROJECT_NAME="okr-demo"
    export ARTIFACTS_DIR="${ARTIFACT_ROOT}/demo"
    docker compose down --volumes --remove-orphans
    ;;

  *)
    echo "usage: ./run.sh [check|test|cli|extract|demo-down|demo-destroy]" >&2
    exit 2
    ;;
esac
