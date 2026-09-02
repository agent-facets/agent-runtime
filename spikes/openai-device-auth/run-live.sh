#!/usr/bin/env bash
#
# Live driver. THIS CREATES A REAL CHATGPT SESSION AND CONSUMES QUOTA.
#
# Four stages. The first three run in three separate containers, because the
# restart is part of what is being proven: --reload shares nothing with
# --complete except the volume.
#
#   --init      one real device-code request; prints the URL and one-time code
#   --complete  poll, exchange, persist, and force exactly one refresh
#   --reload    a fresh container reloads, makes one model request, revokes
#   --revoke    recovery only: revoke whatever the volume still holds
#
# The operator's existing credential store is never mounted, read, or written by
# any container. This script digests it before the stage and again on every exit
# path, including failures, as a tripwire.
#
# Everything the spike creates lives in one private, owner-only Docker volume.
# If revocation fails the volume is deliberately KEPT, because deleting the only
# revocable token would leave a live session with no way to end it.
#
# The image is pinned by id, not by tag: staged invocations must all run the
# same build that the offline evidence verified.
#
# Refuses to run without --yes.

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"

STAGE=""
CONFIRMED=0
KEEP=0
REHEARSAL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --init|--complete|--reload|--revoke) STAGE="${1#--}" ;;
    --yes)  CONFIRMED=1 ;;
    --keep) KEEP=1 ;;
    # Runs this exact script against loopback-only synthetic endpoints. Every
    # branch below is shared with the live path; only the endpoints and the
    # network namespace differ, which is the point -- a rehearsal that
    # reimplements the orchestration proves nothing about the orchestration.
    --rehearsal) REHEARSAL=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -n "${STAGE}" ] || { echo "one of --init, --complete, --reload, --revoke is required" >&2; exit 2; }
[ "${CONFIRMED}" -eq 1 ] || {
  echo "refusing to run without --yes: this stage reaches the real provider" >&2
  exit 2
}

# A real run must not be silently synthetic, and must never have its model
# swapped. Both are refused here as well as inside the container.
if [ "${REHEARSAL}" -eq 0 ]; then
  for forbidden in SPIKE_SYNTHETIC SPIKE_SYNTHETIC_ISSUER SPIKE_SYNTHETIC_MODEL_BASE SPIKE_LIVE_MODEL; do
    if [ -n "${!forbidden:-}" ]; then
      echo "refusing to run live with ${forbidden} set" >&2
      exit 2
    fi
  done
else
  if [ -n "${SPIKE_LIVE_MODEL:-}" ]; then
    echo "SPIKE_LIVE_MODEL is never honoured, rehearsal or not" >&2
    exit 2
  fi
  : "${SPIKE_SYNTHETIC:?--rehearsal requires SPIKE_SYNTHETIC=1}"
  : "${SPIKE_SYNTHETIC_ISSUER:?--rehearsal requires SPIKE_SYNTHETIC_ISSUER}"
  : "${SPIKE_SYNTHETIC_MODEL_BASE:?--rehearsal requires SPIKE_SYNTHETIC_MODEL_BASE}"
  : "${SPIKE_NETWORK:?--rehearsal requires SPIKE_NETWORK}"
fi

# Whether the init stage keeps a counters-only summary. Off for a real run: the
# device-code step must leave nothing on disk. The rehearsal turns it on so it
# has something to assert against -- and can turn it back off, which is the only
# way to exercise the real branch without real traffic.
KEEP_INIT_SUMMARY="${SPIKE_KEEP_INIT_SUMMARY:-${REHEARSAL}}"

RUN_ID="${RUN_ID:?RUN_ID must be set so every stage shares one volume and run directory}"
RUN_DIR="${REPO_ROOT}/tmp/spikes/openai-device-auth/${RUN_ID}"
REL_RUN_DIR="tmp/spikes/openai-device-auth/${RUN_ID}"
VOLUME="openai-device-auth-live-${RUN_ID}"

