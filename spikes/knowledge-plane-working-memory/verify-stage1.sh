#!/usr/bin/env bash
# Stage 1 driver.
#
# The driver collects; it does not assert. Every acceptance map and every digest
# is computed inside the pinned image from collected bundles, so the claims and
# the code making them stay on the same version. The driver owns only
# cross-repeat facts, and names them as such.
#
# Exit codes:
#   0  pass
#   1  measured negative
#   2  usage
#   3  harness fault
#   4  sanitization violation

set -Eeuo pipefail

EXIT_PASS=0
EXIT_MEASURED_NEGATIVE=1
EXIT_USAGE=2
EXIT_HARNESS_FAULT=3
EXIT_SANITIZATION=4

SPIKE="knowledge-plane-working-memory"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"

usage() {
  cat <<'USAGE'
usage: verify-stage1.sh [options]

  --repeats N        isolated repeats (default 3; fewer produces a subset run)
  --lane ID          restrict to one lane (subset run)
  --family ID        restrict to one family (subset run)
  --only CASE[,...]  restrict to named cases (subset run)
  --keep             do not remove containers, networks, or volumes
  --help

A full, citable run is 3 repeats with no lane, family, or case restriction.
Anything narrower writes evidence.subset.json and never evidence.json.
USAGE
}

REPEATS=3
LANE_FILTER=""
FAMILY_FILTER=""
ONLY_FILTER=""
KEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repeats) REPEATS="${2:-}"; shift 2 ;;
    --lane) LANE_FILTER="${2:-}"; shift 2 ;;
    --family) FAMILY_FILTER="${2:-}"; shift 2 ;;
    --only) ONLY_FILTER="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --help) usage; exit "${EXIT_USAGE}" ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage; exit "${EXIT_USAGE}" ;;
  esac
done

if ! [[ "${REPEATS}" =~ ^[0-9]+$ ]] || [[ "${REPEATS}" -lt 1 ]]; then
  printf 'repeats must be a positive integer\n' >&2
  exit "${EXIT_USAGE}"
fi

SUBSET=0
SUBSET_REASONS=()
[[ "${REPEATS}" -lt 3 ]] && { SUBSET=1; SUBSET_REASONS+=("repeats=${REPEATS}"); }
[[ -n "${LANE_FILTER}" ]] && { SUBSET=1; SUBSET_REASONS+=("lane=${LANE_FILTER}"); }
[[ -n "${FAMILY_FILTER}" ]] && { SUBSET=1; SUBSET_REASONS+=("family=${FAMILY_FILTER}"); }
[[ -n "${ONLY_FILTER}" ]] && { SUBSET=1; SUBSET_REASONS+=("only=${ONLY_FILTER}"); }

# The run id reaches container names and the cited artifact, so it is validated
# rather than trusted.
RUN_ID="${RUN_ID:-stage1-$(date -u +%Y%m%dT%H%M%SZ)}"
if ! [[ "${RUN_ID}" =~ ^[A-Za-z0-9._-]+$ ]] || [[ "${#RUN_ID}" -gt 64 ]]; then
  printf 'RUN_ID must match [A-Za-z0-9._-]+ and be at most 64 characters\n' >&2
  exit "${EXIT_USAGE}"
fi

RUN_DIR="${REPO_ROOT}/tmp/spikes/${SPIKE}/${RUN_ID}"
if [[ -d "${RUN_DIR}" ]] && [[ -n "$(ls -A "${RUN_DIR}" 2>/dev/null)" ]]; then
  printf 'run directory already exists and is not empty: %s\n' "${RUN_DIR}" >&2
  printf 'a stale bundle must not join a later result\n' >&2
  exit "${EXIT_USAGE}"
fi
mkdir -p "${RUN_DIR}"

SUFFIX="$(printf '%s' "${RUN_ID}" | tr -cd '[:alnum:]' | tail -c 14)"
IMAGE="agent-runtime/${SPIKE}:${RUN_ID}"
PRESERVED="${RUN_DIR}/preserved.ndjson"
: >"${PRESERVED}"

note_preserved() {
  printf '{"kind":"%s","name":"%s"}\n' "$1" "$2" >>"${PRESERVED}"
}

