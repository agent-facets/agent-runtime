#!/usr/bin/env bash
#
# Driver for the Postgres checkpointer and Store concurrency spike.
#
# The build phase has network access. Every measurement runs on a gateway-less
# internal Docker network with no published ports, and the only thing any two
# containers share is Postgres — which is what makes "a fresh process resumed
# from persisted state alone" structurally true rather than asserted.
#
# The driver owns Docker and persistence. It owns no analysis: the acceptance
# map and every digest are computed by the pinned image from the collected case
# bundles, so the claims and the code that makes them stay on the same version.
# The cross-repeat facts the driver does contribute are named as such and are
# refused rather than faked when there are too few repeats to support them.
#
# Each experiment family gets its OWN PostgreSQL container and named volume per
# repeat, on one shared network. `CREATE EXTENSION` is database-scoped, so a
# migration race in one family would otherwise pre-create state another family
# has to race for.
#
#   ./verify-concurrency.sh                      # 3 isolated repeats
#   ./verify-concurrency.sh --repeats 1          # a measurement, NOT a result
#   ./verify-concurrency.sh --family S           # one family
#   ./verify-concurrency.sh --only 's0[24].*'    # anchored regex over case ids
#   ./verify-concurrency.sh --cleanup            # remove volumes and image after a clean run
#
# Exit codes (inherited unchanged from spike 05):
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
LANE=""
FAMILY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repeats) REPEATS="${2:-}"; shift ;;
    --only)    ONLY="${2:-}"; shift ;;
    --lane)    LANE="${2:-}"; shift ;;
    --family)  FAMILY="${2:-}"; shift ;;
    --cleanup) CLEANUP=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

case "${REPEATS}" in
  ''|*[!0-9]*) echo "--repeats expects a positive integer" >&2; exit 2 ;;
esac
[ "${REPEATS}" -ge 1 ] || { echo "--repeats must be >= 1" >&2; exit 2; }

RUN_ID="${RUN_ID:-concurrency-$(date -u +%Y%m%dT%H%M%SZ)}"
# RUN_ID reaches container names, Docker object names, and the evidence file. An
# unconstrained value could inject either a shell surprise or unscanned text
# straight into the reported artefact. `preserved.json` carries these names
# LITERALLY so they are copy-pasteable, which is safe only because of this.
case "${RUN_ID}" in
  *[!A-Za-z0-9._-]*|'') echo "RUN_ID must match [A-Za-z0-9._-]+" >&2; exit 2 ;;
esac
[ "${#RUN_ID}" -le 64 ] || { echo "RUN_ID must be <= 64 characters" >&2; exit 2; }

SPIKE="postgres-checkpointer-concurrency"
RUN_DIR="${REPO_ROOT}/tmp/spikes/${SPIKE}/${RUN_ID}"
REL_RUN_DIR="tmp/spikes/${SPIKE}/${RUN_ID}"
IMAGE="agent-runtime/${SPIKE}:${RUN_ID}"
SUFFIX="$(printf '%s' "${RUN_ID}" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]' | tail -c 14)"

if [ -e "${RUN_DIR}" ] && [ -n "$(ls -A "${RUN_DIR}" 2>/dev/null || true)" ]; then
  echo "evidence directory already exists and is not empty: ${REL_RUN_DIR}" >&2
  exit 2