mkdir -p "${RUN_DIR}"

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }

finish_fault() {
  printf '\n\033[1;31mHARNESS FAULT: %s\033[0m\n' "$1" >&2
  exit 3
}
trap 'finish_fault "line ${LINENO}"' ERR

# ---------------------------------------------------------------------------
# Image identity. Pinned by id so three staged invocations cannot silently run
# three different builds, and checked against the offline evidence that proved
# this build behaves.

EVIDENCE_SOURCE="${EVIDENCE_SOURCE:-${REPO_ROOT}/tmp/spikes/openai-device-auth/offline-final/evidence.json}"

if [ -n "${IMAGE_ID:-}" ] && [ "${REHEARSAL}" -eq 0 ]; then
  echo "IMAGE_ID is not honoured in a live run; the image comes from passing evidence" >&2
  exit 2
fi

if [ -n "${IMAGE_ID:-}" ]; then
  PINNED_IMAGE="${IMAGE_ID}"
else
  [ -f "${EVIDENCE_SOURCE}" ] \
    || finish_fault "no verified offline evidence at ${EVIDENCE_SOURCE}; set IMAGE_ID to override"
  PINNED_IMAGE="$(jq -r '.image_id' "${EVIDENCE_SOURCE}")"
  [ -n "${PINNED_IMAGE}" ] && [ "${PINNED_IMAGE}" != "null" ] \
    || finish_fault "evidence at ${EVIDENCE_SOURCE} records no image_id"
  OFFLINE_FAILED="$(jq -r '[.acceptance | to_entries[] | select(.value == false)] | length' "${EVIDENCE_SOURCE}")"
  [ "${OFFLINE_FAILED}" -eq 0 ] \
    || finish_fault "the referenced offline run has ${OFFLINE_FAILED} failing criteria; not going live on it"
fi

docker image inspect "${PINNED_IMAGE}" >/dev/null 2>&1 \
  || finish_fault "pinned image ${PINNED_IMAGE} is not present locally"

# ---------------------------------------------------------------------------
# Tripwire on the operator's own credential store. Read here, in this shell,
# and never inside a container. The digest lives in a shell variable and dies
# with the process.

OPENCODE_AUTH="${HOME}/.local/share/opencode/auth.json"
GUARD_BEFORE=""
GUARD_MODE_BEFORE=""

guard_begin() {
  [ -f "${OPENCODE_AUTH}" ] || { info "no existing opencode credential to guard"; return 0; }
  GUARD_BEFORE="$(sha256sum "${OPENCODE_AUTH}" | cut -d' ' -f1)"
  GUARD_MODE_BEFORE="$(stat -c '%a' "${OPENCODE_AUTH}")"
  info "existing credential guarded (mode ${GUARD_MODE_BEFORE})"
}

guard_end() {
  [ -n "${GUARD_BEFORE}" ] || return 0
  local after mode
  after="$(sha256sum "${OPENCODE_AUTH}" | cut -d' ' -f1)"
  mode="$(stat -c '%a' "${OPENCODE_AUTH}")"
  if [ "${after}" != "${GUARD_BEFORE}" ] || [ "${mode}" != "${GUARD_MODE_BEFORE}" ]; then
    printf '\n\033[1;31mThe existing opencode credential changed during this stage.\033[0m\n' >&2
    exit 3
  fi
  info "existing credential unchanged"
}

# Runs on every exit path, including the ERR trap, an early refusal, and a
# SIGINT. The raw init emission is removed here rather than only on the success
# branch, because every path between writing it and reaching that branch would
# otherwise leave it behind.
cleanup_on_exit() {
  rm -f "${RUN_DIR}/.live-init.raw.json"
  guard_end
}
trap 'cleanup_on_exit' EXIT

guard_begin

# ---------------------------------------------------------------------------
# The private volume. Owner-only, created empty, never shared, never reused.

volume_exists() { docker volume inspect "${VOLUME}" >/dev/null 2>&1; }

