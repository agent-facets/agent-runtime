#!/usr/bin/env bash
#
# Loopback bridge topology driver.
#
# Answers, separately: is network mediation required, does it need its own
# container, and does it need custom code. Always runs against a FRESH
# isolated project — the SSE test depends on a tool being genuinely inactive,
# which is only true on a first activation.
#
#   ./verify-bridge.sh
#   ./verify-bridge.sh --cleanup
#
# Volumes are preserved unless --cleanup is passed.

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"

CLEANUP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cleanup) CLEANUP=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

RUN_ID="${RUN_ID:-bridge-$(date -u +%Y%m%dT%H%M%SZ)}"
RUN_DIR="${REPO_ROOT}/tmp/spikes/obsidian/${RUN_ID}"
mkdir -p "${RUN_DIR}"

SUFFIX="$(printf '%s' "${RUN_ID}" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]' | tail -c 12)"
export COMPOSE_PROJECT_NAME="agent-runtime-obsidian-bridge-${SUFFIX}"
export OBSIDIAN_VAULT_VOLUME="agent-runtime-obsidian-bridge-vault-${SUFFIX}"
export OBSIDIAN_PROFILE_VOLUME="agent-runtime-obsidian-bridge-profile-${SUFFIX}"
export OBSIDIAN_NETWORK="agent-runtime-obsidian-bridge-net-${SUFFIX}"
export APP_UID="${APP_UID:-$(id -u)}"
export APP_GID="${APP_GID:-$(id -g)}"

# `core` leaves non-core tools inactive, so activate_tool is a real state
# change and the plugin answers over SSE with a notification frame.
export OBSIDIAN_TOOL_PROFILE=core