# Compose creates networks and volumes that nothing was registering, so every
# run leaked them. They are recorded at creation, in dependency order, and the
# cleanup trap removes containers, then networks, then volumes.
compose_up() {
  local profile="$1" repeat="$2"; shift 2
  export COMPOSE_PROJECT_NAME="kpwm${SUFFIX}r${repeat}"
  export NET_LANE_M="kpwm-${SUFFIX}-r${repeat}-lane-m"
  export NET_LANE_N="kpwm-${SUFFIX}-r${repeat}-lane-n"
  export VOL_PG_M="kpwm-${SUFFIX}-r${repeat}-pg-m"
  export VOL_PG_N="kpwm-${SUFFIX}-r${repeat}-pg-n"
  export VOL_NEO4J_N="kpwm-${SUFFIX}-r${repeat}-neo4j-n"
  export VOL_VAULT_M="kpwm-${SUFFIX}-r${repeat}-vault-m"
  export VOL_SOURCES_N="kpwm-${SUFFIX}-r${repeat}-sources-n"
  export VOL_COORDINATION="kpwm-${SUFFIX}-r${repeat}-coordination"

  note_preserved network "${NET_LANE_M}"
  note_preserved network "${NET_LANE_N}"
  for volume in "${VOL_PG_M}" "${VOL_PG_N}" "${VOL_NEO4J_N}" "${VOL_VAULT_M}" \
                "${VOL_SOURCES_N}" "${VOL_COORDINATION}"; do
    note_preserved volume "${volume}"
  done

  docker compose --profile "${profile}" -f "${HERE}/compose.yaml" up -d "$@" \
    >"${RUN_DIR}/compose-${profile}-r${repeat}.log" 2>&1 \
    || fault "compose" "profile ${profile} failed to start; see compose log"
}

# Readiness is polled from the daemon's own health report, never slept for. A
# store that is listening but not yet serving is exactly what produces a first
# operation that fails for reasons the case never intended to measure.
compose_wait() {
  local service="$1" deadline=$(( SECONDS + 240 ))
  local id status
  while [[ "${SECONDS}" -lt "${deadline}" ]]; do
    id="$(docker compose -f "${HERE}/compose.yaml" ps -q "${service}" 2>/dev/null || true)"
    if [[ -n "${id}" ]]; then
      status="$(docker inspect --format '{{.State.Health.Status}}' "${id}" 2>/dev/null || true)"
      [[ "${status}" == "healthy" ]] && return 0
    fi
    sleep 2
  done
  fault "compose" "${service} did not become healthy within 240s"
}

compose_down() {
  local profile="$1"
  docker compose --profile "${profile}" -f "${HERE}/compose.yaml" down -v \
    >/dev/null 2>&1 || true
}

fault() {
  local step="$1" message="$2"
  printf 'harness fault [%s]: %s\n' "${step}" "${message}" >&2
  printf '{"step":"%s","message":"%s"}\n' "${step}" "${message}" >"${RUN_DIR}/fault.json"
  exit "${EXIT_HARNESS_FAULT}"
}