if [ "${STAGE}" = "init" ]; then
  if volume_exists; then
    finish_fault "volume ${VOLUME} already exists; --init requires a fresh one (use a new RUN_ID)"
  fi
  docker volume create "${VOLUME}" >/dev/null
  info "created private volume ${VOLUME}"
else
  volume_exists || finish_fault "volume ${VOLUME} is absent; run --init first"
fi

run_stage() {
  local stage="$1" out="$2"
  local code=0
  local -a extra=()
  if [ "${REHEARSAL}" -eq 1 ]; then
    extra=(
      --network "${SPIKE_NETWORK}"
      --env SPIKE_SYNTHETIC="${SPIKE_SYNTHETIC}"
      --env SPIKE_SYNTHETIC_ISSUER="${SPIKE_SYNTHETIC_ISSUER}"
      --env SPIKE_SYNTHETIC_MODEL_BASE="${SPIKE_SYNTHETIC_MODEL_BASE}"
    )
  fi
  docker run --rm \
    --read-only \
    --tmpfs /tmp:exec,size=256m \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" \
    --mount "type=volume,source=${VOLUME},target=/state" \
    --env SPIKE_STATE_DIR=/state \
    --env TZ=UTC \
    "${extra[@]}" \
    "${PINNED_IMAGE}" src/live.ts "${stage}" > "${out}" || code=$?
  return "${code}"
}

DRIVER_DIGEST="$(sha256sum "${BASH_SOURCE[0]}" | cut -d' ' -f1)"
printf '{"driver_sha256":"%s","image_id":"%s","stage":"%s"}\n' \
  "${DRIVER_DIGEST}" "${PINNED_IMAGE}" "${STAGE}" >> "${RUN_DIR}/provenance.ndjson"

log "Live stage: ${STAGE} (run ${RUN_ID})"
info "image     ${PINNED_IMAGE}"
info "driver    ${DRIVER_DIGEST}"
info "volume    ${VOLUME}"
info "evidence  ${REL_RUN_DIR}"

# The init stage's raw emission is treated as ephemeral: a summary is kept for
# verification and the raw file is removed, so nothing from the device-code step
# lingers on disk beyond the counters that prove it behaved.
if [ "${STAGE}" = "init" ]; then
  OUT="${RUN_DIR}/.live-init.raw.json"
else
  OUT="${RUN_DIR}/live-${STAGE}.json"
fi

CODE=0
run_stage "${STAGE}" "${OUT}" || CODE=$?

if [ ! -s "${OUT}" ] || ! jq -e '.' "${OUT}" >/dev/null 2>&1; then
  finish_fault "stage ${STAGE} produced no valid JSON"
fi

# A real run that reports itself synthetic means the endpoint policy was
# substituted, which would make every downstream conclusion false.
if [ "${REHEARSAL}" -eq 0 ]; then
  jq -e '.synthetic == false' "${OUT}" >/dev/null 2>&1 \
    || finish_fault "stage ${STAGE} reported synthetic endpoints during a live run"
else
  jq -e '.synthetic == true' "${OUT}" >/dev/null 2>&1 \
    || finish_fault "rehearsal stage ${STAGE} did not use synthetic endpoints"
fi

status="$(jq -r '.outcome.status' "${OUT}")"
info "exit ${CODE}, status ${status}"

jq -r '.acceptance // {} | to_entries[] | "  " + (if .value then "PASS" else "FAIL" end) + "  " + .key' "${OUT}"

if [ "${STAGE}" = "init" ]; then
  if [ "${KEEP_INIT_SUMMARY}" -eq 1 ]; then
    # Counters only -- no code, no token, no account identifier.
    jq '{schema, spike, stage, synthetic, device, volume, isolation, acceptance, outcome}' \
      "${OUT}" > "${RUN_DIR}/live-init-summary.json"
    rm -f "${OUT}"
    OUT="${RUN_DIR}/live-init-summary.json"
    info "init evidence reduced to ${REL_RUN_DIR}/live-init-summary.json"
  else
    # A real device-code step leaves nothing on disk. The acceptance lines above
    # are the record, and they have already been printed to the terminal.
    rm -f "${OUT}"
    info "init evidence discarded; nothing from the device-code step persists"
  fi
