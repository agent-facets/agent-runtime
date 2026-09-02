#!/usr/bin/env bash
#
# Synthetic rehearsal of the live path. No provider traffic, no credential.
#
# This runs the real `run-live.sh` -- not a copy of it -- against a loopback-only
# synthetic issuer and Responses endpoint. That distinction is the whole point:
# a rehearsal that reimplements the docker invocation proves nothing about the
# image pin, the credential tripwire, the volume-reuse refusal, or the
# cleanup/retention branch, and the last of those is the one whose failure
# destroys the only revocable token.
#
# The stage containers join the server's network namespace, so 127.0.0.1 reaches
# it and nothing else is reachable at all -- the server container itself runs
# with --network none.
#
#   ./rehearse-live.sh                    # every scenario
#   ./rehearse-live.sh --no-build
#   ./rehearse-live.sh --only happy,drip   # one invariant, for mutation testing
#
# Exit codes match the spike convention: 0 pass, 1 measured negative,
# 2 usage, 3 harness fault.

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"

NO_BUILD=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) NO_BUILD=1 ;;
    # Comma-separated scenario keys. Exists so a mutation test can target the
    # single invariant it breaks instead of paying for the whole suite.
    --only) ONLY="${2:-}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

want() {
  [ -z "${ONLY}" ] && return 0
  case ",${ONLY}," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

RUN_ID="${RUN_ID:-rehearsal-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="${REPO_ROOT}/tmp/spikes/openai-device-auth/${RUN_ID}"
REL_RUN_DIR="tmp/spikes/openai-device-auth/${RUN_ID}"
IMAGE="${IMAGE:-agent-runtime/openai-device-auth:${RUN_ID}}"
PORT=8080

mkdir -p "${RUN_DIR}"

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
pass() { printf '    \033[32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '    \033[31mFAIL\033[0m  %s\n' "$*"; FAILURES=$(( FAILURES + 1 )); }

FAILURES=0
SERVER_ID=""
SCENARIO_ID=""
HOLDER_ID=""

cleanup() {
  [ -n "${HOLDER_ID}" ] && docker rm -f "${HOLDER_ID}" >/dev/null 2>&1 || true
  [ -n "${SERVER_ID}" ] && docker rm -f "${SERVER_ID}" >/dev/null 2>&1 || true
  [ -n "${SCENARIO_ID}" ] && docker volume rm -f "openai-device-auth-live-${SCENARIO_ID}" >/dev/null 2>&1 || true
  HOLDER_ID=""
  SERVER_ID=""
  SCENARIO_ID=""
}

finish_fault() {
  printf '\n\033[1;31mHARNESS FAULT: %s\033[0m\n' "$1" >&2
  cleanup
  exit 3
}
trap 'finish_fault "line ${LINENO}"' ERR

# ---------------------------------------------------------------------------
log "Rehearsal ${RUN_ID}"
info "evidence  ${REL_RUN_DIR}"
[ -n "${ONLY}" ] && info "scenarios ${ONLY}"

if [ "${NO_BUILD}" -eq 0 ]; then
  log "Building"
  docker build -t "${IMAGE}" "${HERE}" > "${RUN_DIR}/build.log" 2>&1 \
    || finish_fault "docker build; see ${REL_RUN_DIR}/build.log"
fi
docker image inspect "${IMAGE}" >/dev/null 2>&1 || finish_fault "image absent"
IMAGE_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}')"
info "image     ${IMAGE_ID}"

OPENCODE_AUTH="${HOME}/.local/share/opencode/auth.json"
GUARD_BEFORE=""
[ -f "${OPENCODE_AUTH}" ] && GUARD_BEFORE="$(sha256sum "${OPENCODE_AUTH}" | cut -d' ' -f1)"

start_server() {
  local scenario="$1"
  SERVER_ID="$(docker run -d --rm \
    --network none \
    --read-only \
    --tmpfs /tmp \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" \
    --env SPIKE_REHEARSAL_SCENARIO="${scenario}" \
    --env SPIKE_REHEARSAL_PORT="${PORT}" \
    --env TZ=UTC \
    "${IMAGE}" src/synthetic/live-server.ts)"

  for _ in $(seq 1 50); do
    if docker logs "${SERVER_ID}" 2>/dev/null | grep -q '"ready":true'; then return 0; fi
    sleep 0.2
  done
  finish_fault "synthetic server did not become ready"
}

# The real driver, in rehearsal mode. Same image pin, same credential guard,
# same volume lifecycle, same cleanup branch, same exit-code map.
live() {
  local stage="$1"
  local code=0
  RUN_ID="${SCENARIO_ID}" \
  IMAGE_ID="${IMAGE_ID}" \
  SPIKE_SYNTHETIC=1 \
  SPIKE_SYNTHETIC_ISSUER="http://127.0.0.1:${PORT}" \
  SPIKE_SYNTHETIC_MODEL_BASE="http://127.0.0.1:${PORT}/backend-api/codex" \
  SPIKE_NETWORK="container:${SERVER_ID}" \
  SPIKE_KEEP_INIT_SUMMARY="${SPIKE_KEEP_INIT_SUMMARY:-1}" \
    "${HERE}/run-live.sh" "--${stage}" --yes --rehearsal 2>&1 \
      | redact >> "${RUN_DIR}/${SCENARIO_ID}-${stage}.log" || code=$?
  echo "${code}"
}

# The device code reaches the operator's terminal on stderr, which the driver
# passes through. Anything written to a log goes through here first, so a code
# never lands on disk even in a rehearsal where it is synthetic.
redact() { sed -E 's/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/<code>/g'; }

scenario_dir() { echo "${REPO_ROOT}/tmp/spikes/openai-device-auth/${SCENARIO_ID}"; }

begin_scenario() {
  SCENARIO_ID="${RUN_ID}-$1"
  start_server "$2"
}

end_scenario() {
  [ -n "${HOLDER_ID}" ] && docker rm -f "${HOLDER_ID}" >/dev/null 2>&1 || true
  HOLDER_ID=""
  docker rm -f "${SERVER_ID}" >/dev/null 2>&1 || true
  SERVER_ID=""
  docker volume rm -f "openai-device-auth-live-${SCENARIO_ID}" >/dev/null 2>&1 || true
  SCENARIO_ID=""
}

expect_exit() {
  local label="$1" actual="$2" wanted="$3"
  if [ "${actual}" = "${wanted}" ]; then pass "${label} (exit ${actual})";
  else fail "${label}: expected exit ${wanted}, got ${actual}"; fi
}

expect_json() {
  local label="$1" file="$2" filter="$3" wanted="$4"
  local got
  got="$(jq -r "${filter}" "${file}" 2>/dev/null || echo "<unreadable>")"
  if [ "${got}" = "${wanted}" ]; then pass "${label}";
  else fail "${label}: expected ${wanted}, got ${got}"; fi
}

volume_gone() {
  if docker volume inspect "openai-device-auth-live-${SCENARIO_ID}" >/dev/null 2>&1; then
    fail "$1: volume still present"
  else pass "$1"; fi
}

volume_present() {
  if docker volume inspect "openai-device-auth-live-${SCENARIO_ID}" >/dev/null 2>&1; then
    pass "$1"
  else fail "$1: volume was removed"; fi
}

# ---------------------------------------------------------------------------
if want happy; then
  log "Scenario: happy path through the real driver"
  begin_scenario happy happy
  D="$(scenario_dir)"

  expect_exit "init succeeds" "$(live init)" 0
  if [ -f "${D}/.live-init.raw.json" ]; then
    fail "raw init evidence was left on disk"
  else
    pass "raw init evidence is ephemeral"
  fi
  expect_json "init summary retained" "${D}/live-init-summary.json" '.stage' "live-init"
  if [ -s "${D}/provenance.ndjson" ]; then pass "driver digest recorded";
  else fail "driver digest not recorded"; fi
  expect_json "volume seeded owner-only 0700" "${D}/live-init-summary.json" '.volume.mode' "448"
  expect_json "volume owned by the container user" "${D}/live-init-summary.json" '.volume.uid' "$(id -u)"
  expect_json "volume empty at init" "${D}/live-init-summary.json" '.volume.empty' "true"
  expect_json "no listener started" "${D}/live-init-summary.json" '.acceptance.no_listener_started' "true"
  if grep -qE '"user_code"|[A-Z0-9]{4}-[A-Z0-9]{4}' "${D}/live-init-summary.json"; then
    fail "init evidence carries a user code"
  else
    pass "init evidence carries no user code"
  fi

  expect_exit "complete succeeds" "$(live complete)" 0
  expect_json "credential persisted" "${D}/live-complete.json" '.acceptance.credential_persisted' "true"
  expect_json "credential mode 0600" "${D}/live-complete.json" '.acceptance.credential_mode_0600' "true"
  expect_json "exactly one refresh, counted" "${D}/live-complete.json" '.refresh.requests' "1"
  expect_json "refresh budget measured" "${D}/live-complete.json" '.acceptance.refresh_request_budget_respected' "true"
  expect_json "poll loop exercised" "${D}/live-complete.json" '.device.polls' "2"

  expect_exit "reload succeeds in a fresh container" "$(live reload)" 0
  expect_json "request succeeded" "${D}/live-reload.json" '.acceptance.request_succeeded' "true"
  expect_json "genuinely streamed" "${D}/live-reload.json" '.acceptance.genuinely_streamed' "true"
  expect_json "tool call parsed" "${D}/live-reload.json" '.acceptance.tool_call_parsed' "true"
  expect_json "model is expected" "${D}/live-reload.json" '.acceptance.model_is_expected' "true"
  expect_json "stop reason recorded" "${D}/live-reload.json" '.acceptance.stop_reason_recorded' "true"
  expect_json "stop reason is the provider's" "${D}/live-reload.json" '.request.stop_reason' "completed"
  expect_json "usage recorded" "${D}/live-reload.json" '.acceptance.usage_recorded' "true"
  expect_json "request id recorded" "${D}/live-reload.json" '.acceptance.request_id_recorded' "true"
  expect_json "timings recorded" "${D}/live-reload.json" '.acceptance.timings_recorded' "true"
  expect_json "exactly one dispatch" "${D}/live-reload.json" '.request.dispatches' "1"
  expect_json "no unbudgeted refresh in reload" "${D}/live-reload.json" '.isolation.refresh_calls' "0"
  expect_json "max_output_tokens absent" "${D}/live-reload.json" '.acceptance.max_output_tokens_absent' "true"
  expect_json "deadline not exceeded" "${D}/live-reload.json" '.acceptance.deadline_not_exceeded' "true"
  expect_json "revoked" "${D}/live-reload.json" '.cleanup.refresh_token_revoked' "true"
  volume_gone "volume removed after confirmed revocation"

  if grep -qE '"(accept-language|sec-fetch-mode)"' "${D}/live-reload.json"; then
    fail "live request carried undici's unremovable headers"
  else
    pass "live request used the node:http terminal"
  fi

  end_scenario
fi

# ---------------------------------------------------------------------------
if want revokefail; then
  log "Scenario: revocation fails, volume retained and recoverable"
  begin_scenario revokefail revoke-fail
  D="$(scenario_dir)"

  live init >/dev/null
  live complete >/dev/null
  expect_exit "reload reports a measured negative" "$(live reload)" 1
  expect_json "revocation recorded as failed" "${D}/live-reload.json" '.cleanup.refresh_token_revoked' "false"
  volume_present "volume retained when revocation is unconfirmed"

  docker rm -f "${SERVER_ID}" >/dev/null 2>&1; SERVER_ID=""
  start_server happy
  expect_exit "recovery revoke succeeds" "$(live revoke)" 0
  expect_json "recovery revoked the token" "${D}/live-revoke.json" '.cleanup.refresh_token_revoked' "true"
  volume_gone "volume removed after recovery"

  end_scenario
fi

# ---------------------------------------------------------------------------
if want stall; then
  log "Scenario: stalled stream aborts at the idle limit"
  begin_scenario stall idle-stall
  D="$(scenario_dir)"

  live init >/dev/null
  live complete >/dev/null
  STARTED="$(date +%s)"
  expect_exit "reload faults on a stalled stream" "$(live reload)" 3
  ELAPSED=$(( $(date +%s) - STARTED ))
  if [ "${ELAPSED}" -lt 40 ]; then pass "aborted at the idle limit (${ELAPSED}s)";
  else fail "took ${ELAPSED}s: the idle limit did not fire"; fi
  if grep -q "idle" "${D}/live-reload.json"; then pass "idle timeout reported";
  else fail "idle timeout not reported"; fi

  end_scenario
fi

# ---------------------------------------------------------------------------
if want drip; then
  log "Scenario: a dripping stream aborts at the wall-clock deadline"
  begin_scenario drip drip
  D="$(scenario_dir)"

  live init >/dev/null
  live complete >/dev/null
  STARTED="$(date +%s)"
  # An outer bound, so a missing wall-clock deadline shows up as a failed check
  # rather than a hung rehearsal. `timeout` reports 124 when it fires.
  DRIP_CODE=0
  RUN_ID="${SCENARIO_ID}" \
  IMAGE_ID="${IMAGE_ID}" \
  SPIKE_SYNTHETIC=1 \
  SPIKE_SYNTHETIC_ISSUER="http://127.0.0.1:${PORT}" \
  SPIKE_SYNTHETIC_MODEL_BASE="http://127.0.0.1:${PORT}/backend-api/codex" \
  SPIKE_NETWORK="container:${SERVER_ID}" \
    timeout 150 "${HERE}/run-live.sh" --reload --yes --rehearsal 2>&1 \
      | redact >> "${RUN_DIR}/${SCENARIO_ID}-reload.log" || DRIP_CODE=$?
  expect_exit "reload faults on an endless stream" "${DRIP_CODE}" 3
  ELAPSED=$(( $(date +%s) - STARTED ))
  # A 5s drip never trips the 20s idle race, so anything well under 60s means
  # the idle limit fired by accident and the deadline is untested.
  if [ "${ELAPSED}" -ge 55 ] && [ "${ELAPSED}" -lt 110 ]; then
    pass "aborted at the wall-clock deadline (${ELAPSED}s)"
  else
    fail "took ${ELAPSED}s: not the 60s deadline"
  fi
  if grep -q "wall-clock deadline" "${D}/live-reload.json"; then pass "deadline reported";
  else fail "deadline not reported"; fi

  end_scenario
fi

# ---------------------------------------------------------------------------
if want shorttoken; then
  log "Scenario: a store-initiated refresh in reload must be visible"
  begin_scenario shorttoken short-token
  D="$(scenario_dir)"

  live init >/dev/null
  live complete >/dev/null
  # The access token is already inside the refresh margin, so the store
  # refreshes during reload. That is legitimate behaviour and an over-budget
  # measurement -- it must be counted and reported, not silently absorbed.
  expect_exit "reload reports a measured negative" "$(live reload)" 1
  # Not pinned to an exact number. With a 60s lifetime every resolution lands
  # back inside the margin, and there are two resolutions per dispatch -- the
  # SDK's async apiKey resolver and the decorator's. What matters is that the
  # refreshes are counted at all.
  expect_json "the extra refresh was counted" "${D}/live-reload.json" '.isolation.refresh_calls >= 1' "true"
  expect_json "two token resolutions per dispatch" "${D}/live-reload.json" '.isolation.refresh_calls' "2"
  expect_json "the reload refresh budget failed" "${D}/live-reload.json" '.acceptance.no_unbudgeted_refresh' "false"
  # The issuer in this scenario refuses any token but the newest one, so this
  # only passes if cleanup revoked what the store holds now rather than what it
  # read before dispatch. An over-budget refresh must not cost us the ability to
  # end the session.
  expect_json "the rotated token was revoked" "${D}/live-reload.json" \
    '.cleanup.refresh_token_revoked' "true"
  volume_gone "volume removed after revoking the rotated token"

  end_scenario
fi

# ---------------------------------------------------------------------------
if want model; then
  log "Scenario: a different model must not be accepted"
  begin_scenario model model-mismatch
  D="$(scenario_dir)"

  live init >/dev/null
  live complete >/dev/null
  expect_exit "reload reports a measured negative" "$(live reload)" 1
  expect_json "model identity rejected" "${D}/live-reload.json" '.acceptance.model_is_expected' "false"

  end_scenario
fi

# ---------------------------------------------------------------------------
if want error; then
  log "Scenario: a rejected model request must still revoke"
  begin_scenario error model-error
  D="$(scenario_dir)"

  live init >/dev/null
  live complete >/dev/null
  expect_exit "reload faults on a rejected request" "$(live reload)" 3
  # The failure-cleanup record goes to the container's stderr, which the driver
  # passes through rather than capturing as evidence -- a revocation attempt is
  # operational output, not a measurement.
  if grep -q '"attempted_revocation":true,"revoked":true' \
       "${RUN_DIR}/${SCENARIO_ID}-reload.log" 2>/dev/null; then
    pass "post-exchange failure revoked the token"
  else
    fail "post-exchange failure skipped revocation"
  fi
  # The structured record is what lets the driver act; stderr alone is not
  # readable by anything that has to decide whether to keep the volume.
  expect_json "fault evidence records the revocation" "${D}/live-reload.json" \
    '.cleanup.refresh_token_revoked' "true"
  expect_json "fault evidence records the state removal" "${D}/live-reload.json" \
    '.cleanup.state_removed' "true"
  volume_gone "volume removed after a confirmed failure-path cleanup"

  end_scenario
fi

# ---------------------------------------------------------------------------
if want leak; then
  log "Scenario: a leak in persisted evidence must quarantine the run"
  begin_scenario leak leaky
  D="$(scenario_dir)"

  live init >/dev/null
  live complete >/dev/null
  # The provider echoes a credential-shaped key name into an error message. The
  # container's own scanner does not look for key names, so this reaches disk
  # and only the driver's independent scan can stop it.
  expect_exit "reload exits with a sanitization violation" "$(live reload)" 4

  # The driver quarantined this directory; it holds the poisoned artifact on
  # purpose. Remove it rather than exempting it from the scan below, so the two
  # scanners can keep exactly the same pattern list.
  rm -rf "${D}" "${RUN_DIR}/${SCENARIO_ID}-reload.log"

  end_scenario
fi

# ---------------------------------------------------------------------------
if want nostop; then
  log "Scenario: a missing terminal event must be reported, not assumed"
  begin_scenario nostop no-stop
  D="$(scenario_dir)"

  live init >/dev/null
  live complete >/dev/null
  # The client sees a well-formed tool call either way; only the wire reader
  # can tell that the provider never said how the response ended.
  expect_exit "reload reports a measured negative" "$(live reload)" 1
  expect_json "stop reason absent" "${D}/live-reload.json" '.acceptance.stop_reason_recorded' "false"
  expect_json "tool call still parsed" "${D}/live-reload.json" '.acceptance.tool_call_parsed' "true"

  end_scenario
fi

# ---------------------------------------------------------------------------
if want initevidence; then
  log "Scenario: a real init must leave nothing on disk"
  begin_scenario initevidence happy
  D="$(scenario_dir)"

  # The real branch, driven against synthetic endpoints. This is the only way to
  # exercise "a live init persists nothing" without issuing a real device code.
  SPIKE_KEEP_INIT_SUMMARY=0 live init >/dev/null

  if [ -f "${D}/live-init-summary.json" ] || [ -f "${D}/.live-init.raw.json" ]; then
    fail "a live-mode init left evidence on disk"
  else
    pass "a live-mode init left nothing on disk"
  fi

  end_scenario
fi

# ---------------------------------------------------------------------------
if want reuse; then
  log "Scenario: a reused volume must be refused"
  begin_scenario reuse happy
  live init >/dev/null
  expect_exit "second init on an existing volume faults" "$(live init)" 3
  end_scenario
fi

# ---------------------------------------------------------------------------
if want blocked; then
  log "Scenario: a blocked volume removal must be loud"
  begin_scenario blocked happy
  D="$(scenario_dir)"

  live init >/dev/null
  live complete >/dev/null
  # Hold the volume open so `docker volume rm` cannot succeed.
  HOLDER_ID="$(docker run -d --rm \
    --mount "type=volume,source=openai-device-auth-live-${SCENARIO_ID},target=/state" \
    --entrypoint sh "${IMAGE}" -c 'sleep 300')"
  expect_exit "reload faults when cleanup cannot complete" "$(live reload)" 3
  expect_json "the token was still revoked" "${D}/live-reload.json" '.cleanup.refresh_token_revoked' "true"

  end_scenario
fi

# ---------------------------------------------------------------------------
if want guards; then
  log "Scenario: real mode refuses synthetic and model overrides"
  SCENARIO_ID="${RUN_ID}-guards"

  code=0
  SPIKE_SYNTHETIC=1 RUN_ID="${SCENARIO_ID}" IMAGE_ID="${IMAGE_ID}" \
    "${HERE}/run-live.sh" --init --yes >/dev/null 2>&1 || code=$?
  expect_exit "synthetic env refused outside rehearsal mode" "${code}" 2

  code=0
  SPIKE_LIVE_MODEL=gpt-4o RUN_ID="${SCENARIO_ID}" IMAGE_ID="${IMAGE_ID}" \
    "${HERE}/run-live.sh" --init --yes >/dev/null 2>&1 || code=$?
  expect_exit "model override refused" "${code}" 2

  code=0
  RUN_ID="${SCENARIO_ID}" \
    "${HERE}/run-live.sh" --init >/dev/null 2>&1 || code=$?
  expect_exit "--yes is mandatory" "${code}" 2

  code=0
  RUN_ID="${SCENARIO_ID}" IMAGE_ID="${IMAGE_ID}" \
    "${HERE}/run-live.sh" --init --yes >/dev/null 2>&1 || code=$?
  expect_exit "image-id override refused in a live run" "${code}" 2

  code=0
  RUN_ID="${SCENARIO_ID}" EVIDENCE_SOURCE=/nonexistent/evidence.json \
    "${HERE}/run-live.sh" --init --yes >/dev/null 2>&1 || code=$?
  expect_exit "missing offline evidence refused" "${code}" 3

  code=0
  SPIKE_SYNTHETIC=1 \
  SPIKE_SYNTHETIC_ISSUER="http://127.0.0.1:${PORT}" \
  SPIKE_SYNTHETIC_MODEL_BASE="http://127.0.0.1:${PORT}/backend-api/codex" \
  SPIKE_NETWORK=none \
  RUN_ID="${SCENARIO_ID}" \
  IMAGE_ID=sha256:0000000000000000000000000000000000000000000000000000000000000000 \
    "${HERE}/run-live.sh" --init --yes --rehearsal >/dev/null 2>&1 || code=$?
  expect_exit "absent pinned image refused" "${code}" 3

  # A fault between writing the raw init emission and the branch that removes it
  # must still leave nothing behind. A dead network target makes `docker run`
  # fail, which trips the "no valid JSON" refusal at exactly that point.
  SCENARIO_ID="${RUN_ID}-faultinit"
  code=0
  SPIKE_SYNTHETIC=1 \
  SPIKE_SYNTHETIC_ISSUER="http://127.0.0.1:${PORT}" \
  SPIKE_SYNTHETIC_MODEL_BASE="http://127.0.0.1:${PORT}/backend-api/codex" \
  SPIKE_NETWORK="container:does-not-exist" \
  RUN_ID="${SCENARIO_ID}" IMAGE_ID="${IMAGE_ID}" \
    "${HERE}/run-live.sh" --init --yes --rehearsal >/dev/null 2>&1 || code=$?
  expect_exit "a faulted init refuses" "${code}" 3
  if [ -f "${REPO_ROOT}/tmp/spikes/openai-device-auth/${SCENARIO_ID}/.live-init.raw.json" ]; then
    fail "a faulted init left its raw emission on disk"
  else
    pass "a faulted init left nothing on disk"
  fi
  docker volume rm -f "openai-device-auth-live-${SCENARIO_ID}" >/dev/null 2>&1 || true
  SCENARIO_ID="${RUN_ID}-guards"

  # Defensive: if any refusal above ever stops firing, a volume gets created.
  docker volume rm -f "openai-device-auth-live-${SCENARIO_ID}" >/dev/null 2>&1 || true
  SCENARIO_ID=""
fi

# ---------------------------------------------------------------------------
log "Checking the operator's credential and the evidence"

if [ -n "${GUARD_BEFORE}" ]; then
  if [ "$(sha256sum "${OPENCODE_AUTH}" | cut -d' ' -f1)" = "${GUARD_BEFORE}" ]; then
    pass "existing opencode credential unchanged"
  else
    fail "existing opencode credential changed"
  fi
fi

SCAN=0
# The same pattern list the driver uses, so the two scanners cannot disagree
# about what counts as a leak.
for pattern in 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.' 'Bearer [A-Za-z0-9_-]{20,}' \
               'sk-(proj-)?[A-Za-z0-9_-]{20,}' \
               'SPIKESENTINEL(ACCESS|REFRESH|ID)-?[0-9]*' '\b[A-Z0-9]{4}-[A-Z0-9]{4}\b' \
               '(access_token|refresh_token|id_token|chatgpt_account_id)[^_a-z]' \
               '/home/[a-z0-9_-]+/'; do
  # Every artifact, not only evidence JSON: the one-time code first showed up
  # in an operational log, which a JSON-only scan could not see.
  hits="$( { grep -rEoh --binary-files=without-match -- "${pattern}" \
      "${REPO_ROOT}/tmp/spikes/openai-device-auth/${RUN_ID}" \
      "${REPO_ROOT}/tmp/spikes/openai-device-auth/${RUN_ID}"-* 2>/dev/null || true; } \
      | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
  SCAN=$(( SCAN + hits ))
done
if [ "${SCAN}" -eq 0 ]; then pass "no credential-shaped material in rehearsal evidence";
else fail "${SCAN} credential-shaped strings in rehearsal evidence"; fi

STRAY="$(docker volume ls --format '{{.Name}}' | grep -c "openai-device-auth-live-${RUN_ID}" || true)"
if [ "${STRAY}" -eq 0 ]; then pass "no rehearsal volume left behind";
else fail "${STRAY} rehearsal volumes left behind"; fi

# ---------------------------------------------------------------------------
trap - ERR
cleanup

log "Rehearsal evidence in ${REL_RUN_DIR}*"

if [ "${FAILURES}" -ne 0 ]; then
  printf '\n\033[1;31m%s rehearsal checks failed.\033[0m\n' "${FAILURES}"
  exit 1
fi

printf '\n\033[1;32mAll rehearsal checks passed.\033[0m\n'