cleanup() {
  [[ "${KEEP}" -eq 1 ]] && return 0
  # Dependency order: containers, then networks, then volumes.
  awk -F'"' '/"container"/{print $8}' "${PRESERVED}" 2>/dev/null | while read -r name; do
    [[ -n "${name}" ]] && docker rm -f "${name}" >/dev/null 2>&1 || true
  done
  awk -F'"' '/"network"/{print $8}' "${PRESERVED}" 2>/dev/null | while read -r name; do
    [[ -n "${name}" ]] && docker network rm "${name}" >/dev/null 2>&1 || true
  done
  awk -F'"' '/"volume"/{print $8}' "${PRESERVED}" 2>/dev/null | while read -r name; do
    [[ -n "${name}" ]] && docker volume rm "${name}" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

printf 'building %s\n' "${IMAGE}" >&2
if ! docker build --tag "${IMAGE}" "${HERE}" >"${RUN_DIR}/build.log" 2>&1; then
  fault "build" "docker build failed; see build.log"
fi
IMAGE_ID="$(docker image inspect --format '{{.Id}}' "${IMAGE}")"

# ---------------------------------------------------------------------------
# Worker invocation
#
# Hardened, gateway-less, PID 1, one JSON object to stdout, no files. A
# container that exits 0 having printed nothing is a fault: Node exits cleanly
# when the event loop empties with a promise still pending, which is exactly the
# shape of a rendezvous that never completed.
# ---------------------------------------------------------------------------

# Extra read-only mounts for the validator and comparator, set by the caller
# immediately before the call and cleared immediately after. Adapter containers
# never receive them: the oracle is not reachable from a lane, by construction
# rather than by policy.
WORKER_MOUNTS=()

# Extra docker arguments for one call, set immediately before and cleared
# immediately after. Used for writable scratch and lane volumes.
#
# A tmpfs is created root-owned by default while the image runs as an
# unprivileged user, so every scratch mount carries an explicit uid/gid. Without
# it the first canonical write fails with EACCES and reads as a lane defect
# rather than the mount error it is.
WORKER_ARGS=()

run_worker() {
  local name="$1" network="$2" budget_ms="$3" out="$4"; shift 4
  local secs=$(( (budget_ms + 999) / 1000 ))
  local net_args=()
  if [[ "${network}" == "none" ]]; then
    net_args=(--network none)
  else
    net_args=(--network "${network}")
  fi

  note_preserved container "${name}"
  local status=0
  set +e
  timeout "${secs}" docker run \
    --name "${name}" \
    "${net_args[@]}" \
    --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges \
    --memory 512m --pids-limit 256 --restart=no \
    -e TZ=UTC \
    "${WORKER_ARGS[@]+"${WORKER_ARGS[@]}"}" \
    "${WORKER_MOUNTS[@]+"${WORKER_MOUNTS[@]}"}" \
    "${IMAGE}" "$@" >"${out}" 2>"${out}.stderr"
  status=$?
  set -e

  # A non-zero exit is a RESULT when the container still printed evidence; it is
  # only a fault when nothing was printed at all.
  if [[ "${status}" -ne 0 ]] && [[ ! -s "${out}" ]]; then
    fault "worker" "${name} exited ${status} without printing evidence"
  fi

  if [[ ! -s "${out}" ]]; then
    fault "worker" "${name} produced no evidence"
  fi

  # The image the container actually ran must be the image we built.
  local ran_image
  ran_image="$(docker inspect --format '{{.Image}}' "${name}" 2>/dev/null || true)"
  if [[ "${ran_image}" != "${IMAGE_ID}" ]]; then
    fault "worker" "${name} ran ${ran_image}, expected ${IMAGE_ID}"
  fi

  # Posture read back rather than assumed.
  docker inspect --format \
    '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.Config.User}}' \
    "${name}" >"${out}.posture" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Repeats
# ---------------------------------------------------------------------------

SELECTED_FAMILIES=(K C T Q P N X R)
if [[ -n "${FAMILY_FILTER}" ]]; then
  SELECTED_FAMILIES=("${FAMILY_FILTER}")
fi

for family in "${SELECTED_FAMILIES[@]}"; do
  case "${family}" in
    K|C|T|Q|P|N|X|R) ;;
    *) printf 'unknown family: %s\n' "${family}" >&2; exit "${EXIT_USAGE}" ;;
  esac
done

CORPUS_MOUNT="${HERE}/corpus/input"
ORACLE_MOUNT="${HERE}/oracle"

# Families that need a lane stack, so it is started once per repeat rather than
# once per family.
needs_lane_m() { [[ " ${SELECTED_FAMILIES[*]} " =~ [[:space:]](C|T|Q|P|N|X|R)[[:space:]] ]]; }