fi
mkdir -p "${RUN_DIR}"

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    \033[33m%s\033[0m\n' "$*"; }

PRESERVED_FILE="${RUN_DIR}/preserved.ndjson"
: > "${PRESERVED_FILE}"

# Written incrementally as objects are created, so a fault at any step still
# leaves a complete inventory. A single string cleared on the success branch
# cannot describe a multi-family partial failure.
preserve() { # preserve <kind> <name> <cleanup-cmd> <reason>
  jq -nc --arg kind "$1" --arg name "$2" --arg cmd "$3" --arg reason "$4" \
    '{kind:$kind, name:$name, cleanup_cmd:$cmd, reason:$reason}' >> "${PRESERVED_FILE}"
}
unpreserve() { # unpreserve <name>
  local tmp="${PRESERVED_FILE}.tmp"
  jq -c --arg name "$1" 'select(.name != $name)' "${PRESERVED_FILE}" > "${tmp}" 2>/dev/null || : > "${tmp}"
  mv "${tmp}" "${PRESERVED_FILE}"
}

print_preserved() {
  [ -s "${PRESERVED_FILE}" ] || return 0
  printf '\n    Preserved state (trust-auth clusters with no password — remove them):\n' >&2
  jq -r '"      " + .kind + "  " + .name + "    # " + .reason' "${PRESERVED_FILE}" >&2
  printf '\n    Remove everything from this run, in dependency order:\n      %s\n' \
    "$(jq -rs '[ (map(select(.kind=="container")) | .[].cleanup_cmd),
                (map(select(.kind=="network"))   | .[].cleanup_cmd),
                (map(select(.kind=="volume"))    | .[].cleanup_cmd) ] | join(" ; ")' \
        "${PRESERVED_FILE}")" >&2
}

finish_fault() {
  printf '\n\033[1;31mHARNESS FAULT: %s\033[0m\n' "$1" >&2
  jq -n --arg step "$1" --arg run_id "${RUN_ID}" --arg spike "${SPIKE}" \
    '{schema:"agent-runtime/spike-evidence/2", spike:$spike, run_id:$run_id,
      outcome:{status:"fault", fault:{kind:"harness", step:$step}}}' \
    > "${RUN_DIR}/evidence.json" 2>/dev/null || true
  print_preserved
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
preserve image "${IMAGE}" "docker image rm ${IMAGE}" "built for this run"
info "runtime image  ${IMAGE_ID}"
info "database image ${PG_IMAGE_ID}"

# The matrix and the manifest come from the IMAGE, not from the host working
# tree: everything else here is sourced from the pinned build, and a host-side
# edit must not be able to misdescribe what actually ran.
timeout 60 docker run --rm --network none "${IMAGE_ID}" cases > "${RUN_DIR}/cases.json" \
  || finish_fault "could not read the case matrix from the image"
timeout 60 docker run --rm --network none "${IMAGE_ID}" manifest > "${RUN_DIR}/manifest.json" \
  || finish_fault "could not read the fixture manifest from the image"
timeout 60 docker run --rm --network none "${IMAGE_ID}" families > "${RUN_DIR}/families.json" \
  || finish_fault "could not read the family registry from the image"

# ---------------------------------------------------------------------------
# Selection. The three selectors intersect; each one matching nothing is a usage
# error rather than an empty run, because "you typed the wrong family letter"
# deserves a more helpful answer than a green board over zero cases.
SELECTED="$(jq -r '.[].id' "${RUN_DIR}/cases.json")"
SUBSET=false
SUBSET_REASONS=()

if [ -n "${FAMILY}" ]; then
  SELECTED="$(jq -r --arg f "${FAMILY}" '.[] | select(.family | inside($f)) | .id' "${RUN_DIR}/cases.json")"
  [ -n "${SELECTED}" ] || { echo "--family matched no case: ${FAMILY}" >&2; exit 2; }
  SUBSET=true; SUBSET_REASONS+=("family=${FAMILY}")
fi
if [ -n "${LANE}" ]; then
  SELECTED="$(jq -r --arg l "${LANE}" --argjson ids "$(printf '%s\n' "${SELECTED}" | jq -R -s -c 'split("\n")|map(select(length>0))')" \
    '.[] | select(.lane == $l) | select(.id as $i | $ids | index($i)) | .id' "${RUN_DIR}/cases.json")"
  [ -n "${SELECTED}" ] || { echo "--lane matched no selected case: ${LANE}" >&2; exit 2; }
  SUBSET=true; SUBSET_REASONS+=("lane=${LANE}")
fi
if [ -n "${ONLY}" ]; then
  SELECTED="$(printf '%s\n' "${SELECTED}" | grep -Ex "${ONLY}" || true)"
  [ -n "${SELECTED}" ] || { echo "--only matched no selected case: ${ONLY}" >&2; exit 2; }
  SUBSET=true; SUBSET_REASONS+=("only=${ONLY}")
fi

# Pair expansion and `requires` closure run AFTER intersection, inside the image,
# so a mitigation can never run without the stock case it is paired with.
EXPANDED="$(timeout 60 docker run --rm --network none "${IMAGE_ID}" expand \
  --ids "$(printf '%s' "${SELECTED}" | tr '\n' ',' | sed 's/,$//')")" \
  || finish_fault "selection closure failed"
CASE_IDS="$(jq -r '.ids[]' <<< "${EXPANDED}")"
ADDED="$(jq -r '.added | join(", ")' <<< "${EXPANDED}")"
[ -z "${ADDED}" ] || info "closure added: ${ADDED}"

if [ "${REPEATS}" -lt 3 ]; then
  SUBSET=true; SUBSET_REASONS+=("repeats=${REPEATS}")
fi
if [ "${SUBSET}" = "true" ]; then
  warn "NON-FINAL run (${SUBSET_REASONS[*]}); this is a measurement, not a spike result"
fi

CASE_COUNT="$(printf '%s\n' "${CASE_IDS}" | grep -c . || true)"
FAMILY_IDS="$(jq -r --argjson ids "$(printf '%s\n' "${CASE_IDS}" | jq -R -s -c 'split("\n")|map(select(length>0))')" \
  '[ .[] | select(.id as $i | $ids | index($i)) | .family ] | unique | .[]' "${RUN_DIR}/cases.json")"
# Family G replaces the stack it measures, so it runs last within a repeat.
FAMILY_IDS="$(printf '%s\n' ${FAMILY_IDS} | jq -R -s -c 'split("\n")|map(select(length>0))' \
  | jq -r --slurpfile fam "${RUN_DIR}/families.json" \
      '. as $sel | ($fam[0].families | map(select(.id as $i | $sel | index($i)))
        | sort_by(if .ownsDatabaseLifecycle then 1 else 0 end) | .[].id)')"
info "cases     ${CASE_COUNT} selected across families: $(printf '%s' "${FAMILY_IDS}" | tr '\n' ' ')"

# ---------------------------------------------------------------------------
PROJ=""; NET=""; REPDIR=""; FAM=""; VOL=""; PGC=""; PGALIAS=""
# One database per case. `CREATE EXTENSION` is database-scoped and several cases
# must begin from a genuinely cold cluster, so a schema per case is not enough.
CASE_DB="spike"

worker_flags() {
  printf '%s' \
    "--network ${NET} --read-only --tmpfs /tmp --cap-drop ALL " \
    "--security-opt no-new-privileges --memory 512m --pids-limit 256 --restart=no " \
    "-e PGHOST=${PGALIAS} -e PGPORT=5432 -e PGUSER=spike -e PGDATABASE=${CASE_DB} -e TZ=UTC"
}

