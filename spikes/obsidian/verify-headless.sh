#!/usr/bin/env bash
#
# Headless Obsidian spike driver.
#
# Runs the cold-start experiment, restarts the service five times, and writes
# sanitized evidence under tmp/spikes/obsidian/<run-id>/.
#
#   ./verify-headless.sh                 # default volumes, preserved on exit
#   ./verify-headless.sh --isolated      # unique project + volumes (repeat runs)
#   ./verify-headless.sh --isolated --cleanup
#
# Volumes are PRESERVED unless --cleanup is passed. Deleting a vault is an
# explicit act, never a side effect of running a test.

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"

RESTART_COUNT="${RESTART_COUNT:-5}"
ISOLATED=0
CLEANUP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --isolated) ISOLATED=1 ;;
    --cleanup)  CLEANUP=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="${REPO_ROOT}/tmp/spikes/obsidian/${RUN_ID}"
mkdir -p "${RUN_DIR}"

if [ "${ISOLATED}" -eq 1 ]; then
  # Compose project names must be lowercase alphanumeric, hyphen, underscore.
  SUFFIX="$(printf '%s' "${RUN_ID}" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]' | tail -c 12)"
  export COMPOSE_PROJECT_NAME="agent-runtime-obsidian-spike-${SUFFIX}"
  export OBSIDIAN_VAULT_VOLUME="agent-runtime-obsidian-vault-${SUFFIX}"
  export OBSIDIAN_PROFILE_VOLUME="agent-runtime-obsidian-profile-${SUFFIX}"
  export OBSIDIAN_NETWORK="agent-runtime-obsidian-spike-net-${SUFFIX}"
else
  export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-agent-runtime-obsidian-spike}"
fi

export APP_UID="${APP_UID:-$(id -u)}"
export APP_GID="${APP_GID:-$(id -g)}"

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
fail() { printf '\n\033[1;31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

compose() { docker compose --project-directory "${HERE}" -f "${HERE}/compose.yaml" "$@"; }

# ---------------------------------------------------------------------------
log "Run ${RUN_ID}"
info "project        ${COMPOSE_PROJECT_NAME}"
info "vault volume   ${OBSIDIAN_VAULT_VOLUME:-agent-runtime-obsidian-vault}"
info "profile volume ${OBSIDIAN_PROFILE_VOLUME:-agent-runtime-obsidian-profile}"
info "evidence       ${RUN_DIR}"

# ---------------------------------------------------------------------------
log "Generating the bearer token"
TOKEN_FILE="${RUN_DIR}/mcp-token"
( umask 077; head -c 32 /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_' > "${TOKEN_FILE}" )
chmod 600 "${TOKEN_FILE}"
export OBSIDIAN_MCP_TOKEN_FILE="${TOKEN_FILE}"
info "wrote $(wc -c < "${TOKEN_FILE}") bytes, mode $(stat -c '%a' "${TOKEN_FILE}") (value never printed)"

# ---------------------------------------------------------------------------
log "Building the image"
compose build 2>&1 | tee "${RUN_DIR}/build.log" | tail -n 15

# ---------------------------------------------------------------------------
log "Cold start from a fresh volume"
compose up -d 2>&1 | tee "${RUN_DIR}/up.log" | tail -n 10

CID="$(compose ps -q obsidian)"
[ -n "${CID}" ] || fail "no container id"
info "container ${CID:0:12}"

wait_healthy() {
  local label="$1" deadline=$(( SECONDS + ${2:-240} )) status=""
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    status="$(docker inspect --format '{{.State.Health.Status}}' "${CID}" 2>/dev/null || echo missing)"
    case "${status}" in
      healthy) info "${label}: healthy"; return 0 ;;
      unhealthy) ;;
    esac
    if [ "$(docker inspect --format '{{.State.Running}}' "${CID}" 2>/dev/null || echo false)" != "true" ]; then
      docker logs "${CID}" > "${RUN_DIR}/${label}-crash.log" 2>&1 || true
      fail "container stopped during ${label}; see ${RUN_DIR}/${label}-crash.log"
    fi
    sleep 3
  done
  docker logs "${CID}" > "${RUN_DIR}/${label}-timeout.log" 2>&1 || true
  fail "${label} never became healthy (last status: ${status}); see ${RUN_DIR}/${label}-timeout.log"
}