for (( repeat = 1; repeat <= REPEATS; repeat++ )); do
  REPEAT_DIR="${RUN_DIR}/repeat-${repeat}"
  mkdir -p "${REPEAT_DIR}"
  PREFIX="kpwm-${SUFFIX}-r${repeat}"

  # --- K: apparatus self-test, no stores, no network ------------------------
  if [[ " ${SELECTED_FAMILIES[*]} " =~ [[:space:]]K[[:space:]] ]]; then
    run_worker "${PREFIX}-selftest" none 120000 "${REPEAT_DIR}/selftest.json" selftest

    WORKER_MOUNTS=(-v "${CORPUS_MOUNT}:/corpus:ro" -v "${ORACLE_MOUNT}:/oracle:ro")
    run_worker "${PREFIX}-validate" none 120000 "${REPEAT_DIR}/validate.json" \
      validate --corpus /corpus --oracle /oracle
    WORKER_MOUNTS=()
  fi

  if needs_lane_m; then
    # --- Lane M stack -------------------------------------------------------
    compose_up lane-m "${repeat}" pg-m
    compose_wait pg-m

    WORKER_MOUNTS=(-v "${CORPUS_MOUNT}:/corpus:ro" -v "${VOL_VAULT_M}:/vault")
    run_worker "${PREFIX}-lane-m-answers" "${NET_LANE_M}" 600000 \
      "${REPEAT_DIR}/lane-m-answers.json" \
      lane-m-answers --corpus /corpus --vault /vault
    WORKER_MOUNTS=()

    # The projection lifecycle needs its own vault and its own database state,
    # because a fresh vault paired with a warm idempotency ledger replays every
    # command and answers empty.
    compose_down lane-m
    compose_up lane-m "${repeat}" pg-m
    compose_wait pg-m
    WORKER_MOUNTS=(-v "${CORPUS_MOUNT}:/corpus:ro")
    WORKER_ARGS=(--tmpfs /vault:rw,size=64m,uid=1000,gid=1000)
    run_worker "${PREFIX}-lane-m-projection" "${NET_LANE_M}" 600000 \
      "${REPEAT_DIR}/lane-m-projection.json" \
      lane-m-projection --corpus /corpus --vault /vault
    WORKER_ARGS=()
    WORKER_MOUNTS=()

    # --- The offline lanes: no store, no network, writable scratch only ------
    #
    # NO ORACLE MOUNT. These run Lane M adapters and are therefore lane
    # containers, and the oracle must not be reachable from one. Sharing a mount
    # block with the validator previously made it reachable from all four, which
    # is a structural isolation failure even where nothing read it: the rule
    # exists so that a later change cannot quietly start reading it.
    WORKER_MOUNTS=(-v "${CORPUS_MOUNT}:/corpus:ro")
    WORKER_ARGS=(--tmpfs /vault:rw,size=128m,uid=1000,gid=1000)
    if [[ " ${SELECTED_FAMILIES[*]} " =~ [[:space:]]P[[:space:]] ]]; then
      run_worker "${PREFIX}-coordination" none 600000 "${REPEAT_DIR}/coordination.json" \
        coordination-controls --corpus /corpus --vault /vault
    fi
    if [[ " ${SELECTED_FAMILIES[*]} " =~ [[:space:]]N[[:space:]] ]]; then
      run_worker "${PREFIX}-native" none 600000 "${REPEAT_DIR}/native-walkthrough.json" \
        native-walkthrough --corpus /corpus --vault /vault
    fi
    if [[ " ${SELECTED_FAMILIES[*]} " =~ [[:space:]]Q[[:space:]] ]]; then
      run_worker "${PREFIX}-shuffled" none 600000 "${REPEAT_DIR}/shuffled-ids.json" \
        shuffled-ids --corpus /corpus --vault /vault
    fi
    # Gated on X OR R, matching faults-n. It was gated on X alone, so a
    # `--family R` run produced Lane N's portability criteria with no Lane M
    # counterpart — an asymmetry in exactly the subset an auditor is most likely
    # to run.
    if [[ " ${SELECTED_FAMILIES[*]} " =~ [[:space:]](X|R)[[:space:]] ]]; then
      run_worker "${PREFIX}-faults-m" none 900000 "${REPEAT_DIR}/faults-m.json" \
        faults-m --corpus /corpus --vault /vault
    fi
    WORKER_ARGS=()
    WORKER_MOUNTS=()

    # --- The two-writer race: real processes, durable barrier ---------------
    if [[ " ${SELECTED_FAMILIES[*]} " =~ [[:space:]]X[[:space:]] ]]; then
      compose_down lane-m
      compose_up lane-m "${repeat}" pg-m
      compose_wait pg-m

      RACE_MOUNTS=(-v "${CORPUS_MOUNT}:/corpus:ro" -v "${VOL_VAULT_M}:/vault")
      # x03 and x04 both run, and both run for BOTH lanes. They were declared
      # `lanes: BOTH` in the registry and only ever launched with `--lane m
      # --case x04`, so the preferred lane had no concurrency evidence at all and
      # the duplicate-create race had none for either lane.
      for race_case in x03 x04; do
        compose_down lane-m
        compose_up lane-m "${repeat}" pg-m
        compose_wait pg-m

        WORKER_MOUNTS=("${RACE_MOUNTS[@]}")
        run_worker "${PREFIX}-race-prep-${race_case}" "${NET_LANE_M}" 600000 \
          "${REPEAT_DIR}/race-prepare-m-${race_case}.json" \
          race-prepare --lane m --corpus /corpus --root /vault
        WORKER_MOUNTS=()

        # Both parties are launched detached and then waited on, so neither can
        # be serialised by the driver itself. Their rendezvous is the durable
        # barrier, not this loop.
        for member in a b; do
          note_preserved container "${PREFIX}-race-m-${race_case}-${member}"
          docker run -d --name "${PREFIX}-race-m-${race_case}-${member}" \
            --network "${NET_LANE_M}" --read-only --tmpfs /tmp \
            --cap-drop ALL --security-opt no-new-privileges \
            --memory 512m --pids-limit 256 --restart=no -e TZ=UTC -e PGHOST=pg-m \
            "${RACE_MOUNTS[@]}" "${IMAGE}" \
            race-party --lane m --case "${race_case}" --member "${member}" --parties 2 \
            --corpus /corpus --root /vault >/dev/null 2>&1 \
            || fault "race" "could not launch lane-m ${race_case} party ${member}"
        done
        for member in a b; do
          docker wait "${PREFIX}-race-m-${race_case}-${member}" >/dev/null 2>&1 || true
          docker logs "${PREFIX}-race-m-${race_case}-${member}" \
            >"${REPEAT_DIR}/race-party-m-${race_case}-${member}.json" 2>&1 || true
        done

        WORKER_MOUNTS=("${RACE_MOUNTS[@]}")
        run_worker "${PREFIX}-race-collect-m-${race_case}" "${NET_LANE_M}" 600000 \
          "${REPEAT_DIR}/race-collect-m-${race_case}.json" \
          race-collect --lane m --case "${race_case}" --parties 2 --corpus /corpus --root /vault
        WORKER_MOUNTS=()
      done
    fi

    compose_down lane-m

    # --- Lane N stack -------------------------------------------------------
    compose_up lane-n "${repeat}" pg-n neo4j-n
    compose_wait pg-n
    compose_wait neo4j-n

    # Lane N's execution plane is its OWN Postgres. The default host name points
    # at Lane M's, which is not even reachable from this network.
    WORKER_ARGS=(-e PGHOST=pg-n)
    WORKER_MOUNTS=(-v "${CORPUS_MOUNT}:/corpus:ro" -v "${VOL_SOURCES_N}:/sources")
    run_worker "${PREFIX}-lane-n-answers" "${NET_LANE_N}" 900000 \
      "${REPEAT_DIR}/lane-n-answers.json" \
      lane-n-answers --corpus /corpus --sources /sources
    WORKER_ARGS=()
    WORKER_MOUNTS=()

    if [[ " ${SELECTED_FAMILIES[*]} " =~ [[:space:]]N[[:space:]] ]]; then
      compose_down lane-n
      compose_up lane-n "${repeat}" pg-n neo4j-n
      compose_wait neo4j-n
      WORKER_MOUNTS=(-v "${CORPUS_MOUNT}:/corpus:ro")
      WORKER_ARGS=(-e PGHOST=pg-n --tmpfs /sources:rw,size=64m,uid=1000,gid=1000)
      run_worker "${PREFIX}-native-graph" "${NET_LANE_N}" 900000 \
        "${REPEAT_DIR}/native-graph.json" native-graph --corpus /corpus --sources /sources
      WORKER_ARGS=()
      WORKER_MOUNTS=()
    fi

    if [[ " ${SELECTED_FAMILIES[*]} " =~ [[:space:]](X|R)[[:space:]] ]]; then
      compose_down lane-n
      compose_up lane-n "${repeat}" pg-n neo4j-n
      compose_wait neo4j-n
      WORKER_MOUNTS=(-v "${CORPUS_MOUNT}:/corpus:ro")
      WORKER_ARGS=(-e PGHOST=pg-n --tmpfs /sources:rw,size=64m,uid=1000,gid=1000)
      run_worker "${PREFIX}-faults-n" "${NET_LANE_N}" 900000 \
        "${REPEAT_DIR}/faults-n.json" faults-n --corpus /corpus --sources /sources
      WORKER_ARGS=()
      WORKER_MOUNTS=()
    fi

    # --- The two-writer race, Lane N. Same shape, same cases, same barrier. ---
    if [[ " ${SELECTED_FAMILIES[*]} " =~ [[:space:]]X[[:space:]] ]]; then
      RACE_N_MOUNTS=(-v "${CORPUS_MOUNT}:/corpus:ro" -v "${VOL_SOURCES_N}:/sources")
      for race_case in x03 x04; do
        compose_down lane-n
        compose_up lane-n "${repeat}" pg-n neo4j-n
        compose_wait pg-n
        compose_wait neo4j-n

        WORKER_ARGS=(-e PGHOST=pg-n)
        WORKER_MOUNTS=("${RACE_N_MOUNTS[@]}")
        run_worker "${PREFIX}-race-prep-n-${race_case}" "${NET_LANE_N}" 900000 \
          "${REPEAT_DIR}/race-prepare-n-${race_case}.json" \
          race-prepare --lane n --corpus /corpus --root /sources
        WORKER_ARGS=()
        WORKER_MOUNTS=()

        for member in a b; do
          note_preserved container "${PREFIX}-race-n-${race_case}-${member}"
          docker run -d --name "${PREFIX}-race-n-${race_case}-${member}" \
            --network "${NET_LANE_N}" --read-only --tmpfs /tmp \
            --cap-drop ALL --security-opt no-new-privileges \
            --memory 512m --pids-limit 256 --restart=no -e TZ=UTC -e PGHOST=pg-n \
            "${RACE_N_MOUNTS[@]}" "${IMAGE}" \
            race-party --lane n --case "${race_case}" --member "${member}" --parties 2 \
            --corpus /corpus --root /sources >/dev/null 2>&1 \
            || fault "race" "could not launch lane-n ${race_case} party ${member}"
        done
        for member in a b; do
          docker wait "${PREFIX}-race-n-${race_case}-${member}" >/dev/null 2>&1 || true
          docker logs "${PREFIX}-race-n-${race_case}-${member}" \
            >"${REPEAT_DIR}/race-party-n-${race_case}-${member}.json" 2>&1 || true
        done

        WORKER_ARGS=(-e PGHOST=pg-n)
        WORKER_MOUNTS=("${RACE_N_MOUNTS[@]}")
        run_worker "${PREFIX}-race-collect-n-${race_case}" "${NET_LANE_N}" 900000 \
          "${REPEAT_DIR}/race-collect-n-${race_case}.json" \
          race-collect --lane n --case "${race_case}" --parties 2 --corpus /corpus --root /sources
        WORKER_ARGS=()
        WORKER_MOUNTS=()
      done
    fi

    compose_down lane-n

    # --- Comparators: the ONLY containers the oracle is mounted into, and they
    # have no network at all. There is no path from here back to execution.
    for lane in m n; do
      if [[ -s "${REPEAT_DIR}/lane-${lane}-answers.json" ]]; then
        WORKER_MOUNTS=(
          -v "${ORACLE_MOUNT}:/oracle:ro"
          -v "${REPEAT_DIR}/lane-${lane}-answers.json:/answers.json:ro"
        )
        run_worker "${PREFIX}-golden-${lane}" none 300000 \
          "${REPEAT_DIR}/compare-golden-${lane}.json" \
          compare-golden --answers /answers.json --oracle /oracle
        WORKER_MOUNTS=()
      fi
    done

    if [[ -s "${REPEAT_DIR}/lane-m-answers.json" ]] && [[ -s "${REPEAT_DIR}/lane-n-answers.json" ]]; then
      WORKER_MOUNTS=(
        -v "${REPEAT_DIR}/lane-m-answers.json:/m.json:ro"
        -v "${REPEAT_DIR}/lane-n-answers.json:/n.json:ro"
      )
      run_worker "${PREFIX}-compare-lanes" none 300000 "${REPEAT_DIR}/compare-lanes.json" \
        compare-lanes --lane-m /m.json --lane-n /n.json
      WORKER_MOUNTS=()
    fi
  fi