# Persist only the inspect fields the evidence is allowed to make claims about.
# The raw document carries the daemon's storage root and the host PID, neither of
# which any criterion reads and both of which are host detail.
inspect_posture() {
  docker inspect "$1" --format '{{json .}}' | jq '{
    status:    .State.Status,
    exitCode:  .State.ExitCode,
    oomKilled: .State.OOMKilled,
    image:     .Image,
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
run_tool() { # run_tool <outfile> <errfile> <timeout-seconds> <args...>
  local out="$1" err="$2" secs="$3"; shift 3
  local name="${PROJ}-t-$(printf '%s' "$*" | tr -cd '[:alnum:]' | tail -c 20)-${RANDOM}"
  local code=0
  # Named, and NOT --rm: `timeout` signals the docker CLI, and a container that
  # ignores SIGTERM would otherwise survive unnamed, keep a Postgres connection,
  # and block the network teardown.
  timeout "${secs}" docker run --name "${name}" $(worker_flags) "${IMAGE_ID}" "$@" \
    > "${out}" 2> "${err}" || code=$?
  docker rm -f "${name}" > /dev/null 2>&1 || true
  # A container that exits 0 having printed nothing is a fault, not a pass: Node
  # exits cleanly when the event loop empties while a promise is still pending.
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
  local cd="${REPDIR}/${FAM}/${case_id}"
  mkdir -p "${cd}"

  local def parties launch stages budget secs needs_prepare kill_party kill_gate kill_signal
  local restart_after restart_action restart_gate restart_gate_party
  def="$(jq -c --arg id "${case_id}" '.[] | select(.id == $id)' "${RUN_DIR}/cases.json")"
  parties="$(jq -r '.parties' <<< "${def}")"
  launch="$(jq -r '.launch' <<< "${def}")"
  stages="$(jq -r '.stages | length' <<< "${def}")"
  budget="$(jq -r '.budgetMs' <<< "${def}")"
  needs_prepare="$(jq -r '.prepare' <<< "${def}")"
  kill_party="$(jq -r '.kill.party // ""' <<< "${def}")"
  kill_gate="$(jq -r '.kill.gate // ""' <<< "${def}")"
  kill_signal="$(jq -r '.kill.signal // ""' <<< "${def}")"
  restart_after="$(jq -r '.restart.afterParty // ""' <<< "${def}")"
  restart_action="$(jq -r '.restart.action // ""' <<< "${def}")"
  restart_gate="$(jq -r '.restart.atGate.gate // ""' <<< "${def}")"
  restart_gate_party="$(jq -r '.restart.atGate.party // ""' <<< "${def}")"
  secs=$(( (budget + 999) / 1000 ))

  CASE_DB="$(jq -r --arg id "${case_id}" '.databases[$id]' "${REPDIR}/${FAM}/provision.json")"
  [ -n "${CASE_DB}" ] && [ "${CASE_DB}" != "null" ] \
    || finish_fault "case ${case_id}: provisioning created no database"

  local code prepare_json="null" kill_json="null" drain_json="null" after_kill_json="null"
  local restart_json="null"

  if [ "${needs_prepare}" = "true" ]; then
    code="$(run_tool "${cd}/prepare.json" "${cd}/prepare.err" 120 prepare --case "${case_id}")"
    [ "${code}" = "0" ] || finish_fault "case ${case_id}: prepare exited ${code}"
    prepare_json="$(cat "${cd}/prepare.json")"
  fi

  local coord_name="" coord_json="null"
  if [ "${stages}" -gt 0 ]; then
    coord_name="${PROJ}-c-${case_id}"
    docker run -d --name "${coord_name}" $(worker_flags) \
      "${IMAGE_ID}" coordinate --case "${case_id}" > /dev/null \
      || finish_fault "case ${case_id}: could not start the coordinator"
  fi

  local party names=()
  for party in $(seq 0 $(( parties - 1 ))); do
    local wname="${PROJ}-w-${case_id}-p${party}" wid
    wid="$(docker run -d --name "${wname}" $(worker_flags) \
             "${IMAGE_ID}" run --case "${case_id}" --party "${party}")" \
      || finish_fault "case ${case_id}: could not start party ${party}"
    [ "$(docker inspect --format '{{.Image}}' "${wid}")" = "${IMAGE_ID}" ] \
      || finish_fault "case ${case_id}: party ${party} ran a different image"
    names+=("${wname}")

    # The database stack is acted on while this party is STILL RUNNING, once it
    # has parked on a durable row. Anchored on the park, never on a sleep — same
    # contract as a worker kill, and the reason "the server died under a live
    # caller" is measurable rather than asserted.
    if [ -n "${restart_gate}" ] && [ "${restart_gate_party}" = "${party}" ]; then
      code="$(run_tool "${cd}/awaitpark.json" "${cd}/awaitpark.err" 120 \
                awaitpark --case "${case_id}" --party "${party}" --gate "${restart_gate}")"
      if [ "${code}" != "0" ]; then
        docker logs "${wname}" > "${cd}/p${party}.err" 2>&1 || true
        finish_fault "case ${case_id}: party ${party} never parked at ${restart_gate} (exit ${code})"
      fi
      apply_stack_action "${cd}" "${case_id}" "${restart_action}"
      restart_json="$(cat "${cd}/restart.json")"
    fi

    if [ "${kill_party}" = "${party}" ]; then
      # Anchored to an observed durable park row, never to a sleep.
      code="$(run_tool "${cd}/awaitpark.json" "${cd}/awaitpark.err" 120 \
                awaitpark --case "${case_id}" --party "${party}" --gate "${kill_gate}")"
      if [ "${code}" != "0" ]; then
        docker logs "${wname}" > "${cd}/p${party}.err" 2>&1 || true
        finish_fault "case ${case_id}: party ${party} never parked at ${kill_gate} (exit ${code})"
      fi
      inspect_posture "${wname}" > "${cd}/p${party}-prekill.json"
      docker kill --signal="${kill_signal}" "${wname}" > /dev/null \
        || finish_fault "case ${case_id}: docker kill failed"
      local wait_exit
      wait_exit="$(timeout 30 docker wait "${wname}")" \
        || finish_fault "case ${case_id}: party ${party} never terminated after ${kill_signal}"
      kill_json="$(jq -n --argjson party "${party}" --arg signal "${kill_signal}" \
        --argjson waitExit "${wait_exit}" \
        --argjson oomKilled "$(jq -r '.oomKilled' "${cd}/p${party}-prekill.json")" \
        '{party:$party, signal:$signal, waitExit:$waitExit, oomKilled:$oomKilled}')"

      # A SIGKILL leaves no FIN, so the dead process's backend can outlive its
      # container and still hold locks. Projecting before it drains reads a lie.
      code="$(run_tool "${cd}/drain.json" "${cd}/drain.err" 60 \
                drain --case "${case_id}" --app-prefix "${case_id}:p${party}")"
      [ "${code}" = "0" ] || finish_fault "case ${case_id}: drain check exited ${code}"
      drain_json="$(cat "${cd}/drain.json")"

      code="$(run_tool "${cd}/after-kill.json" "${cd}/after-kill.err" 120 \
                project --case "${case_id}")"
      [ "${code}" = "0" ] || finish_fault "case ${case_id}: post-kill projection exited ${code}"
      after_kill_json="$(cat "${cd}/after-kill.json")"
    elif [ "${launch}" = "sequential" ]; then
      timeout "${secs}" docker wait "${wname}" > /dev/null \
        || finish_fault "case ${case_id}: party ${party} never terminated"
    fi

    # The database stack is acted on BETWEEN parties, so the next party is a
    # genuinely fresh runtime container talking to a genuinely restarted (or
    # replaced) server. Doing it inside a party would leave the worker holding
    # pooled connections to a server that no longer exists, which measures pg's
    # reconnect behaviour rather than the architecture's restart question.
    if [ -n "${restart_action}" ] && [ -n "${restart_after}" ] && [ "${restart_after}" = "${party}" ]; then
      apply_stack_action "${cd}" "${case_id}" "${restart_action}"
      restart_json="$(cat "${cd}/restart.json")"
    fi
  done

  local workers="[]" wname exit_code
  for party in $(seq 0 $(( parties - 1 ))); do
    wname="${names[${party}]}"
    exit_code="$(timeout "${secs}" docker wait "${wname}")" \
      || finish_fault "case ${case_id}: party ${party} never terminated"
    inspect_posture "${wname}" > "${cd}/p${party}-inspect.json"
    docker logs "${wname}" > "${cd}/p${party}.json" 2> "${cd}/p${party}.err" || true
    docker rm -f "${wname}" > /dev/null 2>&1 || true

    local output="null"
    if [ -s "${cd}/p${party}.json" ] && jq -e '.' "${cd}/p${party}.json" > /dev/null 2>&1; then
      output="$(cat "${cd}/p${party}.json")"
    fi
    workers="$(jq -c --argjson workers "${workers}" \
      --argjson party "${party}" \
      --arg container "$(printf '%s' "${wname}" | tail -c 24)" \
      --argjson exit "${exit_code}" \
      --argjson posture "$(jq '.posture' "${cd}/p${party}-inspect.json")" \
      --argjson output "${output}" \
      -n '$workers + [{party:$party, container:$container, exitCode:$exit,
                       posture:$posture, output:$output}]')"
  done

  if [ -n "${coord_name}" ]; then
    exit_code="$(timeout "${secs}" docker wait "${coord_name}")" \
      || finish_fault "case ${case_id}: the coordinator never terminated"
    docker logs "${coord_name}" > "${cd}/coordinate.json" 2> "${cd}/coordinate.err" || true
    docker rm -f "${coord_name}" > /dev/null 2>&1 || true
    jq -e '.' "${cd}/coordinate.json" > /dev/null 2>&1 \
      || finish_fault "case ${case_id}: the coordinator produced no valid JSON"
    [ "${exit_code}" = "0" ] \
      || finish_fault "case ${case_id}: the coordinator exited ${exit_code} (rendezvous unproven)"
    coord_json="$(cat "${cd}/coordinate.json")"
  fi

  # The terminal schema is projected independently, after every party has exited
  # and any killed backend has drained. An error-free caller set is not evidence
  # that the schema converged, and a loud SQLSTATE is not evidence that it did not.
  code="$(run_tool "${cd}/projection.json" "${cd}/projection.err" 120 project --case "${case_id}")"
  [ "${code}" = "0" ] || finish_fault "case ${case_id}: terminal projection exited ${code}"

  jq -n \
    --arg case "${case_id}" \
    --arg family "${FAM}" \
    --arg lane "$(jq -r '.lane' <<< "${def}")" \
    --argjson coordination "${coord_json}" \
    --argjson workers "${workers}" \
    --argjson prepare "${prepare_json}" \
    --argjson kill "${kill_json}" \
    --argjson drain "${drain_json}" \
    --argjson afterKill "${after_kill_json}" \
    --argjson restart "${restart_json}" \
    --slurpfile provision "${REPDIR}/${FAM}/provision.json" \
    --slurpfile projection "${cd}/projection.json" \
    '{case:$case, family:$family, lane:$lane, coordination:$coordination,
      workers:$workers, provision:$provision[0], projection:$projection[0],
      prepare:$prepare, kill:$kill, drain:$drain, projectionAfterKill:$afterKill,
      restart:$restart}' \
    > "${cd}/case.json"
}

