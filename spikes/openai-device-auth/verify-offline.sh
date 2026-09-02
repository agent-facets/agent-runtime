#!/usr/bin/env bash
#
# Offline driver for the OpenAI device-auth and transport-parity spike.
#
# The build phase has network access. Every measurement phase runs in a fresh
# container with --network none, all capabilities dropped, no published ports,
# and no credential mount. Loopback stays up inside that namespace, which is
# what the synthetic issuer and the oracle capture server use; nothing can
# route anywhere.
#
# The syscall stage runs separately because it needs SYS_PTRACE, and granting
# that to the main measurement would weaken the isolation the rest depends on.
#
#   ./verify-offline.sh                # 3 repeats, evidence preserved
#   ./verify-offline.sh --repeats 1    # single measurement
#   ./verify-offline.sh --no-oracle    # build without the Codex binary
#   ./verify-offline.sh --cleanup      # remove the image afterwards
#
# Exit codes:
#   0  pass   every acceptance criterion held in every repeat
#   1  fail   a complete, trustworthy measurement disagreed
#   2  usage
#   3  fault  the measurement could not be trusted
#   4  sanitization violation

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"

REPEATS=3
CLEANUP=0
NO_BUILD=0
INSTALL_ORACLE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --repeats)   REPEATS="${2:-}"; shift ;;
    --cleanup)   CLEANUP=1 ;;
    --no-build)  NO_BUILD=1 ;;
    --no-oracle) INSTALL_ORACLE=0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

case "${REPEATS}" in
  ''|*[!0-9]*) echo "--repeats expects a positive integer" >&2; exit 2 ;;
esac
[ "${REPEATS}" -ge 1 ] || { echo "--repeats must be >= 1" >&2; exit 2; }

RUN_ID="${RUN_ID:-offline-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="${REPO_ROOT}/tmp/spikes/openai-device-auth/${RUN_ID}"
REL_RUN_DIR="tmp/spikes/openai-device-auth/${RUN_ID}"
IMAGE="agent-runtime/openai-device-auth:${RUN_ID}"

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
info "oracle    $([ "${INSTALL_ORACLE}" -eq 1 ] && echo 'released Codex binary' || echo 'omitted')"

# ---------------------------------------------------------------------------
if [ "${NO_BUILD}" -eq 0 ]; then
  log "Building the pinned image (network available in this phase only)"
  docker build \
    --build-arg "INSTALL_ORACLE=${INSTALL_ORACLE}" \
    -t "${IMAGE}" "${HERE}" > "${RUN_DIR}/build.log" 2>&1 \
    || finish_fault "docker build; see ${REL_RUN_DIR}/build.log"
  tail -n 3 "${RUN_DIR}/build.log"
else
  docker image inspect "${IMAGE}" >/dev/null 2>&1 || finish_fault "--no-build but image absent"
fi

IMAGE_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}')"
info "image id ${IMAGE_ID}"

# ---------------------------------------------------------------------------
log "Measuring in ${REPEATS} fresh isolated container(s)"

for n in $(seq 1 "${REPEATS}"); do
  out="${RUN_DIR}/run-${n}.json"
  err="${RUN_DIR}/run-${n}.err"

  # `set +e` does not disable an ERR trap -- only membership in an `||` list
  # does. Written the other way, a measured negative (exit 1) would trip the
  # trap and be reported as a harness fault, which is exactly the distinction
  # this script exists to preserve.
  code=0
  docker run --rm \
    --network none \
    --read-only \
    --tmpfs /tmp:exec,size=512m \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --env SPIKE_RUN_INDEX="${n}" \
    --env TZ=UTC \
    "${IMAGE}" src/offline.ts > "${out}" 2> "${err}" || code=$?

  if [ ! -s "${out}" ] || ! jq -e '.' "${out}" >/dev/null 2>&1; then
    finish_fault "run ${n} produced no valid JSON; see ${REL_RUN_DIR}/run-${n}.err"
  fi

  status="$(jq -r '.outcome.status' "${out}")"
  info "run ${n}: exit ${code}, status ${status}"

  if [ "${code}" -eq 3 ] || [ "${status}" = "fault" ]; then
    jq -r '.outcome.fault | "    fault: \(.step): \(.message)"' "${out}" >&2 || true
    finish_fault "run ${n} reported a harness fault"
  fi
  if [ "${code}" -eq 4 ]; then
    chmod -R 0700 "${RUN_DIR}" || true
    printf '\n\033[1;31mSanitization violation inside the container\033[0m\n' >&2
    exit 4
  fi
  if [ "${code}" -ne 0 ] && [ "${code}" -ne 1 ]; then
    finish_fault "run ${n} exited ${code}"
  fi
done

# ---------------------------------------------------------------------------
log "Verifying the write sequence against a kernel trace"