COLD_START_BEGAN=${SECONDS}
wait_healthy cold 300
COLD_SECONDS=$(( SECONDS - COLD_START_BEGAN ))
info "cold start took ~${COLD_SECONDS}s"

docker logs "${CID}" > "${RUN_DIR}/cold-entrypoint.log" 2>&1 || true

collect() {
  local out="$1"
  compose exec -T obsidian /usr/local/bin/collect-evidence.sh > "${out}" 2>"${out}.err" \
    || fail "evidence collection failed; see ${out}.err"
  jq -e '.' "${out}" >/dev/null || fail "evidence at ${out} is not valid JSON"
}

log "Collecting cold-start evidence"
collect "${RUN_DIR}/snapshot-00-cold.json"

jq -r '
  "  MCP unauthenticated : " + .mcp.status_unauthenticated,
  "  MCP wrong token     : " + .mcp.status_wrong_token,
  "  initialize          : " + (.mcp.initialize.ok | tostring) + "  " + (.mcp.initialize.server_name // "-"),
  "  get_server_info     : " + (.mcp.get_server_info.ok | tostring),
  "  token matches secret: " + (.secret.token_matches_secret | tostring),
  "  restricted mode     : " + .cli.restricted_mode,
  "  enabled plugins     : " + .cli.enabled_community_plugins,
  "  listeners           : " + (.listeners | join(", "))
' "${RUN_DIR}/snapshot-00-cold.json"

# ---------------------------------------------------------------------------
log "Restarting ${RESTART_COUNT} times"
for i in $(seq 1 "${RESTART_COUNT}"); do
  compose restart obsidian >/dev/null 2>&1 || fail "restart ${i} failed"
  wait_healthy "restart-${i}" 180
  collect "$(printf '%s/snapshot-%02d-restart.json' "${RUN_DIR}" "${i}")"
done

# ---------------------------------------------------------------------------
log "Comparing managed state across restarts"

MANAGED_FILTER='
  {
    managed_state: .managed_state,
    pinned_artifacts: .pinned_artifacts,
    managed_vault_files: [ .vault_tree[] | select(
        .path == ".obsidian/community-plugins.json"
        or .path == ".obsidian/plugins/mcp-tools-istefox/main.js"
        or .path == ".obsidian/plugins/mcp-tools-istefox/manifest.json"
      ) ]
  }'

jq -S "${MANAGED_FILTER}" "${RUN_DIR}/snapshot-00-cold.json" > "${RUN_DIR}/managed-00-cold.json"

DRIFT=0
for i in $(seq 1 "${RESTART_COUNT}"); do
  src="$(printf '%s/snapshot-%02d-restart.json' "${RUN_DIR}" "${i}")"
  dst="$(printf '%s/managed-%02d-restart.json' "${RUN_DIR}" "${i}")"
  jq -S "${MANAGED_FILTER}" "${src}" > "${dst}"
  if ! diff -u "${RUN_DIR}/managed-00-cold.json" "${dst}" > "${dst}.diff"; then
    DRIFT=$(( DRIFT + 1 ))
    info "restart ${i}: MANAGED STATE DRIFTED (see ${dst}.diff)"
  else
    rm -f "${dst}.diff"
    info "restart ${i}: managed state identical"
  fi
done

# Volatile files are observed, not asserted — they are expected to move.
log "Volatile vault files (observed, drift permitted)"
jq -r -s '
  ((.[0].vault_tree | map({(.path): .sha256}) | add) // {}) as $first
  | ((.[-1].vault_tree | map({(.path): .sha256}) | add) // {}) as $last
  | (($first + $last) | keys) as $paths
  | $paths[] | select(($first[.] // "absent") != ($last[.] // "absent"))
  | "  changed: " + .
' "${RUN_DIR}/snapshot-00-cold.json" "$(printf '%s/snapshot-%02d-restart.json' "${RUN_DIR}" "${RESTART_COUNT}")" \
  || info "  none"

# ---------------------------------------------------------------------------
log "Checking host exposure"
PUBLISHED="$(docker inspect --format '{{json .NetworkSettings.Ports}}' "${CID}")"
info "published ports: ${PUBLISHED}"
HOST_27200="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -X POST http://127.0.0.1:27200/mcp 2>/dev/null || echo "no-response")"
info "host 127.0.0.1:27200 -> ${HOST_27200} (a host Obsidian may answer here; the container publishes nothing)"

# ---------------------------------------------------------------------------
log "Writing the evidence summary"
LAST_SNAPSHOT="$(printf '%s/snapshot-%02d-restart.json' "${RUN_DIR}" "${RESTART_COUNT}")"

jq -n \
  --arg run_id "${RUN_ID}" \
  --arg project "${COMPOSE_PROJECT_NAME}" \
  --arg cold_seconds "${COLD_SECONDS}" \
  --argjson restarts "${RESTART_COUNT}" \
  --argjson drift "${DRIFT}" \
  --argjson published_ports "${PUBLISHED}" \
  --argjson cold "$(cat "${RUN_DIR}/snapshot-00-cold.json")" \
  --argjson last "$(cat "${LAST_SNAPSHOT}")" \
  '{
     run_id: $run_id,
     project: $project,
     cold_start_seconds: ($cold_seconds | tonumber),
     restarts: $restarts,
     managed_state_drifts: $drift,
     published_ports: $published_ports,
     acceptance: {
       cold_vault_opens:        ($cold.cli.vault_path | test("/vault")),
       cli_armed:               ($cold.cli.version | test("not enabled") | not),
       restricted_mode_off:     ($cold.cli.restricted_mode | ascii_downcase | test("off|false|disabled")),
       plugin_loaded:           ($cold.cli.enabled_community_plugins | test("mcp-tools-istefox")),
       artifacts_pinned:        ($cold.pinned_artifacts.plugin_main_sha256 == "9c1653b88c5eb49585e579909083a5f215b910cfdf1635936d4ca77a078b5484"
                                 and $cold.pinned_artifacts.plugin_manifest_sha256 == "e58f88727e56359266cc1dc235b13560578ba44023c4abfa229c0d8198444fca"),
       port_deterministic:      ($cold.listeners | map(select(test("27200"))) | length) == 1,
       secret_persisted:        $last.secret.token_matches_secret,
       data_json_locked_down:   ($cold.secret.data_json_mode == "600"),
       unauthenticated_401:     ($cold.mcp.status_unauthenticated == "401"),
       wrong_token_401:         ($cold.mcp.status_wrong_token == "401"),
       initialize_ok:           $cold.mcp.initialize.ok,
       tool_call_ok:            $cold.mcp.get_server_info.ok,
       restart_stable:          ($drift == 0),
       no_published_ports:      ($published_ports | length) == 0
     }
   }' > "${RUN_DIR}/evidence.json"

jq -r '.acceptance | to_entries[] | "  " + (if .value then "PASS" else "FAIL" end) + "  " + .key' "${RUN_DIR}/evidence.json"

FAILED="$(jq -r '[.acceptance | to_entries[] | select(.value == false)] | length' "${RUN_DIR}/evidence.json")"

# ---------------------------------------------------------------------------
if [ "${CLEANUP}" -eq 1 ]; then
  log "Cleaning up (explicitly requested)"
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
else
  log "Leaving the stack and volumes in place"
  info "tear down with: COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME} OBSIDIAN_MCP_TOKEN_FILE=${TOKEN_FILE} docker compose --project-directory ${HERE} -f ${HERE}/compose.yaml down --volumes"
fi

log "Evidence written to ${RUN_DIR}/evidence.json"
if [ "${FAILED}" -ne 0 ]; then
  printf '\n\033[1;31m%s acceptance criteria failed.\033[0m A reproducible negative result is a valid spike outcome — report it, do not paper over it.\n' "${FAILED}"
  exit 1
fi
printf '\n\033[1;32mAll acceptance criteria passed.\033[0m\n'
