#!/usr/bin/env bash
#
# Offline Anthropic parity spike driver.
#
# Build phase has network access. Measurement phase runs in fresh containers
# with --network none, --read-only, all capabilities dropped, no published
# ports, and no credential mount. The driver owns all persistence; the
# container prints one JSON object to stdout and writes nothing.
#
#   ./verify-parity.sh                # 3 repeats, evidence preserved
#   ./verify-parity.sh --repeats 1    # single measurement
#   ./verify-parity.sh --cleanup      # remove the image afterwards
#
# Exit codes:
#   0  pass   every acceptance criterion held in every repeat
#   1  fail   a complete, trustworthy measurement disagreed with the profile
#   2  usage
#   3  fault  the measurement could not be trusted
#   4  sanitization violation

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"

REPEATS=3
CLEANUP=0
NO_BUILD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repeats)  REPEATS="${2:-}"; shift ;;
    --cleanup)  CLEANUP=1 ;;
    --no-build) NO_BUILD=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

case "${REPEATS}" in
  ''|*[!0-9]*) echo "--repeats expects a positive integer" >&2; exit 2 ;;
esac
[ "${REPEATS}" -ge 1 ] || { echo "--repeats must be >= 1" >&2; exit 2; }

RUN_ID="${RUN_ID:-parity-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="${REPO_ROOT}/tmp/spikes/anthropic-parity/${RUN_ID}"
REL_RUN_DIR="tmp/spikes/anthropic-parity/${RUN_ID}"
IMAGE="agent-runtime/anthropic-parity:${RUN_ID}"

mkdir -p "${RUN_DIR}"

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }

finish_fault() {
  printf '\n\033[1;31mHARNESS FAULT: %s\033[0m\n' "$1" >&2
  jq -n --arg step "$1" --arg run_id "${RUN_ID}" \
    '{run_id:$run_id, outcome:{status:"fault", fault:{kind:"harness", step:$step}}}' \
    > "${RUN_DIR}/evidence.json" 2>/dev/null || true
  exit 3
}

trap 'finish_fault "line ${LINENO}"' ERR

# ---------------------------------------------------------------------------
log "Run ${RUN_ID}"
info "harness   ${HERE#"${REPO_ROOT}/"}"
info "evidence  ${REL_RUN_DIR}"
info "repeats   ${REPEATS}"

# ---------------------------------------------------------------------------
if [ "${NO_BUILD}" -eq 0 ]; then
  log "Building the pinned image (network available in this phase only)"
  docker build -t "${IMAGE}" "${HERE}" > "${RUN_DIR}/build.log" 2>&1 \
    || finish_fault "docker build; see ${REL_RUN_DIR}/build.log"
  tail -n 3 "${RUN_DIR}/build.log"
else
  docker image inspect "${IMAGE}" >/dev/null 2>&1 || finish_fault "--no-build but image absent"
fi

docker image inspect "${IMAGE}" \
  --format '{{json (index .RepoDigests 0)}}{{"\n"}}{{json .Config.Env}}' \
  > "${RUN_DIR}/image.txt" 2>/dev/null || true

IMAGE_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}')"
info "image id ${IMAGE_ID}"

# ---------------------------------------------------------------------------
log "Measuring in ${REPEATS} fresh isolated container(s)"

declare -a RUN_STATUS=()
for n in $(seq 1 "${REPEATS}"); do
  out="${RUN_DIR}/run-${n}.json"
  err="${RUN_DIR}/run-${n}.err"

  set +e
  docker run --rm \
    --network none \
    --read-only \
    --tmpfs /tmp \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --env PARITY_RUN_INDEX="${n}" \
    --env TZ=UTC \
    "${IMAGE}" > "${out}" 2> "${err}"
  code=$?
  set -e

  RUN_STATUS+=("${code}")

  if [ ! -s "${out}" ] || ! jq -e '.' "${out}" >/dev/null 2>&1; then
    finish_fault "run ${n} produced no valid JSON; see ${REL_RUN_DIR}/run-${n}.err"
  fi

  status="$(jq -r '.outcome.status' "${out}")"
  info "run ${n}: exit ${code}, status ${status}"

  if [ "${code}" -eq 3 ] || [ "${status}" = "fault" ]; then
    jq -r '.outcome.fault | "    fault: \(.step): \(.message)"' "${out}" >&2 || true
    finish_fault "run ${n} reported a harness fault"
  fi
  if [ "${code}" -ne 0 ] && [ "${code}" -ne 1 ]; then
    finish_fault "run ${n} exited ${code}"
  fi
done

# ---------------------------------------------------------------------------
log "Comparing managed state across runs"

for n in $(seq 1 "${REPEATS}"); do
  jq -r '.managed_digest' "${RUN_DIR}/run-${n}.json" > "${RUN_DIR}/digest-${n}.txt"
done

UNIQUE_DIGESTS="$(cat "${RUN_DIR}"/digest-*.txt | sort -u | wc -l | tr -d ' ')"
REPRODUCIBLE=false
[ "${UNIQUE_DIGESTS}" -eq 1 ] && REPRODUCIBLE=true
info "distinct managed digests: ${UNIQUE_DIGESTS} (reproducible: ${REPRODUCIBLE})"

if [ "${REPRODUCIBLE}" != "true" ]; then
  diff -u "${RUN_DIR}/run-1.json" "${RUN_DIR}/run-2.json" > "${RUN_DIR}/repeat.diff" || true
fi