# Extracted so family G can recreate the database container mid-case from the
# SAME immutable image id, which is what "the stack was replaced" has to mean if
# the evidence is going to distinguish it from "the container never went away".
#
# Stock entrypoint and a lesser hardening posture than the workers get: the
# official image starts as root to fix PGDATA ownership before dropping
# privileges. The evidence scopes its posture claims to the workers for exactly
# this reason.
create_pg_container() { # create_pg_container <volume>
  docker run -d --name "${PGC}" \
    --network "${NET}" --network-alias "${PGALIAS}" \
    --restart=no \
    -e POSTGRES_USER=spike -e POSTGRES_DB=spike \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -e PGDATA=/var/lib/postgresql/data/pgdata -e TZ=UTC \
    -v "$1:/var/lib/postgresql/data" \
    --health-cmd 'pg_isready -h 127.0.0.1 -U spike -d spike' \
    --health-interval 2s --health-timeout 3s --health-retries 40 --health-start-period 3s \
    "${PG_IMAGE_ID}" > /dev/null

  wait_healthy || finish_fault "family ${FAM}: postgres never became healthy"
}

# How many lines the database has logged so far.
#
# The container is per FAMILY, not per case, so its log accumulates across every
# case that restarts it. Recovery evidence is therefore read from the DELTA
# either side of one action, never from the whole log.
pg_log_lines() {
  docker logs "${PGC}" 2>&1 | wc -l | tr -d ' '
}

# Marker counts over the new lines only. Counts, never raw log text: the
# markers are constants this harness put in the evidence, so nothing the server
# printed - paths, roles, connection strings - can ride along into it.
pg_log_markers() { # pg_log_markers <from-line>
  local from="$1" new
  new="$(docker logs "${PGC}" 2>&1 | tail -n +"$(( from + 1 ))")"
  jq -nc \
    --argjson newLines "$(printf '%s\n' "${new}" | grep -c . || true)" \
    --argjson notCleanShutdown "$(printf '%s\n' "${new}" | grep -ci 'was not properly shut down' || true)" \
    --argjson automaticRecovery "$(printf '%s\n' "${new}" | grep -ci 'automatic recovery in progress' || true)" \
    --argjson redoStarts "$(printf '%s\n' "${new}" | grep -ci 'redo starts at' || true)" \
    --argjson readyForConnections "$(printf '%s\n' "${new}" | grep -ci 'database system is ready to accept connections' || true)" \
    --argjson shutdownComplete "$(printf '%s\n' "${new}" | grep -ci 'database system is shut down' || true)" \
    '{newLines:$newLines, notCleanShutdown:$notCleanShutdown,
      automaticRecovery:$automaticRecovery, redoStarts:$redoStarts,
      readyForConnections:$readyForConnections, shutdownComplete:$shutdownComplete}'
}