done

# ---------------------------------------------------------------------------
# Registry and manifest snapshots, taken from inside the image
# ---------------------------------------------------------------------------

run_worker "kpwm-${SUFFIX}-manifest" none 60000 "${RUN_DIR}/manifest.json" manifest
run_worker "kpwm-${SUFFIX}-cases" none 60000 "${RUN_DIR}/cases.json" cases
run_worker "kpwm-${SUFFIX}-families" none 60000 "${RUN_DIR}/families.json" families
run_worker "kpwm-${SUFFIX}-lanes" none 60000 "${RUN_DIR}/lanes.json" lanes

# ---------------------------------------------------------------------------
# Cross-repeat acceptance: the elementwise AND, never repeat 1's map
# ---------------------------------------------------------------------------

python3 - "${RUN_DIR}" "${REPEATS}" <<'PY' || fault "acceptance" "cross-repeat reduction failed"
import json, pathlib, sys

run_dir = pathlib.Path(sys.argv[1])
repeats = int(sys.argv[2])

# Every bundle that emits an acceptance map. `lane-m-answers` and
# `lane-n-answers` were omitted, so their criteria — including Lane N's
# constraint and atomicity checks — were emitted and then silently discarded: a
# false one could not have failed the run.
BUNDLES = (
    "selftest.json",
    "validate.json",
    "lane-m-answers.json",
    "lane-n-answers.json",
    "lane-m-projection.json",
    "coordination.json",
    "native-walkthrough.json",
    "shuffled-ids.json",
    "faults-m.json",
    "native-graph.json",
    "faults-n.json",
    "compare-golden-m.json",
    "compare-golden-n.json",
    "compare-lanes.json",
)

