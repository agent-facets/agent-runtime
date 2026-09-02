#!/usr/bin/env bash
#
# Driver for the LangGraph durability spike.
#
# The build phase has network access. Every measurement runs on a gateway-less
# internal Docker network with no published ports, and the only thing any two
# containers share is Postgres — which is what makes "resumed in a fresh
# process from persisted state alone" structurally true rather than asserted.
#
# The driver owns Docker and persistence. It owns no analysis: the acceptance
# map is computed by the pinned image from the collected case bundles, so the
# claims and the code that makes them stay on the same version. The three
# cross-repeat facts the driver does contribute are named as such and are
# refused rather than faked when there are too few repeats to support them.
#
#   ./verify-durability.sh                 # 3 isolated repeats
#   ./verify-durability.sh --repeats 1     # single measurement, NOT a result
#   ./verify-durability.sh --only seq-crash
#   ./verify-durability.sh --cleanup       # remove volumes and image afterwards
#
# Exit codes:
#   0  pass   every acceptance criterion held in every repeat
#   1  fail   a complete, trustworthy measurement disagreed
#   2  usage
#   3  fault  the measurement could not be trusted
#   4  sanitization violation

set -Eeuo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"

PG_IMAGE="pgvector/pgvector:pg17-bookworm@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f"

REPEATS=3
CLEANUP=0
ONLY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repeats)  REPEATS="${2:-}"; shift ;;
    --only)     ONLY="${2:-}"; shift ;;
    --cleanup)  CLEANUP=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

case "${REPEATS}" in
  ''|*[!0-9]*) echo "--repeats expects a positive integer" >&2; exit 2 ;;
esac
[ "${REPEATS}" -ge 1 ] || { echo "--repeats must be >= 1" >&2; exit 2; }

RUN_ID="${RUN_ID:-durability-$(date -u +%Y%m%dT%H%M%SZ)}"
# RUN_ID reaches container names, Docker object names, and evidence.json. An
# unconstrained value could inject either a shell surprise or unscanned text
# straight into the reported artefact.
case "${RUN_ID}" in
  *[!A-Za-z0-9._-]*|'') echo "RUN_ID must match [A-Za-z0-9._-]+" >&2; exit 2 ;;
esac
[ "${#RUN_ID}" -le 64 ] || { echo "RUN_ID must be <= 64 characters" >&2; exit 2; }

RUN_DIR="${REPO_ROOT}/tmp/spikes/langgraph-durability/${RUN_ID}"
REL_RUN_DIR="tmp/spikes/langgraph-durability/${RUN_ID}"
IMAGE="agent-runtime/langgraph-durability:${RUN_ID}"
SUFFIX="$(printf '%s' "${RUN_ID}" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]' | tail -c 14)"

# The evidence directory gets the same refusal the Docker objects get. Adopting
# a populated directory would let stale case bundles and stale digest files from
# an earlier run silently join this one's result.
if [ -e "${RUN_DIR}" ] && [ -n "$(ls -A "${RUN_DIR}" 2>/dev/null || true)" ]; then
  echo "evidence directory already exists and is not empty: ${REL_RUN_DIR}" >&2
  exit 2