# The database-stack action a family G case declares, applied between two
# parties. Everything it records is either a container id, an image id, a volume
# NAME, or a count - never a mountpoint, which would be a host path.
apply_stack_action() { # apply_stack_action <case-dir> <case-id> <action>
  local cd="$1" case_id="$2" action="$3"
  local before_lines old_container old_image old_volume new_volume markers code
  # An action that REPLACES the container also replaces its log, so a line
  # offset taken from the old one would silently skip past the start of the new
  # one - which is where all the recovery evidence lives. g04 read zero new
  # lines that way, from a log that had plenty.
  case "${action}" in
    replace-stack|fresh-volume) before_lines=0 ;;
    *)                          before_lines="$(pg_log_lines)" ;;
  esac
  old_container="$(docker inspect -f '{{.Id}}' "${PGC}")"
  old_image="$(docker inspect -f '{{.Image}}' "${PGC}")"
  old_volume="${VOL}"
  new_volume="${VOL}"

  case "${action}" in
    graceful-restart)
      docker restart "${PGC}" > /dev/null || finish_fault "case ${case_id}: graceful restart failed"
      wait_healthy || finish_fault "case ${case_id}: postgres never became healthy after restart"
      ;;
    unclean-kill)
      docker kill --signal=SIGKILL "${PGC}" > /dev/null \
        || finish_fault "case ${case_id}: SIGKILL of postgres failed"
      docker start "${PGC}" > /dev/null || finish_fault "case ${case_id}: postgres would not start"
      wait_healthy || finish_fault "case ${case_id}: postgres never recovered after SIGKILL"
      ;;
    replace-stack)
      docker rm -f "${PGC}" > /dev/null 2>&1 || true
      create_pg_container "${VOL}"
      ;;
    fresh-volume)
      new_volume="${VOL}-fresh-$(printf '%s' "${case_id}" | tr -cd '[:alnum:]' | tail -c 8)"
      docker volume inspect "${new_volume}" > /dev/null 2>&1 \
        && finish_fault "case ${case_id}: volume ${new_volume} already exists"
      docker volume create "${new_volume}" > /dev/null
      REPEAT_VOLUMES+=("${new_volume}")
      preserve volume "${new_volume}" "docker volume rm ${new_volume}" "family ${FAM} fresh-volume control"
      docker rm -f "${PGC}" > /dev/null 2>&1 || true
      VOL="${new_volume}"
      create_pg_container "${VOL}"
      # Re-provisioned so the SCHEMA exists but holds no rows. That is the
      # negative control worth running: not "the database is missing", which any
      # connection error would reveal, but "the schema is there and the state is
      # not".
      #
      # CASE_DB has to fall back to the admin database first: it currently names
      # the per-case database, and on a fresh volume that database does not exist
      # yet - which is precisely what this step is here to create.
      local saved_case_db="${CASE_DB}"
      CASE_DB="spike"
      code="$(run_tool "${cd}/reprovision.json" "${cd}/reprovision.err" 300 \
                provision --family "${FAM}" --cases "${case_id}")"
      CASE_DB="${saved_case_db}"
      [ "${code}" = "0" ] || finish_fault "case ${case_id}: reprovision exited ${code}"
      ;;
    *)
      finish_fault "case ${case_id}: unknown stack action ${action}"
      ;;
  esac

  markers="$(pg_log_markers "${before_lines}")"
  jq -n \
    --arg action "${action}" \
    --arg oldContainer "$(printf '%s' "${old_container}" | tail -c 12)" \
    --arg newContainer "$(docker inspect -f '{{.Id}}' "${PGC}" | tail -c 12)" \
    --argjson sameContainer "$([ "${old_container}" = "$(docker inspect -f '{{.Id}}' "${PGC}")" ] && echo true || echo false)" \
    --argjson sameImage "$([ "${old_image}" = "$(docker inspect -f '{{.Image}}' "${PGC}")" ] && echo true || echo false)" \
    --argjson pinnedImage "$([ "$(docker inspect -f '{{.Image}}' "${PGC}")" = "${PG_IMAGE_ID}" ] && echo true || echo false)" \
    --argjson sameVolume "$([ "${old_volume}" = "${new_volume}" ] && echo true || echo false)" \
    --argjson log "${markers}" \
    '{action:$action, oldContainer:$oldContainer, newContainer:$newContainer,
      sameContainer:$sameContainer, sameImage:$sameImage, pinnedImage:$pinnedImage,
      sameVolume:$sameVolume, log:$log}' > "${cd}/restart.json"
}

start_family_database() {
  VOL="${PROJ}-${FAM}-pgdata"
  PGC="${PROJ}-${FAM}-pg"
  PGALIAS="pg-${FAM}"

  docker volume inspect "${VOL}" > /dev/null 2>&1 && finish_fault "volume ${VOL} already exists"
  docker volume create "${VOL}" > /dev/null
  REPEAT_VOLUMES+=("${VOL}")
  preserve volume "${VOL}" "docker volume rm ${VOL}" "family ${FAM} database (trust auth)"
  preserve container "${PGC}" "docker rm -f ${PGC}" "family ${FAM} database"

  create_pg_container "${VOL}"

  # The health probe can pass against initdb's temporary bootstrap server, so
  # readiness is gated a second time on a real query from a real client.
  local code family_cases
  family_cases="$(jq -r --arg f "${FAM}" \
    --argjson ids "$(printf '%s\n' "${CASE_IDS}" | jq -R -s -c 'split("\n")|map(select(length>0))')" \
    '[ .[] | select(.family == $f) | select(.id as $i | $ids | index($i)) | .id ] | join(",")' \
    "${RUN_DIR}/cases.json")"
  CASE_DB="spike"
  code="$(run_tool "${REPDIR}/${FAM}/provision.json" "${REPDIR}/${FAM}/provision.err" 300 \
            provision --family "${FAM}" --cases "${family_cases}")"
  [ "${code}" = "0" ] || finish_fault "family ${FAM}: provision exited ${code}"
}

# The container goes as soon as its family is done; the VOLUME does not. Whether
# the family's evidence is trustworthy is not known until summarize has run at
# the end of the repeat, and a volume discarded before then cannot be inspected.
stop_family_database() {
  docker rm -f "${PGC}" > /dev/null 2>&1 || true
  unpreserve "${PGC}"
}