# Bounded races report an OUTCOME SET and are excluded from the elementwise AND
# by construction: an unsampled interleaving is unsampled, never impossible, and
# folding it into a pass/fail would call the lane race-free because no failure
# happened to appear.
BOUNDED = tuple(
    f"race-collect-{lane}-{case}.json" for lane in ("m", "n") for case in ("x03", "x04")
)

maps = []
for index in range(1, repeats + 1):
    for name in BUNDLES:
        path = run_dir / f"repeat-{index}" / name
        if not path.exists():
            continue
        payload = json.loads(path.read_text())
        acceptance = payload.get("acceptance", {})
        # Bundles that BOTH lanes produce are namespaced by lane. Without this a
        # criterion declared once per lane appears 2*repeats times, and the
        # reduction records it false for having been declared too often — a
        # failure that is entirely an artifact of counting.
        lane = None
        if name.startswith("compare-golden-"):
            lane = name.replace("compare-golden-", "").replace(".json", "")
        elif name in ("faults-m.json", "faults-n.json"):
            lane = name.replace("faults-", "").replace(".json", "")
        elif name in ("lane-m-answers.json", "lane-n-answers.json"):
            lane = name.split("-")[1]
        if lane is not None:
            acceptance = {f"{lane}:{k}": v for k, v in acceptance.items()}
        maps.append(acceptance)

