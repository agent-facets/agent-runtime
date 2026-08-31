#!/usr/bin/env bash
#
# Live Anthropic subscription gate.
#
# THIS SENDS REAL PROVIDER TRAFFIC AND CONSUMES SUBSCRIPTION QUOTA.
# Exactly two streaming requests to api.anthropic.com, capped at 256 output
# tokens each, with retries disabled at every layer.
#
# The credential is bind-mounted READ-ONLY and the container runs as its owner.
# The probe never refreshes, rotates, copies, or emits it.
#
#   ./run-live.sh --yes
#   ./run-live.sh --yes --credential /path/to/auth.json
#
# Exit codes:
#   0  pass   the live conversation completed and every assertion held
#   1  fail   measured negative — provider rejection or protocol mismatch
#   2  usage
#   3  fault  the measurement could not be trusted
#   4  sanitization violation

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"

CREDENTIAL="${HOME}/.local/share/opencode/auth.json"
CONFIRMED=0
NO_BUILD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --yes)        CONFIRMED=1 ;;
    --credential) CREDENTIAL="${2:-}"; shift ;;
    --no-build)   NO_BUILD=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "${CONFIRMED}" -ne 1 ]; then
  cat >&2 <<'EOF'
Refusing to run without --yes.

This stage sends two real requests to api.anthropic.com using your Anthropic
subscription credential and consumes quota. Re-run with --yes to proceed.
EOF
  exit 2
fi

RUN_ID="${RUN_ID:-live-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="${REPO_ROOT}/tmp/spikes/anthropic-parity/${RUN_ID}"
REL_RUN_DIR="tmp/spikes/anthropic-parity/${RUN_ID}"
IMAGE="agent-runtime/anthropic-parity:${RUN_ID}"

mkdir -p "${RUN_DIR}"
chmod 700 "${RUN_DIR}"

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }

finish_fault() {
  printf '\n\033[1;31mHARNESS FAULT: %s\033[0m\n' "$1" >&2
  exit 3
}
trap 'finish_fault "line ${LINENO}"' ERR

# ---------------------------------------------------------------------------
log "Live run ${RUN_ID}"
info "evidence   ${REL_RUN_DIR}"

[ -f "${CREDENTIAL}" ] || finish_fault "credential file not found"

CRED_MODE="$(stat -c '%a' "${CREDENTIAL}")"
CRED_UID="$(stat -c '%u' "${CREDENTIAL}")"
info "credential mode ${CRED_MODE}, uid ${CRED_UID} (value never read by this script)"

case "${CRED_MODE}" in
  600|400) ;;
  *) finish_fault "credential mode ${CRED_MODE} is too open; expected 600 or 400" ;;
esac

# The image runs as uid 1000; a 0600 file is only readable by its owner.
[ "${CRED_UID}" = "1000" ] || finish_fault "credential uid ${CRED_UID} != container uid 1000"

# ---------------------------------------------------------------------------
if [ "${NO_BUILD}" -eq 0 ]; then
  log "Building the pinned image"
  docker build -t "${IMAGE}" "${HERE}" > "${RUN_DIR}/build.log" 2>&1 \
    || finish_fault "docker build; see ${REL_RUN_DIR}/build.log"
  tail -n 2 "${RUN_DIR}/build.log"
fi

# ---------------------------------------------------------------------------
log "Sending two live requests (quota is consumed here)"

set +e
docker run --rm \
  --read-only \
  --tmpfs /tmp \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 1000:1000 \
  --mount "type=bind,source=${CREDENTIAL},target=/cred/auth.json,readonly" \
  --env LIVE_CREDENTIAL_FILE=/cred/auth.json \
  --env TZ=UTC \
  "${IMAGE}" src/live.ts > "${RUN_DIR}/live-evidence.json" 2> "${RUN_DIR}/live.err"
CODE=$?
set -e

if [ ! -s "${RUN_DIR}/live-evidence.json" ] || ! jq -e '.' "${RUN_DIR}/live-evidence.json" >/dev/null 2>&1; then
  head -n 20 "${RUN_DIR}/live.err" >&2 || true
  finish_fault "live driver produced no valid JSON; see ${REL_RUN_DIR}/live.err"
fi

STATUS="$(jq -r '.outcome.status' "${RUN_DIR}/live-evidence.json")"
info "exit ${CODE}, status ${STATUS}"

if [ "${STATUS}" = "fault" ]; then
  jq -r '.outcome.fault | "    fault: \(.step): \(.message)"' "${RUN_DIR}/live-evidence.json" >&2 || true
  finish_fault "live driver reported a harness fault"
fi

# ---------------------------------------------------------------------------
log "Scanning live evidence"

SCAN_HITS=0
scan_rule() {
  local rule="$1" pattern="$2" exclude="${3:-}" matches count
  matches="$(grep -rEoh -- "${pattern}" "${RUN_DIR}" 2>/dev/null || true)"
  if [ -n "${exclude}" ] && [ -n "${matches}" ]; then
    matches="$(printf '%s\n' "${matches}" | grep -Fv -- "${exclude}" || true)"
  fi
  count="$(printf '%s\n' "${matches}" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
  if [ "${count}" -ne 0 ]; then
    SCAN_HITS=$(( SCAN_HITS + count ))
    printf '  VIOLATION %s: %s occurrence(s)\n' "${rule}" "${count}" >&2
  fi
  printf '{"rule":"%s","occurrences":%s}\n' "${rule}" "${count}"
}

{
  scan_rule "sentinel-token"   'sk-ant-(api|oat|ort)[0-9]{2}-SENTINEL[A-Za-z0-9_-]*'
  scan_rule "anthropic-key"    'sk-ant-(api|oat|ort)[0-9]{2}-[A-Za-z0-9_-]{16,}' 'SENTINEL'
  scan_rule "bearer-plaintext" 'Bearer [A-Za-z0-9_-]{20,}'
  scan_rule "host-path"        '/home/[a-z0-9_-]+/'
  scan_rule "jwt"              'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.'
} > "${RUN_DIR}/scan-rules.ndjson"

jq -s '.' "${RUN_DIR}/scan-rules.ndjson" > "${RUN_DIR}/scan.json"
rm -f "${RUN_DIR}/scan-rules.ndjson"
info "scan violations: ${SCAN_HITS}"

# ---------------------------------------------------------------------------
log "Acceptance"
jq -r '.acceptance | to_entries[] | "  " + (if .value then "PASS" else "FAIL" end) + "  " + .key' \
  "${RUN_DIR}/live-evidence.json" 2>/dev/null || true

FAILED="$(jq -r '[.acceptance // {} | to_entries[] | select(.value == false)] | length' "${RUN_DIR}/live-evidence.json")"

trap - ERR

log "Evidence written to ${REL_RUN_DIR}/live-evidence.json"

if [ "${SCAN_HITS}" -ne 0 ]; then
  chmod -R 0700 "${RUN_DIR}" || true
  printf '\n\033[1;31mSanitization violation: evidence quarantined at %s\033[0m\n' "${REL_RUN_DIR}" >&2
  exit 4
fi

if [ "${CODE}" -ne 0 ] || [ "${FAILED}" -ne 0 ]; then
  printf '\n\033[1;31mLive gate did not pass (%s criteria failed).\033[0m A reproducible negative result is a valid spike outcome — report it, do not paper over it.\n' "${FAILED}"
  exit 1
fi

printf '\n\033[1;32mLive gate passed.\033[0m\n'