# shellcheck disable=SC2086
run_repeat() {
  local repeat="$1"
  PROJ="pgcc-${SUFFIX}-r${repeat}"
  NET="${PROJ}-net"
  REPDIR="${RUN_DIR}/repeat-${repeat}"
  REPEAT_VOLUMES=()
  mkdir -p "${REPDIR}"

  log "Repeat ${repeat} of ${REPEATS}"

  docker network inspect "${NET}" > /dev/null 2>&1 && finish_fault "network ${NET} already exists"
  [ -z "$(docker ps -aq --filter "name=^${PROJ}-")" ] || finish_fault "containers named ${PROJ}-* already exist"
  docker network create --internal "${NET}" > /dev/null
  preserve network "${NET}" "docker network rm ${NET}" "repeat ${repeat}"

  local family case_id family_ok
  while read -r family; do
    [ -n "${family}" ] || continue
    FAM="${family}"
    mkdir -p "${REPDIR}/${FAM}"
    start_family_database
    info "family ${FAM}  postgres $(jq -r '.cluster.serverVersionNum' "${REPDIR}/${FAM}/provision.json")"

    family_ok=1
    while read -r case_id; do
      [ -n "${case_id}" ] || continue
      [ "$(jq -r --arg id "${case_id}" '.[] | select(.id==$id) | .family' "${RUN_DIR}/cases.json")" = "${FAM}" ] || continue
      printf '    case %-32s' "${case_id}"
      run_case "${case_id}"
      printf 'ok\n'
    done <<< "${CASE_IDS}"

    [ "${family_ok}" -eq 1 ] && stop_family_database
  done <<< "${FAMILY_IDS}"

  # Built from the selected case list, never from a directory glob: a stale case
  # directory must not be able to join this run's bundle set.
  local bundle_files=()
  while read -r case_id; do
    [ -n "${case_id}" ] || continue
    family="$(jq -r --arg id "${case_id}" '.[] | select(.id==$id) | .family' "${RUN_DIR}/cases.json")"
    bundle_files+=("${REPDIR}/${family}/${case_id}/case.json")
  done <<< "${CASE_IDS}"
  jq -s '.' "${bundle_files[@]}" > "${REPDIR}/bundles.json"

  local code=0
  timeout 180 docker run --rm -i --network none "${IMAGE_ID}" summarize \
    < "${REPDIR}/bundles.json" > "${REPDIR}/run.json" 2> "${REPDIR}/run.err" || code=$?
  if [ ! -s "${REPDIR}/run.json" ] || ! jq -e '.' "${REPDIR}/run.json" > /dev/null 2>&1; then
    finish_fault "repeat ${repeat}: summarize produced no valid JSON"
  fi
  [ "${code}" -eq 3 ] && finish_fault "repeat ${repeat}: summarize reported a harness fault"
  [ "${code}" -eq 4 ] && { chmod -R go-rwx "${RUN_DIR}" || true; exit 4; }

  jq -r '.managed_digests.overall'  "${REPDIR}/run.json" > "${RUN_DIR}/digest-${repeat}-overall.txt"
  jq -S '.managed_digests.per_lane' "${REPDIR}/run.json" > "${RUN_DIR}/digest-${repeat}-lanes.json"
  jq -S '.acceptance.flat'          "${REPDIR}/run.json" > "${RUN_DIR}/acceptance-${repeat}.json"
  info "outcome   $(jq -r '.outcome.status' "${REPDIR}/run.json") (exit ${code})"

  if [ "${code}" -eq 0 ]; then
    docker ps -aq --filter "name=^${PROJ}-" | while read -r cid; do
      [ -n "${cid}" ] && docker rm -f "${cid}" > /dev/null 2>&1 || true
    done
    docker network rm "${NET}" > /dev/null 2>&1 || true
    unpreserve "${NET}"
    # Trust-auth clusters accumulate at three repeats times N families, so a
    # repeat whose evidence held releases its own volumes. A failing repeat keeps
    # everything, including the network, because a volume with no network left is
    # not inspectable without recreating one.
    local vol
    for vol in "${REPEAT_VOLUMES[@]:-}"; do
      [ -n "${vol}" ] || continue
      docker volume rm "${vol}" > /dev/null 2>&1 || true
      unpreserve "${vol}"
    done
  else
    warn "repeat ${repeat} did not pass; its containers, network and volumes are preserved"
  fi
}

for repeat in $(seq 1 "${REPEATS}"); do
  run_repeat "${repeat}"
done

# ---------------------------------------------------------------------------
log "Comparing managed state across repeats"

# Every case the run SELECTED produced a bundle in every repeat. The summarizer
# can only check the converse (each bundle maps to a known case); coverage is a
# property of the run, so the driver owns it.
ALL_SELECTED_PRESENT=true
for repeat in $(seq 1 "${REPEATS}"); do
  for case_id in ${CASE_IDS}; do
    [ -s "${RUN_DIR}/repeat-${repeat}/"*"/${case_id}/case.json" ] 2>/dev/null \
      || ALL_SELECTED_PRESENT=false
  done
done

DIGEST_FILES=(); ACCEPT_FILES=()
for repeat in $(seq 1 "${REPEATS}"); do
  DIGEST_FILES+=("${RUN_DIR}/digest-${repeat}-overall.txt")
  ACCEPT_FILES+=("${RUN_DIR}/acceptance-${repeat}.json")
done
UNIQUE_DIGESTS="$(cat "${DIGEST_FILES[@]}" | sort -u | wc -l | tr -d ' ')"