fi

# ---------------------------------------------------------------------------
# An independent scan of everything this run persisted. The container scans its
# own emission before printing; this is the second, outside check, and it covers
# artifacts the container never sees.
#
# The key-name rule ends in [^_a-z] so a leaked key matches while this harness's
# own fields (refresh_token_revoked, ...) do not. A leaked key arrives inside a
# JSON string, where its quotes are backslash-escaped, so the quotes cannot be
# used as anchors.
scan_run_dir() {
  local hits=0 pattern count
  for pattern in \
      'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.' \
      'Bearer [A-Za-z0-9_-]{20,}' \
      'sk-(proj-)?[A-Za-z0-9_-]{20,}' \
      '\b[A-Z0-9]{4}-[A-Z0-9]{4}\b' \
      '(access_token|refresh_token|id_token|chatgpt_account_id)[^_a-z]' \
      '/home/[a-z0-9_-]+/'; do
    count="$( { grep -rEoh --binary-files=without-match -- "${pattern}" "${RUN_DIR}" 2>/dev/null || true; } \
      | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
    if [ "${count}" -ne 0 ]; then
      printf '  VIOLATION %s: %s occurrence(s)\n' "${pattern}" "${count}" >&2
      hits=$(( hits + count ))
    fi
  done
  echo "${hits}"
}

SCAN_HITS="$(scan_run_dir)"
info "evidence scan violations: ${SCAN_HITS}"

trap - ERR

if [ "${STAGE}" = "reload" ] || [ "${STAGE}" = "revoke" ]; then
  REVOKED="$(jq -r '.cleanup.refresh_token_revoked // false' "${OUT}")"
  STATE_REMOVED="$(jq -r '.cleanup.state_removed // false' "${OUT}")"

  if [ "${REVOKED}" = "true" ] && [ "${STATE_REMOVED}" = "true" ] && [ "${KEEP}" -eq 0 ]; then
    # A silent failure here would leave a volume behind while the run reports
    # clean, so the failure is loud and the exit code reflects it.
    if docker volume rm "${VOLUME}" >/dev/null 2>&1; then
      info "private volume removed"
    else
      printf '\n\033[1;31mFailed to remove %s. The token is revoked; remove it manually.\033[0m\n' \
        "${VOLUME}" >&2
      CODE=3
    fi
  elif [ "${KEEP}" -eq 1 ]; then
    info "retaining ${VOLUME} at your request"
  else
    printf '\n\033[1;33mRetaining %s: revocation was not confirmed.\033[0m\n' "${VOLUME}" >&2
    # Repo-relative, not "$0": an absolute path is a host detail and this line
    # is passed straight through into operational logs.
    printf 'Recover with: RUN_ID=%s ./%s --revoke --yes\n' \
      "${RUN_ID}" "${HERE#"${REPO_ROOT}/"}/run-live.sh" >&2
    printf 'Do not delete it until the session is revoked; it holds the only revocable token.\n' >&2
  fi
fi

# A leak outranks the stage's own result: the evidence cannot be trusted or kept.
if [ "${SCAN_HITS}" -ne 0 ]; then
  CODE=4
fi

case "${CODE}" in
  0) printf '\n\033[1;32mStage %s passed.\033[0m\n' "${STAGE}" ;;
  1) printf '\n\033[1;31mStage %s reported a measured negative.\033[0m\n' "${STAGE}" ;;
  3) printf '\n\033[1;31mStage %s reported a harness fault.\033[0m\n' "${STAGE}" >&2 ;;
  4) chmod -R 0700 "${RUN_DIR}" || true
     printf '\n\033[1;31mSanitization violation: evidence quarantined.\033[0m\n' >&2 ;;
esac

exit "${CODE}"