syscall_code=0
docker run --rm \
  --network none \
  --tmpfs /tmp:exec,size=256m \
  --cap-drop ALL \
  --cap-add SYS_PTRACE \
  --security-opt seccomp=unconfined \
  --security-opt no-new-privileges \
  --env TZ=UTC \
  "${IMAGE}" src/syscall-run.ts > "${RUN_DIR}/syscall.json" 2> "${RUN_DIR}/syscall.err" \
  || syscall_code=$?

if [ ! -s "${RUN_DIR}/syscall.json" ] || ! jq -e '.' "${RUN_DIR}/syscall.json" >/dev/null 2>&1; then
  finish_fault "syscall stage produced no valid JSON; see ${REL_RUN_DIR}/syscall.err"
fi
if [ "${syscall_code}" -eq 3 ]; then
  finish_fault "syscall stage reported a harness fault"
fi
info "syscall stage: exit ${syscall_code}"

# ---------------------------------------------------------------------------
log "Comparing managed state across runs"

for n in $(seq 1 "${REPEATS}"); do
  jq -r '.managed_digest' "${RUN_DIR}/run-${n}.json" > "${RUN_DIR}/digest-${n}.txt"
  jq -S '.acceptance' "${RUN_DIR}/run-${n}.json" > "${RUN_DIR}/acceptance-${n}.json"
done

UNIQUE_DIGESTS="$(cat "${RUN_DIR}"/digest-*.txt | sort -u | wc -l | tr -d ' ')"
REPRODUCIBLE=false
[ "${UNIQUE_DIGESTS}" -eq 1 ] && REPRODUCIBLE=true
info "distinct managed digests: ${UNIQUE_DIGESTS} (reproducible: ${REPRODUCIBLE})"

if [ "${REPRODUCIBLE}" != "true" ] && [ "${REPEATS}" -ge 2 ]; then
  diff -u "${RUN_DIR}/run-1.json" "${RUN_DIR}/run-2.json" > "${RUN_DIR}/repeat.diff" || true
fi

ACCEPTANCE_STABLE=true
for n in $(seq 2 "${REPEATS}"); do
  cmp -s "${RUN_DIR}/acceptance-1.json" "${RUN_DIR}/acceptance-${n}.json" || ACCEPTANCE_STABLE=false
done
info "acceptance stable across runs: ${ACCEPTANCE_STABLE}"

# ---------------------------------------------------------------------------
log "Scanning evidence for credential material and host paths"

SCAN_HITS=0

scan_rule() {
  local rule="$1" pattern="$2"
  local matches count
  matches="$(grep -rEoh -- "${pattern}" "${RUN_DIR}" 2>/dev/null || true)"
  count="$(printf '%s\n' "${matches}" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
  if [ "${count}" -ne 0 ]; then
    SCAN_HITS=$(( SCAN_HITS + count ))
    printf '  VIOLATION %s: %s occurrence(s)\n' "${rule}" "${count}" >&2
  fi
  printf '{"rule":"%s","occurrences":%s}\n' "${rule}" "${count}"
}

{
  scan_rule "sentinel-token"   'SPIKESENTINEL(ACCESS|REFRESH|ID)-?[0-9]*'
  scan_rule "openai-key"       'sk-(proj-)?[A-Za-z0-9_-]{20,}'
  scan_rule "bearer-plaintext" 'Bearer [A-Za-z0-9_-]{20,}'
  scan_rule "jwt"              'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.'
  scan_rule "host-path"        '/home/[a-z0-9_-]+/'
  scan_rule "device-user-code" '\b[A-Z0-9]{4}-[A-Z0-9]{4}\b'
} > "${RUN_DIR}/scan-rules.ndjson"

jq -s '.' "${RUN_DIR}/scan-rules.ndjson" > "${RUN_DIR}/scan.json"
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
  --argjson scan "$(cat "${RUN_DIR}/scan.json")" \
  --argjson first "$(cat "${RUN_DIR}/run-1.json")" \
  --argjson syscall "$(cat "${RUN_DIR}/syscall.json")" \
  --argjson fixtures "$(cat "${HERE}/fixtures/manifest.json")" \
  --argjson digests "$(cat "${RUN_DIR}"/digest-*.txt | jq -R -s -c 'split("\n") | map(select(length > 0))')" \
  '{
     schema: "agent-runtime/spike-evidence/1",
     spike: "openai-device-auth",
     run_id: $run_id,
     run_dir: $run_dir,
     image_id: $image_id,
     fixtures: $fixtures,
     container: {
       network_mode: "none",
       read_only: true,
       capabilities: "ALL dropped (syscall stage adds SYS_PTRACE only)",
       published_ports: {},
       credential_mounts: []
     },
     repeats: $repeats,
     managed_digests: $digests,
     reproducible: $reproducible,
     acceptance_stable: $acceptance_stable,
     scan: { violations: $scan_violations, rules: $scan },
     provenance: $first.provenance,
     isolation: $first.isolation,
     auth_store: $first.auth_store,
     transport: $first.transport,
     syscall: $syscall,
     acceptance: ($first.acceptance
                  + ($syscall.acceptance // {})
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