if not maps:
    raise SystemExit("no acceptance maps collected")

keys = set()
for entry in maps:
    keys |= set(entry)
if not keys:
    raise SystemExit("acceptance maps are empty")

# Elementwise AND across repeats, per criterion. A criterion is combined only
# over the bundles that actually declare it, and it must be declared once per
# repeat: a criterion that vanished from a later repeat is a failure, not an
# absence to be ignored.
combined = {}
for key in sorted(keys):
    values = [entry[key] for entry in maps if key in entry]
    combined[key] = len(values) == repeats and all(value is True for value in values)

# Criteria that require more than one repeat are OMITTED rather than recorded as
# false, so a single-repeat subset cannot look like a failure it never tested.
# Golden answers must be identical across repeats AND across lanes. A criterion
# key is namespaced by lane where both produce one, so the reduction never sees
# one key declared twice in a single repeat — which it would record as false.
bounded = []
for index in range(1, repeats + 1):
    for name in BOUNDED:
        path = run_dir / f"repeat-{index}" / name
        if path.exists():
            payload = json.loads(path.read_text())
            bounded.append(
                {
                    "repeat": index,
                    "bundle": name,
                    "lane": payload.get("lane"),
                    "case": payload.get("case"),
                    **payload.get("findings", {}),
                }
            )
(run_dir / "bounded-outcomes.json").write_text(json.dumps(bounded, indent=2) + "\n")

cross = {}
detail = {}
if repeats >= 2:
    digests = []
    corpus_digests = []
    oracle_digests = []
    for index in range(1, repeats + 1):
        selftest = run_dir / f"repeat-{index}" / "selftest.json"
        if selftest.exists():
            digests.append(json.loads(selftest.read_text()).get("findingsDigest"))
        validate = run_dir / f"repeat-{index}" / "validate.json"
        if validate.exists():
            findings = json.loads(validate.read_text()).get("findings", {})
            corpus_digests.append(findings.get("corpusDigest"))
            oracle_digests.append(findings.get("oracleDigest"))
    cross["selftest-digest-is-stable"] = len(set(digests)) == 1

    # THE structural stability gate, over the MEASUREMENT rather than over the
    # self-test's own constants. `structural-digest-is-stable` used to digest
    # only `selftest.json`'s findings — pin versions, canonicaliser digests over
    # hard-coded literals, registry counts — every one of them constant by
    # construction. It could not have varied, so it carried no evidence that
    # three isolated repeats produced one managed structure.
    #
    # Volatile values are removed by the same managed form the comparators use;
    # bounded races are excluded by construction.
    MEASURED = (
        "lane-m-answers.json",
        "lane-n-answers.json",
        "lane-m-projection.json",
        "coordination.json",
        "native-walkthrough.json",
        "shuffled-ids.json",
        "faults-m.json",
        "native-graph.json",
        "faults-n.json",
    )

    def managed_digest(payload):
        import hashlib

        def strip(value):
            if isinstance(value, dict):
                return {
                    k: strip(v)
                    for k, v in sorted(value.items())
                    # Predeclared volatile fields only. Anything else that moves
                    # between repeats is a real instability and must show up.
                    if k not in ("generation", "durabilityPoint", "receiptId", "barrier")
                }
            if isinstance(value, list):
                return [strip(v) for v in value]
            return value

        body = json.dumps(strip(payload.get("answers", payload)), sort_keys=True)
        return hashlib.sha256(body.encode()).hexdigest()

    per_bundle = {}
    for name in MEASURED:
        seen = []
        for index in range(1, repeats + 1):
            path = run_dir / f"repeat-{index}" / name
            if path.exists():
                seen.append(managed_digest(json.loads(path.read_text())))
        if seen:
            per_bundle[name] = {"digests": len(set(seen)), "repeats": len(seen)}
    cross["measured-structure-is-stable"] = bool(per_bundle) and all(
        entry["digests"] == 1 and entry["repeats"] == repeats for entry in per_bundle.values()
    )
    # Detail is a FINDING, not a criterion. Putting a dict in the boolean map
    # made `all(...)` true (a non-empty dict is truthy) while `v is not True`
    # listed it as failed — an outcome that read "pass" and carried a failure.
    detail["measured-structure"] = per_bundle
    # The frozen trees must be byte-identical at the START and the END of the
    # run, not merely at the start.
    if corpus_digests:
        cross["corpus-freeze-held"] = len(set(corpus_digests)) == 1
    if oracle_digests:
        cross["oracle-freeze-held"] = len(set(oracle_digests)) == 1