fi
mkdir -p "${RUN_DIR}"

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    \033[33m%s\033[0m\n' "$*"; }

PRESERVED=""
TOOL_CONTAINERS=""

finish_fault() {
  printf '\n\033[1;31mHARNESS FAULT: %s\033[0m\n' "$1" >&2
  jq -n --arg step "$1" --arg run_id "${RUN_ID}" \
    '{schema:"agent-runtime/spike-evidence/1", spike:"langgraph-durability",
      run_id:$run_id, outcome:{status:"fault", fault:{kind:"harness", step:$step}}}' \
    > "${RUN_DIR}/evidence.json" 2>/dev/null || true
  if [ -n "${PRESERVED}" ]; then
    printf '\n    Failed state preserved:\n%s\n' "${PRESERVED}" >&2
  fi
  exit 3
}

trap 'finish_fault "line ${LINENO}"' ERR

command -v docker > /dev/null || finish_fault "docker is required"
command -v jq     > /dev/null || finish_fault "jq is required"

# ---------------------------------------------------------------------------
log "Run ${RUN_ID}"
info "harness   ${HERE#"${REPO_ROOT}/"}"
info "evidence  ${REL_RUN_DIR}"
info "repeats   ${REPEATS}"

# ---------------------------------------------------------------------------
log "Building the pinned image (network available in this phase only)"
docker build -t "${IMAGE}" "${HERE}" > "${RUN_DIR}/build.log" 2>&1 \
  || finish_fault "docker build; see ${REL_RUN_DIR}/build.log"
tail -n 2 "${RUN_DIR}/build.log"
docker pull "${PG_IMAGE}" >> "${RUN_DIR}/build.log" 2>&1 \
  || finish_fault "docker pull of the pinned database image"

IMAGE_ID="$(docker image inspect "${IMAGE}" --format '{{.Id}}')"
PG_IMAGE_ID="$(docker image inspect "${PG_IMAGE}" --format '{{.Id}}')"
info "runtime image  ${IMAGE_ID}"
info "database image ${PG_IMAGE_ID}"

timeout 60 docker run --rm --network none "${IMAGE_ID}" cases > "${RUN_DIR}/cases.json" \
  || finish_fault "could not read the case matrix from the image"
# The manifest comes from the image, not from the host working tree: everything
# else in this harness is sourced from the pinned build, and a host-side edit
# must not be able to misdescribe what actually ran.
timeout 60 docker run --rm --network none "${IMAGE_ID}" manifest > "${RUN_DIR}/manifest.json" \
  || finish_fault "could not read the fixture manifest from the image"

CASE_IDS="$(jq -r '.[].id' "${RUN_DIR}/cases.json")"
SUBSET=false
if [ -n "${ONLY}" ]; then
  CASE_IDS="$(printf '%s\n' "${CASE_IDS}" | grep -Ex "${ONLY}" || true)"
  [ -n "${CASE_IDS}" ] || finish_fault "--only matched no known case: ${ONLY}"
  SUBSET=true
  warn "running a SUBSET; the acceptance map is not a spike result"
fi
info "cases     $(printf '%s\n' "${CASE_IDS}" | grep -c . || true) selected"

# ---------------------------------------------------------------------------
PROJ=""; NET=""; VOL=""; PGC=""; REPDIR=""

worker_flags() {
  printf '%s' \
    "--network ${NET} --read-only --tmpfs /tmp --cap-drop ALL " \
    "--security-opt no-new-privileges --memory 512m --pids-limit 256 --restart=no " \
    "-e PGHOST=postgres -e PGPORT=5432 -e PGUSER=spike -e PGDATABASE=spike -e TZ=UTC"
}

# Persist only the inspect fields the evidence is allowed to make claims about.
# The raw document carries the daemon's storage root and the host PID, neither
# of which any criterion reads and both of which are host detail.
inspect_posture() {  # inspect_posture <container>
  docker inspect "$1" --format '{{json .}}' | jq '{
    status:         .State.Status,
    exitCode:       .State.ExitCode,
    oomKilled:      .State.OOMKilled,
    image:          .Image,
    posture: {
      readOnly:       .HostConfig.ReadonlyRootfs,
      user:           .Config.User,
      capDrop:        (.HostConfig.CapDrop // []),
      securityOpt:    (.HostConfig.SecurityOpt // []),
      publishedPorts: ((.HostConfig.PortBindings // {}) | length),
      binds:          ((.HostConfig.Binds // []) | length),
      mounts:         ((.Mounts // []) | length),
      networkMode:    .HostConfig.NetworkMode,
      pidsLimit:      (.HostConfig.PidsLimit // 0),
      memory:         (.HostConfig.Memory // 0)
    }
  }'
}

# shellcheck disable=SC2086
run_tool() {  # run_tool <outfile> <errfile> <args...>
  local out="$1" err="$2"; shift 2
  local name="${PROJ}-t-$(printf '%s' "$*" | tr -cd '[:alnum:]' | tail -c 24)-${RANDOM}"
  local code=0

  # Named, and NOT --rm. `timeout` signals the docker CLI, which forwards
  # SIGTERM to PID 1; a container that ignores it would otherwise survive
  # unnamed, keep a Postgres connection, and block the network teardown.
  TOOL_CONTAINERS="${TOOL_CONTAINERS} ${name}"
  timeout 180 docker run --name "${name}" $(worker_flags) "${IMAGE_ID}" "$@" \
    > "${out}" 2> "${err}" || code=$?
  docker rm -f "${name}" > /dev/null 2>&1 || true

  # A container that exits 0 having printed nothing is a fault, not a pass. Node
  # exits cleanly when the event loop empties while a promise is still pending,
  # so silence and success are not mutually exclusive here.
  if [ "${code}" = "0" ] && { [ ! -s "${out}" ] || ! jq -e '.' "${out}" > /dev/null 2>&1; }; then
    code="no-json"
  fi
  printf '%s' "${code}"
}

wait_healthy() {
  local deadline=$(( SECONDS + 120 )) status
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    status="$(timeout 15 docker inspect --format '{{.State.Health.Status}}' "${PGC}" 2>/dev/null || echo missing)"
    [ "${status}" = "healthy" ] && return 0
    sleep 2
  done
  return 1
}

# shellcheck disable=SC2086
run_case() {
  local case_id="$1"
  local cd="${REPDIR}/${case_id}"
  mkdir -p "${cd}"

  local def kill_signal resume_mode mutate_action
  def="$(jq -c --arg id "${case_id}" '.[] | select(.id == $id)' "${RUN_DIR}/cases.json")"
  kill_signal="$(jq -r '.kill.signal // ""' <<< "${def}")"
  resume_mode="$(jq -r '.resume' <<< "${def}")"
  mutate_action="$(jq -r '.mutate // ""' <<< "${def}")"

  local await_json="null" kill_json="null" primary_json="null" mutate_json="null"
  local backends_json="null"
  local code

  if [ -z "${kill_signal}" ]; then
    code="$(run_tool "${cd}/run.json" "${cd}/run.err" run --case "${case_id}" --stage control)"
    [ "${code}" = "0" ] || finish_fault "case ${case_id}: control stage exited ${code}"
  else
    local wname="${PROJ}-w-${case_id}" wid
    wid="$(docker run -d --name "${wname}" $(worker_flags) \
             "${IMAGE_ID}" run --case "${case_id}" --stage primary)" \
      || finish_fault "case ${case_id}: could not start the primary"

    local launched
    launched="$(docker inspect --format '{{.Image}}' "${wid}")"
    [ "${launched}" = "${IMAGE_ID}" ] || finish_fault "case ${case_id}: primary ran a different image"

    code="$(run_tool "${cd}/await.json" "${cd}/await.err" await --case "${case_id}")"
    if [ "${code}" != "0" ]; then
      docker logs "${wid}" > "${cd}/primary.log" 2>&1 || true
      finish_fault "case ${case_id}: kill condition never held (await exited ${code})"
    fi
    await_json="$(cat "${cd}/await.json")"

    # Posture and identity captured BEFORE the kill: a dead container reports
    # Pid 0, and the posture is what the evidence will claim rather than assert.
    local primary_short
    primary_short="$(docker inspect --format '{{.Id}}' "${wid}")"
    primary_short="${primary_short:0:12}"
    inspect_posture "${wid}" > "${cd}/primary-inspect.json"

    docker kill --signal="${kill_signal}" "${wid}" > /dev/null \
      || finish_fault "case ${case_id}: docker kill failed"

    local wait_exit
    wait_exit="$(timeout 30 docker wait "${wid}")" \
      || finish_fault "case ${case_id}: the container never terminated after ${kill_signal}"

    docker logs "${wid}" > "${cd}/primary.log" 2>&1 || true
    inspect_posture "${wid}" > "${cd}/primary-final.json"

    local status oom
    status="$(jq -r '.status' "${cd}/primary-final.json")"
    oom="$(jq -r '.oomKilled' "${cd}/primary-final.json")"

    kill_json="$(jq -n \
      --arg signal "${kill_signal}" --argjson waitExit "${wait_exit}" \
      --arg status "${status}" --argjson oomKilled "${oom}" \
      --arg container "${primary_short}" \
      '{signal:$signal, waitExit:$waitExit, status:$status, oomKilled:$oomKilled,
        container:$container}')"
    primary_json="$(jq -n --arg container "${primary_short}" \
      --argjson posture "$(jq '.posture' "${cd}/primary-inspect.json")" \
      '{container:$container, posture:$posture}')"

    docker rm -f "${wid}" > /dev/null 2>&1 || true

    # A SIGKILL leaves no FIN, so the killed process's backend can outlive its
    # container. Resuming while it still holds locks would measure a race the
    # experiment is not describing.
    code="$(run_tool "${cd}/backends.json" "${cd}/backends.err" \
              backends --app-prefix "${case_id}:primary")"
    [ "${code}" = "0" ] || finish_fault "case ${case_id}: backend drain check exited ${code}"
    backends_json="$(jq '{count: .count}' "${cd}/backends.json")"

    if [ -n "${mutate_action}" ]; then
      code="$(run_tool "${cd}/mutate.json" "${cd}/mutate.err" mutate --case "${case_id}")"
      [ "${code}" = "0" ] || finish_fault "case ${case_id}: mutate exited ${code}"
      mutate_json="$(cat "${cd}/mutate.json")"
    fi

    if [ "${resume_mode}" = "checkpoint-id" ]; then
      local ckpt
      ckpt="$(jq -r '.latestCheckpointId // ""' "${cd}/await.json")"
      [ -n "${ckpt}" ] || finish_fault "case ${case_id}: no checkpoint id to resume from"
      code="$(run_tool "${cd}/run.json" "${cd}/run.err" \
                run --case "${case_id}" --stage resume --checkpoint-id "${ckpt}")"
    else
      code="$(run_tool "${cd}/run.json" "${cd}/run.err" run --case "${case_id}" --stage resume)"
    fi
    [ "${code}" = "0" ] || finish_fault "case ${case_id}: resume stage exited ${code}"
  fi

  jq -n \
    --arg case "${case_id}" \
    --argjson await "${await_json}" \
    --argjson kill "${kill_json}" \
    --argjson primary "${primary_json}" \
    --argjson backends "${backends_json}" \
    --argjson mutate "${mutate_json}" \
    --argjson run "$(cat "${cd}/run.json")" \
    '{case:$case, await:$await, kill:$kill, primary:$primary,
      backends:$backends, mutate:$mutate, run:$run}' \
    > "${cd}/case.json"
}

teardown_repeat() {
  docker ps -aq --filter "name=^${PROJ}-" | while read -r cid; do
    [ -n "${cid}" ] && docker rm -f "${cid}" > /dev/null 2>&1 || true
  done
  docker network rm "${NET}" > /dev/null 2>&1 || true
}

# shellcheck disable=SC2086
run_repeat() {
  local repeat="$1"
  PROJ="lgdur-${SUFFIX}-r${repeat}"
  NET="${PROJ}-net"
  VOL="${PROJ}-pgdata"
  PGC="${PROJ}-pg"
  REPDIR="${RUN_DIR}/repeat-${repeat}"
  mkdir -p "${REPDIR}"

  log "Repeat ${repeat} of ${REPEATS}"

  # Never adopt pre-existing state and never silently delete it.
  docker network inspect "${NET}" > /dev/null 2>&1 && finish_fault "network ${NET} already exists"
  docker volume  inspect "${VOL}" > /dev/null 2>&1 && finish_fault "volume ${VOL} already exists"
  [ -z "$(docker ps -aq --filter "name=^${PROJ}-")" ] || finish_fault "containers named ${PROJ}-* already exist"

  docker network create --internal "${NET}" > /dev/null
  docker volume create "${VOL}" > /dev/null

  PRESERVED="      containers ${PROJ}-*
      network    ${NET}
      volume     ${VOL}
      inspect with: docker run --rm -it --network ${NET} ${PG_IMAGE} psql -h postgres -U spike -d spike"

  # Stock entrypoint and a lesser hardening posture than the workers get: the
  # official image starts as root to fix PGDATA ownership before dropping
  # privileges. The evidence scopes its posture claims to the workers for
  # exactly this reason.
  docker run -d --name "${PGC}" \
    --network "${NET}" --network-alias postgres \
    --restart=no \
    -e POSTGRES_USER=spike -e POSTGRES_DB=spike \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -e PGDATA=/var/lib/postgresql/data/pgdata -e TZ=UTC \
    -v "${VOL}:/var/lib/postgresql/data" \
    --health-cmd 'pg_isready -h 127.0.0.1 -U spike -d spike' \
    --health-interval 2s --health-timeout 3s --health-retries 40 --health-start-period 3s \
    "${PG_IMAGE_ID}" > /dev/null

  wait_healthy || finish_fault "repeat ${repeat}: postgres never became healthy"

  # The health probe can pass against initdb's temporary bootstrap server, so
  # readiness is gated a second time on a real query from a real client. `setup`
  # also asserts the exact relation set and records the server version.
  local code
  code="$(run_tool "${REPDIR}/setup.json" "${REPDIR}/setup.err" setup)"
  [ "${code}" = "0" ] || finish_fault "repeat ${repeat}: setup exited ${code}"
  info "postgres  $(jq -r '.serverVersion' "${REPDIR}/setup.json")"

  while read -r case_id; do
    [ -n "${case_id}" ] || continue
    printf '    case %-16s' "${case_id}"
    run_case "${case_id}"
    printf 'ok\n'
  done <<< "${CASE_IDS}"

  # Built from the selected case list, never from a directory glob: a stale
  # case directory must not be able to join this run's bundle set.
  local bundle_files=()
  while read -r case_id; do
    [ -n "${case_id}" ] || continue
    bundle_files+=("${REPDIR}/${case_id}/case.json")
  done <<< "${CASE_IDS}"
  jq -s '.' "${bundle_files[@]}" > "${REPDIR}/bundles.json"

  code=0
  timeout 120 docker run --rm -i --network none "${IMAGE_ID}" summarize \
    < "${REPDIR}/bundles.json" > "${REPDIR}/run.json" 2> "${REPDIR}/run.err" || code=$?
  if [ ! -s "${REPDIR}/run.json" ] || ! jq -e '.' "${REPDIR}/run.json" > /dev/null 2>&1; then
    finish_fault "repeat ${repeat}: summarize produced no valid JSON"
  fi
  [ "${code}" -eq 3 ] && finish_fault "repeat ${repeat}: summarize reported a harness fault"
  [ "${code}" -eq 4 ] && { chmod -R go-rwx "${RUN_DIR}" || true; exit 4; }

  jq -r '.managed_digest' "${REPDIR}/run.json" > "${RUN_DIR}/digest-${repeat}.txt"
  jq -S '.acceptance'     "${REPDIR}/run.json" > "${RUN_DIR}/acceptance-${repeat}.json"
  info "outcome   $(jq -r '.outcome.status' "${REPDIR}/run.json") (exit ${code})"

  if [ "${code}" -eq 0 ]; then
    teardown_repeat
    if [ "${CLEANUP}" -eq 1 ]; then
      docker volume rm "${VOL}" > /dev/null 2>&1 || true
    else
      info "database volume kept: ${VOL}  (trust auth; remove with docker volume rm ${VOL})"
    fi
    PRESERVED=""
  else
    warn "repeat ${repeat} did not pass; state preserved for inspection"
    warn "${VOL}"
    PRESERVED=""
  fi
}

for repeat in $(seq 1 "${REPEATS}"); do
  run_repeat "${repeat}"
done

# ---------------------------------------------------------------------------
log "Comparing managed state across repeats"

DIGEST_FILES=()
ACCEPT_FILES=()
for repeat in $(seq 1 "${REPEATS}"); do
  DIGEST_FILES+=("${RUN_DIR}/digest-${repeat}.txt")
  ACCEPT_FILES+=("${RUN_DIR}/acceptance-${repeat}.json")
done

UNIQUE_DIGESTS="$(cat "${DIGEST_FILES[@]}" | sort -u | wc -l | tr -d ' ')"

# Reproducibility and stability are cross-repeat facts. With one repeat there is
# nothing to compare, and reporting `true` from a single sample would be a claim
# the run did not earn.
if [ "${REPEATS}" -ge 2 ]; then
  REPRODUCIBLE=false
  [ "${UNIQUE_DIGESTS}" -eq 1 ] && REPRODUCIBLE=true
  ACCEPTANCE_STABLE=true
  for repeat in $(seq 2 "${REPEATS}"); do
    cmp -s "${RUN_DIR}/acceptance-1.json" "${RUN_DIR}/acceptance-${repeat}.json" \
      || ACCEPTANCE_STABLE=false
  done
  if [ "${REPRODUCIBLE}" != "true" ]; then
    # Labelled, because `diff -u` writes the absolute paths of its operands into
    # the header — which puts the operator's home directory into an artefact the
    # sanitizer then correctly quarantines the whole run over.
    diff -u --label repeat-1/run.json --label repeat-2/run.json \
      "${RUN_DIR}/repeat-1/run.json" "${RUN_DIR}/repeat-2/run.json" \
      > "${RUN_DIR}/repeat.diff" || true
  fi
else
  REPRODUCIBLE=false
  ACCEPTANCE_STABLE=false
  warn "only one repeat: reproducibility and stability cannot be claimed"
fi
info "distinct managed digests: ${UNIQUE_DIGESTS} (reproducible: ${REPRODUCIBLE})"
info "acceptance stable across repeats: ${ACCEPTANCE_STABLE}"

# ---------------------------------------------------------------------------
log "Composing the evidence summary"

# Composed from files rather than from `--argjson` strings. The canonical
# projections are large enough that inlining them overflows the argument list,
# which fails as a harness fault at the very last step of a good run.
jq -s '[.[].posture] | unique' "${RUN_DIR}"/repeat-*/*/primary-inspect.json \
  > "${RUN_DIR}/postures.json"
cat "${DIGEST_FILES[@]}" | jq -R -s -c 'split("\n") | map(select(length > 0))' \
  > "${RUN_DIR}/digests.json"

jq -n \
  --arg run_id "${RUN_ID}" \
  --arg run_dir "${REL_RUN_DIR}" \
  --arg image_id "${IMAGE_ID}" \
  --arg pg_image_id "${PG_IMAGE_ID}" \
  --arg pg_image "${PG_IMAGE}" \
  --argjson subset "${SUBSET}" \
  --argjson repeats "${REPEATS}" \
  --argjson reproducible "${REPRODUCIBLE}" \
  --argjson acceptance_stable "${ACCEPTANCE_STABLE}" \
  --slurpfile fixturesFile "${RUN_DIR}/manifest.json" \
  --slurpfile firstFile "${RUN_DIR}/repeat-1/run.json" \
  --slurpfile setupFile "${RUN_DIR}/repeat-1/setup.json" \
  --slurpfile posturesFile "${RUN_DIR}/postures.json" \
  --slurpfile digestsFile "${RUN_DIR}/digests.json" \
  '($fixturesFile[0]) as $fixtures
   | ($firstFile[0])   as $first
   | ($setupFile[0])   as $setup
   | ($posturesFile[0]) as $postures
   | ($digestsFile[0])  as $digests
   | {
     schema: "agent-runtime/spike-evidence/1",
     spike: "langgraph-durability",
     run_id: $run_id,
     run_dir: $run_dir,
     subset: $subset,
     image_id: $image_id,
     database: { image: $pg_image, image_id: $pg_image_id,
                 server_version: $setup.serverVersion,
                 auth_method: "trust (isolated internal network, throwaway harness)",
                 hardening: "stock entrypoint; NOT held to the worker posture",
                 relations: $setup.relations },
     fixtures: $fixtures,
     worker_posture: $postures,
     repeats: $repeats,
     managed_digests: $digests,
     reproducible: $reproducible,
     acceptance_stable: $acceptance_stable,
     cases: $first.cases,
     managed: $first.managed,
     acceptance: ($first.acceptance
                  + { reproducible_across_runs: $reproducible,
                      acceptance_stable_across_runs: $acceptance_stable })
   }' > "${RUN_DIR}/evidence.candidate.json"
rm -f "${RUN_DIR}/postures.json" "${RUN_DIR}/digests.json"

# ---------------------------------------------------------------------------
log "Scanning evidence for credential material and host paths"

SCAN_HITS=0
scan_rule() {
  local rule="$1" pattern="$2" matches count
  # -a so a file containing a NUL byte is still scanned rather than silently
  # reported clean.
  matches="$(grep -raEoh -- "${pattern}" "${RUN_DIR}" 2>/dev/null || true)"
  count="$(printf '%s\n' "${matches}" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
  if [ "${count}" -ne 0 ]; then
    SCAN_HITS=$(( SCAN_HITS + count ))
    printf '  VIOLATION %s: %s occurrence(s)\n' "${rule}" "${count}" >&2
  fi
  printf '{"rule":"%s","occurrences":%s}\n' "${rule}" "${count}"
}

# The candidate file is in RUN_DIR, so the artefact that will be reported is
# inside the scan's own coverage. Scanning before composing it — as this driver
# used to — certified a file that had not been written yet.
{
  scan_rule "pg-dsn-with-password"     'postgres(ql)?://[^:@/[:space:]]+:[^@[:space:]]+@'
  scan_rule "pgpassword-env"           'PGPASSWORD=[^[:space:]"]+'
  scan_rule "bearer-plaintext"         'Bearer [A-Za-z0-9_-]{20,}'
  scan_rule "jwt"                      'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.'
  scan_rule "openai-key"               'sk-(proj-)?[A-Za-z0-9_-]{20,}'
  scan_rule "anthropic-key"            'sk-ant-(api|oat|ort)[0-9]{2}-[A-Za-z0-9_-]{16,}'
  scan_rule "model-provider-host"      'api\.(openai|anthropic)\.com'
  scan_rule "host-path"                '/(home|Users)/[A-Za-z0-9._-]+/'
  scan_rule "docker-storage-path"      '/var/lib/docker/'
  scan_rule "container-runtime-socket" '/var/run/docker\.sock|DOCKER_HOST='
} > "${RUN_DIR}/scan-rules.ndjson"

jq -s '.' "${RUN_DIR}/scan-rules.ndjson" > "${RUN_DIR}/scan.json"
rm -f "${RUN_DIR}/scan-rules.ndjson"
info "scan violations: ${SCAN_HITS}"

if [ "${SCAN_HITS}" -ne 0 ]; then
  chmod -R go-rwx "${RUN_DIR}" || true
  printf '\n\033[1;31mSanitization violation: evidence quarantined at %s\033[0m\n' "${REL_RUN_DIR}" >&2
  exit 4
fi

# Promoted only after its own bytes came back clean.
jq --argjson scan "$(cat "${RUN_DIR}/scan.json")" \
   '.scan = {violations: 0, rules: $scan}
    | .acceptance += {no_credential_in_evidence: true}' \
   "${RUN_DIR}/evidence.candidate.json" > "${RUN_DIR}/evidence.json"
rm -f "${RUN_DIR}/evidence.candidate.json"

jq -r '.acceptance | to_entries[] | "  " + (if .value then "PASS" else "FAIL" end) + "  " + .key' \
  "${RUN_DIR}/evidence.json"

FAILED="$(jq -r '[.acceptance | to_entries[] | select(.value == false)] | length' "${RUN_DIR}/evidence.json")"

trap - ERR

if [ "${CLEANUP}" -eq 1 ]; then
  log "Cleaning up (explicitly requested)"
  docker image rm "${IMAGE}" > /dev/null 2>&1 || true
else
  log "Leaving the image in place"
  info "remove with: docker image rm ${IMAGE}"
fi

log "Evidence written to ${REL_RUN_DIR}/evidence.json"

if [ "${FAILED}" -ne 0 ]; then
  printf '\n\033[1;31m%s acceptance criteria failed.\033[0m A reproducible negative result is a valid spike outcome — report it, do not paper over it.\n' "${FAILED}"
  exit 1
fi

printf '\n\033[1;32mAll acceptance criteria passed.\033[0m\n'