# The reported acceptance is the elementwise AND across every repeat, not
# repeat 1's map. Taking the first repeat's would let a criterion that failed in
# repeat 2 be laundered by repeat 1 passing — which is exactly what running the
# thing three times is supposed to prevent.
jq -s 'reduce .[] as $repeat ({};
         reduce ($repeat | to_entries[]) as $entry (.;
           .[$entry.key] = (((.[$entry.key] // true) and $entry.value))))' \
  "${ACCEPT_FILES[@]}" > "${RUN_DIR}/acceptance-all.json"

# The per-LANE maps get the same treatment. Only `.flat` was ANDed before, so a
# reader citing `acceptance.lanes` could read a repeat-1 `true` for a criterion
# that failed in another repeat — laundering by a narrower door.
LANE_FILES=()
for repeat in $(seq 1 "${REPEATS}"); do
  LANE_FILES+=("${RUN_DIR}/repeat-${repeat}/lanes.json")
  jq -c '.acceptance.lanes' "${RUN_DIR}/repeat-${repeat}/run.json" \
    > "${RUN_DIR}/repeat-${repeat}/lanes.json"
done
jq -s 'reduce .[] as $repeat ({};
         reduce ($repeat | to_entries[]) as $lane (.;
           .[$lane.key] = (reduce ($lane.value | to_entries[]) as $entry ((.[$lane.key] // {});
             .[$entry.key] = (((.[$entry.key] // true) and $entry.value))))))' \
  "${LANE_FILES[@]}" > "${RUN_DIR}/acceptance-lanes-all.json"
REPEATS_FAILED="$(jq -rs '[.[] | to_entries[] | select(.value == false)] | length' "${ACCEPT_FILES[@]}")"
[ "${REPEATS_FAILED}" -eq 0 ] || warn "${REPEATS_FAILED} criterion failure(s) across individual repeats"

# Reproducibility and stability are cross-repeat facts. With one repeat there is
# nothing to compare, and reporting `true` from a single sample would be a claim
# the run did not earn — so the criteria are OMITTED rather than set false.
REPRODUCIBLE=false
ACCEPTANCE_STABLE=false
HAVE_CROSS_REPEAT=false
if [ "${REPEATS}" -ge 2 ]; then
  HAVE_CROSS_REPEAT=true
  [ "${UNIQUE_DIGESTS}" -eq 1 ] && REPRODUCIBLE=true
  ACCEPTANCE_STABLE=true
  for repeat in $(seq 2 "${REPEATS}"); do
    cmp -s "${RUN_DIR}/acceptance-1.json" "${RUN_DIR}/acceptance-${repeat}.json" \
      || ACCEPTANCE_STABLE=false
  done
  if [ "${REPRODUCIBLE}" != "true" ]; then
    # Labelled, because `diff -u` writes the absolute paths of its operands into
    # the header, which puts the operator's home directory into an artefact the
    # sanitizer then correctly quarantines the whole run over.
    diff -u --label repeat-1/run.json --label repeat-2/run.json \
      "${RUN_DIR}/repeat-1/run.json" "${RUN_DIR}/repeat-2/run.json" \
      > "${RUN_DIR}/repeat.diff" || true
  fi
else
  warn "only one repeat: reproducibility and stability cannot be claimed"
fi
info "distinct overall digests: ${UNIQUE_DIGESTS} (reproducible: ${REPRODUCIBLE})"

# ---------------------------------------------------------------------------
log "Composing the evidence summary"

jq -s '.' "${PRESERVED_FILE}" > "${RUN_DIR}/preserved.json"
jq -s '[.[].posture] | unique' "${RUN_DIR}"/repeat-*/*/*/p*-inspect.json \
  > "${RUN_DIR}/postures.json"
cat "${DIGEST_FILES[@]}" | jq -R -s -c 'split("\n") | map(select(length > 0))' \
  > "${RUN_DIR}/digests.json"
printf '%s\n' "${SUBSET_REASONS[@]:-}" | jq -R -s -c 'split("\n") | map(select(length > 0))' \
  > "${RUN_DIR}/subset-reasons.json"

# The observed outcome sets for every bounded-trials case.
#
# `managed` replaces a raced case's results with the literal string
# "<race outcome: see findings>" so a genuine race cannot be reported as a
# reproducibility failure — but `findings` lived only in each repeat's run.json,
# which is not the citable artefact, so the promoted evidence pointed readers at
# a section it did not contain.
#
# The REDUCTION now happens inside the pinned image (`observationFor`), beside
# the criteria it has to stay honest against. The first version was authored
# here in jq, which made it the one analysis in the run whose code was not
# version-locked to the evidence it described — and it answered three of the
# eight elided fields while a count-and-pointer global reported it complete. Six
# of seventeen bounded cases consequently read as "no variation" in a file whose
# raw bundles showed them flipping.
#
# What is left here is grouping and counting: identical observations across
# repeats collapse into one entry with an occurrence count.
#
# Excluded from every digest by construction: it is assembled here, after the
# per-lane and overall digests have been computed from `managed`.
jq -s '
  [ .[].observations[] ]
  | group_by(.case)
  | map({
      case: .[0].case,
      lane: .[0].lane,
      covers: .[0].covers,
      samples: length,
      outcomes: ( group_by(.observation | tojson)
                  | map({ occurrences: length, outcome: .[0].observation })
                  | sort_by(.outcome | tojson) )
    })
  | sort_by(.case)
' "${RUN_DIR}"/repeat-*/run.json > "${RUN_DIR}/observed.json"
info "bounded-trial cases with a persisted outcome set: $(jq -r 'length' "${RUN_DIR}/observed.json")"

# Every bounded case must appear, and must contribute exactly one sample per
# isolated repeat. `trials` is fixed at 1 in the registry because nothing loops
# the participant body, so "observed over N trials" can only ever mean N repeats
# — and this is what stops the report implying a trial count the harness does
# not perform.
#
# A selection containing no bounded case makes this vacuously true, which is
# correct: `--family F` has none, and requiring a non-empty set there would fail
# a run for the shape of its selection rather than for its evidence. The full
# matrix has seventeen by construction, and a mismatch there is caught both by
# the count and by the dangling-pointer check below.
BOUNDED_EXPECTED="$(jq -r '
  [ .managed | to_entries | map(.value[])[]
    | select(.classification == "bounded-trials") | .case ] | unique | length
' "${RUN_DIR}/repeat-1/run.json")"
BOUNDED_OK="$(jq -s -r --argjson repeats "${REPEATS}" --argjson expected "${BOUNDED_EXPECTED}" '
  (.[1] // []) as $observed
  | (($observed | length) == $expected
     and ($observed | all(.samples == $repeats
                          and ([.outcomes[].occurrences] | add) == $repeats)))
  | tostring
' "${RUN_DIR}/repeat-1/run.json" "${RUN_DIR}/observed.json")"

# No dangling pointer, checked at FIELD granularity rather than by case id.
#
# The previous version compared case ids, which is one level too coarse to catch
# the defect it was written for: a case could appear in `observed` while five of
# the eight fields it elided went unanswered, and the check still passed. Now
# every field a case replaced with the pointer must be named in that case's
# `covers` and be present in its observation.
FINDINGS_POINTERS_OK="$(jq -s -r '
  ( .[0].managed | to_entries | map(.value[])
    | map(select((tostring) | contains("<race outcome: see findings>")) | .case)
    | unique ) as $pointers
  | ( (.[1] // []) ) as $observed
  | ( $observed | map(.case) ) as $present
  | (($pointers - $present) | length) == 0
    and ( $observed | all(
            (.covers | length) > 0
            and ( .outcomes | all( .outcome
                    | ( has("failures") and has("sqlstates") and has("executions")
                        and has("lineage") and has("reachability")
                        and has("ownership") and has("storeTerminal")
                        and has("work") ) ) ) ) )
  | tostring
' "${RUN_DIR}/repeat-1/run.json" "${RUN_DIR}/observed.json")"
info "bounded outcome sets complete: ${BOUNDED_OK}; findings pointers resolve: ${FINDINGS_POINTERS_OK}"

# Composed from files rather than `--argjson` strings: the canonical projections
# are large enough that inlining them overflows the argument list, which fails as
# a harness fault at the very last step of a good run.
jq -n \
  --arg run_id "${RUN_ID}" \
  --arg run_dir "${REL_RUN_DIR}" \
  --arg spike "${SPIKE}" \
  --arg image_id "${IMAGE_ID}" \
  --arg pg_image_id "${PG_IMAGE_ID}" \
  --arg pg_image "${PG_IMAGE}" \
  --argjson subset "${SUBSET}" \
  --argjson repeats "${REPEATS}" \
  --argjson cross "${HAVE_CROSS_REPEAT}" \
  --argjson reproducible "${REPRODUCIBLE}" \
  --argjson acceptance_stable "${ACCEPTANCE_STABLE}" \
  --slurpfile fixturesFile "${RUN_DIR}/manifest.json" \
  --slurpfile firstFile "${RUN_DIR}/repeat-1/run.json" \
  --slurpfile posturesFile "${RUN_DIR}/postures.json" \
  --slurpfile digestsFile "${RUN_DIR}/digests.json" \
  --slurpfile reasonsFile "${RUN_DIR}/subset-reasons.json" \
  --slurpfile preservedFile "${RUN_DIR}/preserved.json" \
  --slurpfile acceptAllFile "${RUN_DIR}/acceptance-all.json" \
  --slurpfile acceptLanesFile "${RUN_DIR}/acceptance-lanes-all.json" \
  --slurpfile observedFile "${RUN_DIR}/observed.json" \
  --argjson allSelectedPresent "${ALL_SELECTED_PRESENT}" \
  --argjson boundedOk "${BOUNDED_OK}" \
  --argjson findingsPointersOk "${FINDINGS_POINTERS_OK}" \
  '($fixturesFile[0]) as $fixtures
   | ($firstFile[0])   as $first
   | ($posturesFile[0]) as $postures
   | ($digestsFile[0])  as $digests
   | ($reasonsFile[0])  as $reasons
   | ($preservedFile[0]) as $preserved
   | ($acceptAllFile[0]) as $acceptAll
   | ($acceptLanesFile[0]) as $acceptLanes
   | ($observedFile[0]) as $observed
   | {
     schema: "agent-runtime/spike-evidence/2",
     spike: $spike,
     run_id: $run_id,
     run_dir: $run_dir,
     subset: $subset,
     final: (($subset | not) and $cross),
     subset_reasons: $reasons,
     image_id: $image_id,
     database: { image: $pg_image, image_id: $pg_image_id,
                 auth_method: "trust (isolated internal network, throwaway harness)",
                 hardening: "stock entrypoint; NOT held to the worker posture",
                 per_family_cluster: true },
     fixtures: $fixtures,
     worker_posture: $postures,
     repeats: $repeats,
     lanes: $first.lanes,
     managed_digests: ($first.managed_digests + { per_repeat_overall: $digests }),
     managed: $first.managed,
     cases: $first.cases,
     # Digest-excluded by construction: assembled after every digest above was
     # computed from `managed`. A race outcome belongs in the citable file, but
     # digesting one would report expected variation as irreproducibility.
     observed: $observed,
     acceptance: ($first.acceptance
                  | .flat = $acceptAll
                  | .lanes = $acceptLanes
                  | .global += { all_selected_cases_present: $allSelectedPresent,
                                 every_bounded_case_has_a_persisted_outcome_set: $boundedOk,
                                 no_managed_field_points_at_absent_findings: $findingsPointersOk }
                  | if $cross
                    then .global += { reproducible_across_runs: $reproducible,
                                      acceptance_stable_across_runs: $acceptance_stable }
                    else . end),
     preserved: $preserved
   }' > "${RUN_DIR}/evidence.candidate.json"
rm -f "${RUN_DIR}/postures.json" "${RUN_DIR}/digests.json" "${RUN_DIR}/subset-reasons.json"

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
# inside the scan's own coverage.
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
  scan_rule "wsl-host-path"            '\\\\wsl(\$|\.localhost)\\|[A-Za-z]:\\Users\\'
  scan_rule "pg-connection-log-line"   'connection authorized: user=[^[:space:]]+ database=[^[:space:]]+.*host='
} > "${RUN_DIR}/scan-rules.ndjson"

jq -s '.' "${RUN_DIR}/scan-rules.ndjson" > "${RUN_DIR}/scan.json"
rm -f "${RUN_DIR}/scan-rules.ndjson"
info "scan violations: ${SCAN_HITS}"

if [ "${SCAN_HITS}" -ne 0 ]; then
  chmod -R go-rwx "${RUN_DIR}" || true
  printf '\n\033[1;31mSanitization violation: evidence quarantined at %s\033[0m\n' "${REL_RUN_DIR}" >&2
  exit 4
fi

# Promoted only after its own bytes came back clean. A non-final run is written
# as evidence.subset.json and evidence.json is NOT created, so nothing can cite a
# subset by citing the canonical filename.
OUT="evidence.json"
[ "${SUBSET}" = "true" ] && OUT="evidence.subset.json"
jq --argjson scan "$(cat "${RUN_DIR}/scan.json")" \
   '.scan = {violations: 0, rules: $scan}
    | .acceptance.global += {no_credential_in_evidence: true}' \
   "${RUN_DIR}/evidence.candidate.json" > "${RUN_DIR}/${OUT}"
rm -f "${RUN_DIR}/evidence.candidate.json"

# Global criteria are printed and counted alongside the per-case ones: the
# cross-repeat facts live only in `global`, and omitting them from the tally is
# how a non-reproducible run would report success.
jq -r '(.acceptance.global + .acceptance.flat) | to_entries[]
       | "  " + (if .value then "PASS" else "FAIL" end) + "  " + .key' \
  "${RUN_DIR}/${OUT}"

FAILED="$(jq -r '[(.acceptance.global + .acceptance.flat) | to_entries[]
                 | select(.value == false)] | length' "${RUN_DIR}/${OUT}")"

trap - ERR

if [ "${CLEANUP}" -eq 1 ] && [ "${FAILED}" -eq 0 ]; then
  log "Cleaning up (explicitly requested)"
  docker image rm "${IMAGE}" > /dev/null 2>&1 || true
elif [ "${CLEANUP}" -eq 1 ]; then
  warn "--cleanup refused: this run did not pass and its state is evidence"
fi

print_preserved

log "Evidence written to ${REL_RUN_DIR}/${OUT}"

if [ "${FAILED}" -ne 0 ]; then
  printf '\n\033[1;31m%s acceptance criteria failed.\033[0m A reproducible negative is a valid spike outcome — report it, do not paper over it.\n' "${FAILED}"
  exit 1
fi

printf '\n\033[1;32mAll acceptance criteria passed.\033[0m\n'