(run_dir / "acceptance-all.json").write_text(
    json.dumps(
        {"combined": combined, "crossRepeat": cross, "crossRepeatDetail": detail}, indent=2
    )
    + "\n"
)
PY

# ---------------------------------------------------------------------------
# Sanitization sweep
#
# The candidate is composed inside RUN_DIR first, then scanned, then promoted.
# Scanning before composing certifies a file that has not been written yet.
# ---------------------------------------------------------------------------

python3 - "${RUN_DIR}" "${RUN_ID}" "${IMAGE_ID}" "${SUBSET}" "${REPEATS}" \
  "${SUBSET_REASONS[*]-}" <<'PY' || fault "evidence" "candidate composition failed"
import json, pathlib, sys

run_dir = pathlib.Path(sys.argv[1])
run_id, image_id = sys.argv[2], sys.argv[3]
subset = sys.argv[4] == "1"
repeats = int(sys.argv[5])
reasons = [r for r in sys.argv[6].split() if r]

acceptance = json.loads((run_dir / "acceptance-all.json").read_text())

candidate = {
    "schema": "agent-runtime/spike-evidence/3",
    "spike": "knowledge-plane-working-memory",
    "run_id": run_id,
    "image_id": image_id,
    "repeats": repeats,
    "final": not subset,
    "subset": subset,
    "subset_reasons": reasons,
    "acceptance": acceptance["combined"],
    "cross_repeat": acceptance["crossRepeat"],
    "cross_repeat_detail": acceptance.get("crossRepeatDetail", {}),
    "outcome": {
        "status": "pass"
        if all(acceptance["combined"].values())
        and all(acceptance["crossRepeat"].values())
        else "fail",
        "failed": sorted(
            [k for k, v in acceptance["combined"].items() if v is not True]
            + [k for k, v in acceptance["crossRepeat"].items() if v is not True]
        ),
    },
}
(run_dir / "evidence.candidate.json").write_text(json.dumps(candidate, indent=2) + "\n")
PY

LEAK_RULES='postgres(ql)?://[^:@/[:space:]]+:[^@[:space:]]+@|PGPASSWORD=|Bearer [A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|sk-(proj-)?[A-Za-z0-9_-]{20,}|sk-ant-(api|oat|ort)[0-9]{2}-|api\.(openai|anthropic)\.com|/(home|Users)/[A-Za-z0-9._-]+/|/var/lib/docker/|/var/run/docker\.sock|DOCKER_HOST=|bolt(\+s|\+ssc)?://[^:@/[:space:]]+:[^@[:space:]]+@|NEO4J_AUTH=|KPWM-CANARY-4F2A9C61D7B3E508'

if grep -raEoh "${LEAK_RULES}" "${RUN_DIR}" >"${RUN_DIR}/scan.json.raw" 2>/dev/null; then
  if [[ -s "${RUN_DIR}/scan.json.raw" ]]; then
    chmod -R go-rwx "${RUN_DIR}" || true
    printf 'sanitization violation; run quarantined at %s\n' "${RUN_DIR}" >&2
    exit "${EXIT_SANITIZATION}"
  fi
fi
printf '{"hits":0}\n' >"${RUN_DIR}/scan.json"
rm -f "${RUN_DIR}/scan.json.raw"

if [[ "${SUBSET}" -eq 1 ]]; then
  mv "${RUN_DIR}/evidence.candidate.json" "${RUN_DIR}/evidence.subset.json"
  EVIDENCE="${RUN_DIR}/evidence.subset.json"
else
  mv "${RUN_DIR}/evidence.candidate.json" "${RUN_DIR}/evidence.json"
  EVIDENCE="${RUN_DIR}/evidence.json"
fi

printf 'evidence: %s\n' "${EVIDENCE}" >&2

STATUS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["outcome"]["status"])' "${EVIDENCE}")"
if [[ "${STATUS}" == "pass" ]]; then
  exit "${EXIT_PASS}"
fi
exit "${EXIT_MEASURED_NEGATIVE}"