log()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
fail() { printf '\n\033[1;31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

compose() {
  docker compose --project-directory "${HERE}" -f "${HERE}/compose.yaml" \
    --profile bridge --profile bridge-test "$@"
}

# ---------------------------------------------------------------------------
log "Bridge run ${RUN_ID}"
info "project   ${COMPOSE_PROJECT_NAME}"
info "evidence  ${RUN_DIR}"

log "Generating the bearer token"
TOKEN_FILE="${RUN_DIR}/mcp-token"
( umask 077; head -c 32 /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_' > "${TOKEN_FILE}" )
chmod 600 "${TOKEN_FILE}"
export OBSIDIAN_MCP_TOKEN_FILE="${TOKEN_FILE}"
info "wrote $(wc -c < "${TOKEN_FILE}") bytes, mode $(stat -c '%a' "${TOKEN_FILE}") (value never printed)"

log "Building"
compose build 2>&1 | tee "${RUN_DIR}/build.log" | tail -n 5

log "Starting obsidian + bridge + probes"
compose up -d 2>&1 | tee "${RUN_DIR}/up.log" | tail -n 15

wait_healthy() {
  local svc="$1" label="$2" deadline=$(( SECONDS + ${3:-240} )) cid status=""
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    cid="$(compose ps -q "${svc}" 2>/dev/null | head -n1 || true)"
    if [ -n "${cid}" ]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' "${cid}" 2>/dev/null || echo missing)"
      [ "${status}" = "healthy" ] && { info "${label}: healthy"; return 0; }
      if [ "${status}" = "nohealth" ] && [ "$(docker inspect --format '{{.State.Running}}' "${cid}")" = "true" ]; then
        info "${label}: running (no healthcheck)"; return 0
      fi
    fi
    sleep 3
  done
  docker logs "${cid:-}" > "${RUN_DIR}/${label}-timeout.log" 2>&1 || true
  fail "${label} never became healthy (last status: ${status:-unknown})"
}

wait_healthy obsidian obsidian 300
wait_healthy mcp-bridge bridge 120
wait_healthy probe-network probe-network 60
wait_healthy probe-shared probe-shared 60

docker logs "$(compose ps -q obsidian)" > "${RUN_DIR}/obsidian.log" 2>&1 || true
docker logs "$(compose ps -q mcp-bridge)" > "${RUN_DIR}/bridge.log" 2>&1 || true

# ---------------------------------------------------------------------------
log "Collecting topology evidence"
"${HERE}/collect-bridge-evidence.sh" > "${RUN_DIR}/topology.json" 2>"${RUN_DIR}/topology.err" \
  || fail "evidence collection failed; see ${RUN_DIR}/topology.err"
jq -e '.' "${RUN_DIR}/topology.json" >/dev/null || fail "topology.json is not valid JSON"

jq -r '
  "  ordinary network -> obsidian:27200 : curl exit " + .reachability.ordinary_network_to_plugin_port.curl_exit
    + " (http " + .reachability.ordinary_network_to_plugin_port.http_status + ")",
  "  shared netns     -> 127.0.0.1:27200: " + .reachability.shared_netns_direct.unauthenticated
    + " unauth, initialize " + (.reachability.shared_netns_direct.authenticated_initialize_ok | tostring),
  "  ordinary network -> bridge:8080    : " + .reachability.via_bridge.unauthenticated
    + " unauth, initialize " + (.reachability.via_bridge.authenticated_initialize_ok | tostring)
    + ", tool call " + (.reachability.via_bridge.tool_call_ok | tostring),
  "  origin direct / via bridge         : " + .headers.non_loopback_origin_direct + " / " + .headers.non_loopback_origin_via_bridge,
  "  wrong token via bridge             : " + .headers.wrong_token_via_bridge,
  "  bad protocol version               : " + .status_fidelity.unsupported_protocol_version.status
    + " rpc " + .status_fidelity.unsupported_protocol_version.jsonrpc_code,
  "  GET / unknown path                 : " + .status_fidelity.get_method + " / " + .status_fidelity.unknown_path,
  "  oversize body bridge / direct      : " + .status_fidelity.oversize_body_via_bridge + " / " + .status_fidelity.oversize_body_direct,
  "  activate_tool SSE via bridge       : sse " + (.streaming.activate_tool_via_bridge.is_sse | tostring)
    + ", order " + (.streaming.activate_tool_via_bridge.notification_before_result | tostring),
  "  listen ack bridge / direct         : " + (.streaming.listen_ack_via_bridge | tostring) + " / " + (.streaming.listen_ack_direct | tostring),
  "  bridge shares obsidian netns       : " + (.isolation.bridge_shares_obsidian_netns | tostring),
  "  bridge holds no secret             : " + (.isolation.bridge_holds_no_secret | tostring)
' "${RUN_DIR}/topology.json"

# ---------------------------------------------------------------------------
log "Lifecycle: ordinary restart of the donor container"
compose restart obsidian >/dev/null 2>&1 || fail "restart failed"
wait_healthy obsidian "obsidian-after-restart" 180

BRIDGE_AFTER_RESTART="$(compose exec -T probe-network curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
  -X POST http://obsidian:8080/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}' 2>/dev/null | tr -d '\r' || true)"
info "bridge after donor restart: ${BRIDGE_AFTER_RESTART} (401 = still routing)"

# ---------------------------------------------------------------------------
log "Lifecycle: force-recreate of the donor container"
# The bridge's namespace belongs to the OLD container. Recreating the donor
# invalidates it, and `depends_on.restart: true` is what is supposed to heal
# the sidecar. Whether it actually does is the thing being measured.
compose up -d --force-recreate obsidian > "${RUN_DIR}/recreate.log" 2>&1 || true
sleep 5
BRIDGE_CID_AFTER="$(compose ps -q mcp-bridge 2>/dev/null | head -n1 || true)"
BRIDGE_STATE_AFTER="$(if [ -n "${BRIDGE_CID_AFTER}" ]; then docker inspect --format '{{.State.Status}}' "${BRIDGE_CID_AFTER}" 2>/dev/null; else echo "gone"; fi)"
info "bridge container state right after recreate: ${BRIDGE_STATE_AFTER}"

wait_healthy obsidian "obsidian-after-recreate" 300

# Bring the whole stack back to its declared state, which is the ordinary
# operator action after a recreate.
compose up -d >> "${RUN_DIR}/recreate.log" 2>&1 || true
wait_healthy mcp-bridge "bridge-after-recreate" 180

BRIDGE_AFTER_RECREATE="$(compose exec -T probe-network curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
  -X POST http://obsidian:8080/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}' 2>/dev/null | tr -d '\r' || true)"
info "bridge after donor recreate + up: ${BRIDGE_AFTER_RECREATE} (401 = routing restored)"

# ---------------------------------------------------------------------------
log "Writing the evidence summary"
jq -n \
  --arg run_id "${RUN_ID}" \
  --arg project "${COMPOSE_PROJECT_NAME}" \
  --arg after_restart "${BRIDGE_AFTER_RESTART}" \
  --arg after_recreate "${BRIDGE_AFTER_RECREATE}" \
  --arg bridge_state_after_recreate "${BRIDGE_STATE_AFTER}" \
  --argjson t "$(cat "${RUN_DIR}/topology.json")" \
  '{
     run_id: $run_id,
     project: $project,
     topology: $t,
     lifecycle: {
       bridge_after_donor_restart: $after_restart,
       bridge_container_state_right_after_recreate: $bridge_state_after_recreate,
       bridge_after_donor_recreate: $after_recreate
     },
     acceptance: {
       mediation_is_required:        ($t.reachability.ordinary_network_to_plugin_port.http_status == "000"),
       shared_netns_reaches_plugin:  ($t.reachability.shared_netns_direct.unauthenticated == "401" and $t.reachability.shared_netns_direct.authenticated_initialize_ok),
       bridge_reaches_plugin:        ($t.reachability.via_bridge.unauthenticated == "401" and $t.reachability.via_bridge.authenticated_initialize_ok),
       bridge_serves_tool_calls:     $t.reachability.via_bridge.tool_call_ok,
       origin_rejected_direct:       ($t.headers.non_loopback_origin_direct == "403"),
       origin_neutralised_by_bridge: ($t.headers.non_loopback_origin_via_bridge == "200"),
       auth_fails_closed_via_bridge: ($t.headers.wrong_token_via_bridge == "401"),
       protocol_error_preserved:     ($t.status_fidelity.unsupported_protocol_version.status == "400" and $t.status_fidelity.unsupported_protocol_version.jsonrpc_code == "-32020"),
       method_error_preserved:       ($t.status_fidelity.get_method == "405"),
       path_error_preserved:         ($t.status_fidelity.unknown_path == "404"),
       oversize_matches_direct:      ($t.status_fidelity.oversize_body_via_bridge == $t.status_fidelity.oversize_body_direct),
       sse_framing_preserved:        ($t.streaming.activate_tool_via_bridge.is_sse and $t.streaming.activate_tool_via_bridge.notification_before_result),
       sse_unbuffered:               $t.streaming.listen_ack_via_bridge,
       bridge_shares_donor_netns:    $t.isolation.bridge_shares_obsidian_netns,
       probe_network_isolated:       $t.isolation.probe_network_is_isolated,
       no_published_ports:           (($t.isolation.obsidian_published_ports | length) == 0 and ($t.isolation.bridge_published_ports | length) == 0),
       bridge_holds_no_secret:       $t.isolation.bridge_holds_no_secret,
       survives_donor_restart:       ($after_restart == "401"),
       recovers_after_donor_recreate: ($after_recreate == "401")
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
  info "tear down with: COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME} OBSIDIAN_MCP_TOKEN_FILE=${TOKEN_FILE} OBSIDIAN_VAULT_VOLUME=${OBSIDIAN_VAULT_VOLUME} OBSIDIAN_PROFILE_VOLUME=${OBSIDIAN_PROFILE_VOLUME} OBSIDIAN_NETWORK=${OBSIDIAN_NETWORK} docker compose --project-directory ${HERE} -f ${HERE}/compose.yaml --profile bridge --profile bridge-test down --volumes"
fi

log "Evidence written to ${RUN_DIR}/evidence.json"
if [ "${FAILED}" -ne 0 ]; then
  printf '\n\033[1;31m%s checks failed.\033[0m A reproducible negative result is a valid spike outcome — report it, do not paper over it.\n' "${FAILED}"
  exit 1
fi
printf '\n\033[1;32mAll bridge checks passed.\033[0m\n'