# Acceptance must also be identical across runs.
for n in $(seq 1 "${REPEATS}"); do
  jq -S '.acceptance' "${RUN_DIR}/run-${n}.json" > "${RUN_DIR}/acceptance-${n}.json"
done
ACCEPTANCE_STABLE=true
for n in $(seq 2 "${REPEATS}"); do
  cmp -s "${RUN_DIR}/acceptance-1.json" "${RUN_DIR}/acceptance-${n}.json" || ACCEPTANCE_STABLE=false
done
info "acceptance stable across runs: ${ACCEPTANCE_STABLE}"

# ---------------------------------------------------------------------------
log "Scanning evidence for credential material and host paths"

SCAN_HITS=0
SCAN_REPORT="${RUN_DIR}/scan.json"

# grep exits 1 on "no match", which is the expected case here, so every call is
# guarded: under `pipefail` an unguarded no-match would abort the run and be
# indistinguishable from a real fault.
scan_rule() {
  local rule="$1" pattern="$2" exclude="${3:-}"
  local matches count

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

# A sentinel is fake by construction, so it is excluded from the key-shaped
# rule and caught by its own rule instead: a sentinel reaching evidence is a
# redaction failure even though it is not a real credential.
{
  scan_rule "sentinel-token"   'sk-ant-(api|oat|ort)[0-9]{2}-SENTINEL[A-Za-z0-9_-]*'
  scan_rule "anthropic-key"    'sk-ant-(api|oat|ort)[0-9]{2}-[A-Za-z0-9_-]{16,}' 'SENTINEL'
  scan_rule "bearer-plaintext" 'Bearer [A-Za-z0-9_-]{20,}'
  scan_rule "host-path"        '/home/[a-z0-9_-]+/'
  scan_rule "jwt"              'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.'
} > "${RUN_DIR}/scan-rules.ndjson"

jq -s '.' "${RUN_DIR}/scan-rules.ndjson" > "${SCAN_REPORT}"
rm -f "${RUN_DIR}/scan-rules.ndjson"

info "scan violations: ${SCAN_HITS}"

# ---------------------------------------------------------------------------
log "Writing the evidence summary"

jq -n \
  --arg run_id "${RUN_ID}" \
  --arg run_dir "${REL_RUN_DIR}" \
  --arg image_id "${IMAGE_ID}" \
  --argjson repeats "${REPEATS}" \
  --argjson reproducible "${REPRODUCIBLE}" \
  --argjson acceptance_stable "${ACCEPTANCE_STABLE}" \
  --argjson scan_violations "${SCAN_HITS}" \
  --argjson scan "$(cat "${SCAN_REPORT}")" \
  --argjson first "$(cat "${RUN_DIR}/run-1.json")" \
  --argjson digests "$(cat "${RUN_DIR}"/digest-*.txt | jq -R -s -c 'split("\n") | map(select(length > 0))')" \
  '{
     schema: "agent-runtime/spike-evidence/1",
     spike: "anthropic-parity",
     run_id: $run_id,
     run_dir: $run_dir,
     image_id: $image_id,
     container: {
       network_mode: "none",
       read_only: true,
       capabilities: "ALL dropped",
       published_ports: {},
       credential_mounts: []
     },
     repeats: $repeats,
     managed_digests: $digests,
     reproducible: $reproducible,
     acceptance_stable: $acceptance_stable,
     scan: { violations: $scan_violations, rules: $scan },
     profile: $first.profile,
     provenance: $first.provenance,
     model_identity: $first.model_identity,
     isolation: $first.isolation,
     binding_guards: $first.binding_guards,
     allowlist: $first.allowlist,
     cases: [ $first.cases[] | { id, purpose, projection_equal, profile_bearing_diffs,
                                 unexplained_diffs, allowlisted_diffs,
                                 decorator_is_load_bearing, response_expectations_met,
                                 reference_tool_name, candidate_tool_name } ],
     negative_controls: $first.negative_controls,
     streaming: $first.streaming,
     acceptance: ($first.acceptance
                  + { reproducible_across_runs: $reproducible,
                      acceptance_stable_across_runs: $acceptance_stable,
                      no_credential_in_evidence: ($scan_violations == 0) })
   }' > "${RUN_DIR}/evidence.json"

jq -r '.acceptance | to_entries[] | "  " + (if .value then "PASS" else "FAIL" end) + "  " + .key' \
  "${RUN_DIR}/evidence.json"

FAILED="$(jq -r '[.acceptance | to_entries[] | select(.value == false)] | length' "${RUN_DIR}/evidence.json")"

# ---------------------------------------------------------------------------
trap - ERR

if [ "${CLEANUP}" -eq 1 ]; then
  log "Cleaning up (explicitly requested)"
  docker image rm "${IMAGE}" >/dev/null 2>&1 || true
else
  log "Leaving the image in place"
  info "remove with: docker image rm ${IMAGE}"
fi

log "Evidence written to ${REL_RUN_DIR}/evidence.json"

if [ "${SCAN_HITS}" -ne 0 ]; then
  chmod -R 0700 "${RUN_DIR}" || true
  printf '\n\033[1;31mSanitization violation: evidence quarantined at %s\033[0m\n' "${REL_RUN_DIR}" >&2
  exit 4
fi

if [ "${FAILED}" -ne 0 ]; then
  printf '\n\033[1;31m%s acceptance criteria failed.\033[0m A reproducible negative result is a valid spike outcome — report it, do not paper over it.\n' "${FAILED}"
  exit 1
fi

printf '\n\033[1;32mAll acceptance criteria passed.\033[0m\n'
