#!/usr/bin/env bash
#
# Bridge topology evidence collector.
#
# Runs on the HOST and drives the two probe containers, printing one JSON
# object to stdout. The bearer token never crosses this boundary: probes read
# it from their own mounted secret via `probe-curl`, so nothing here — and
# nothing in the emitted evidence — carries a credential.

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

compose() {
  docker compose --project-directory "${HERE}" -f "${HERE}/compose.yaml" \
    --profile bridge --profile bridge-test "$@"
}

clean() { tr -d '\r'; }

MCP_HEADERS=(
  -H 'content-type: application/json'
  -H 'accept: application/json, text/event-stream'
)

INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"agent-runtime-bridge-spike","version":"0"}}}'

# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------

# Unauthenticated POST; prints the HTTP status ("000" when no response).
status_noauth() {
  local svc="$1" url="$2"; shift 2
  compose exec -T "${svc}" curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -X POST "${url}" "${MCP_HEADERS[@]}" "$@" \
    --data '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}' 2>/dev/null | clean || true
}

# Authenticated POST; prints the HTTP status.
status_auth() {
  local svc="$1" url="$2" body="$3"; shift 3
  compose exec -T "${svc}" probe-curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
    -X POST "${url}" "${MCP_HEADERS[@]}" "$@" \
    --data "${body}" 2>/dev/null | clean || true
}

# Authenticated POST; prints the response body.
body_auth() {
  local svc="$1" url="$2" body="$3"; shift 3
  compose exec -T "${svc}" probe-curl -s --max-time 20 \
    -X POST "${url}" "${MCP_HEADERS[@]}" "$@" \
    --data "${body}" 2>/dev/null | clean || true
}

# curl's own exit code, for the cases where there is no HTTP response at all.
curl_exit() {
  local svc="$1" url="$2"
  compose exec -T "${svc}" sh -c \
    "curl -s -o /dev/null --max-time 8 -X POST '${url}' >/dev/null 2>&1; echo \$?" 2>/dev/null | clean || echo "-1"
}

netns_of() {
  compose exec -T "$1" readlink /proc/self/ns/net 2>/dev/null | clean || true
}

# True when an SSE body carries the notification frame ahead of the terminal
# result. Order is the whole point: a buffering proxy can still deliver both,
# just not in time to be useful.
notification_precedes_result() {
  local txt="$1" n r
  n="$(printf '%s\n' "${txt}" | grep -n 'notifications/tools/list_changed' | head -n1 | cut -d: -f1)"
  r="$(printf '%s\n' "${txt}" | grep -n '"result"' | head -n1 | cut -d: -f1)"
  [ -n "${n}" ] && [ -n "${r}" ] && [ "${n}" -lt "${r}" ]
}

# ---------------------------------------------------------------------------
# 1-3. Reachability by topology
# ---------------------------------------------------------------------------
ORDINARY_DIRECT_EXIT="$(curl_exit probe-network http://obsidian:27200/mcp)"
ORDINARY_DIRECT_STATUS="$(status_noauth probe-network http://obsidian:27200/mcp)"

SHARED_DIRECT_NOAUTH="$(status_noauth probe-shared http://127.0.0.1:27200/mcp)"
SHARED_DIRECT_AUTH="$(body_auth probe-shared http://127.0.0.1:27200/mcp "${INIT_BODY}" -H 'mcp-protocol-version: 2025-11-25')"

BRIDGE_NOAUTH="$(status_noauth probe-network http://obsidian:8080/mcp)"
BRIDGE_AUTH="$(body_auth probe-network http://obsidian:8080/mcp "${INIT_BODY}" -H 'mcp-protocol-version: 2025-11-25')"

# 4. A real tool call, not just a handshake.
BRIDGE_TOOL="$(body_auth probe-network http://obsidian:8080/mcp \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_server_info","arguments":{}}}' \
  -H 'mcp-protocol-version: 2025-11-25')"

# ---------------------------------------------------------------------------
# 5-7. Header handling
# ---------------------------------------------------------------------------
# The plugin refuses a non-loopback Origin outright...
ORIGIN_DIRECT="$(status_auth probe-shared http://127.0.0.1:27200/mcp "${INIT_BODY}" -H 'origin: https://evil.example')"
# ...and the bridge strips it, so the same request succeeds through it.
ORIGIN_VIA_BRIDGE="$(status_auth probe-network http://obsidian:8080/mcp "${INIT_BODY}" -H 'origin: https://evil.example')"

# Authorization must pass through AND still fail closed.
WRONG_TOKEN_VIA_BRIDGE="$(compose exec -T probe-network curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -X POST http://obsidian:8080/mcp "${MCP_HEADERS[@]}" \
  -H 'authorization: Bearer not-the-right-token-but-long-enough-to-parse' \
  --data "${INIT_BODY}" 2>/dev/null | clean || true)"

# ---------------------------------------------------------------------------
# 8-10. Status and error-body fidelity
# ---------------------------------------------------------------------------
BAD_VERSION_STATUS="$(status_auth probe-network http://obsidian:8080/mcp \
  '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}' -H 'mcp-protocol-version: 1999-01-01')"
BAD_VERSION_BODY="$(body_auth probe-network http://obsidian:8080/mcp \
  '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}' -H 'mcp-protocol-version: 1999-01-01')"

GET_STATUS="$(compose exec -T probe-network curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  http://obsidian:8080/mcp 2>/dev/null | clean || true)"
UNKNOWN_PATH_STATUS="$(status_noauth probe-network http://obsidian:8080/not-mcp)"

# Oversize body, measured through BOTH paths: nginx's own cap is disabled in
# this spike so the plugin's 1 MiB gate is what should answer, and comparing
# the two is what would expose the bridge changing the outcome.
OVERSIZE_SNIPPET='printf "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/list\",\"params\":{\"pad\":\"" > /tmp/big.json; head -c 1200000 /dev/zero | tr "\\0" "a" >> /tmp/big.json; printf "\"}}" >> /tmp/big.json;'
OVERSIZE_VIA_BRIDGE="$(compose exec -T probe-network sh -c \
  "${OVERSIZE_SNIPPET} probe-curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST http://obsidian:8080/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data-binary @/tmp/big.json" 2>/dev/null | clean || true)"
OVERSIZE_DIRECT="$(compose exec -T probe-shared sh -c \
  "${OVERSIZE_SNIPPET} probe-curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST http://127.0.0.1:27200/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data-binary @/tmp/big.json" 2>/dev/null | clean || true)"

# ---------------------------------------------------------------------------
# 11. Legacy SSE — activate_tool emits a notification on its own response
# stream. Two DIFFERENT tools so each call is a genuine first activation:
# a repeat returns "already active" and never notifies.
# ---------------------------------------------------------------------------
ACTIVATE_VIA_BRIDGE="$(compose exec -T probe-network probe-curl -s -i --no-buffer --max-time 25 \
  -X POST http://obsidian:8080/mcp "${MCP_HEADERS[@]}" \
  --data '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"activate_tool","arguments":{"name":"find_broken_links","persist":false}}}' 2>/dev/null | clean || true)"

ACTIVATE_DIRECT="$(compose exec -T probe-shared probe-curl -s -i --no-buffer --max-time 25 \
  -X POST http://127.0.0.1:27200/mcp "${MCP_HEADERS[@]}" \
  --data '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"activate_tool","arguments":{"name":"find_orphaned_notes","persist":false}}}' 2>/dev/null | clean || true)"

# ---------------------------------------------------------------------------
# 12. Modern subscriptions/listen — a deliberately long-lived stream. Its
# acknowledgement frame is small and arrives immediately; the stream then
# stays open until the client's own timeout. A buffering proxy would withhold
# that frame, so receiving it inside the timeout IS the unbuffered proof.
# ---------------------------------------------------------------------------
LISTEN_BODY='{"jsonrpc":"2.0","id":100,"method":"subscriptions/listen","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}},"notifications":{"toolsListChanged":true}}}'
LISTEN_HEADERS=(-H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: subscriptions/listen')

LISTEN_VIA_BRIDGE="$(compose exec -T probe-network probe-curl -s --no-buffer --max-time 6 \
  -X POST http://obsidian:8080/mcp "${MCP_HEADERS[@]}" "${LISTEN_HEADERS[@]}" \
  --data "${LISTEN_BODY}" 2>/dev/null | clean || true)"

LISTEN_DIRECT="$(compose exec -T probe-shared probe-curl -s --no-buffer --max-time 6 \
  -X POST http://127.0.0.1:27200/mcp "${MCP_HEADERS[@]}" "${LISTEN_HEADERS[@]}" \
  --data "${LISTEN_BODY}" 2>/dev/null | clean || true)"

# ---------------------------------------------------------------------------
# 15. Isolation
# ---------------------------------------------------------------------------
NS_OBSIDIAN="$(netns_of obsidian)"
NS_BRIDGE="$(netns_of mcp-bridge)"
NS_PROBE_SHARED="$(netns_of probe-shared)"
NS_PROBE_NETWORK="$(netns_of probe-network)"

BRIDGE_CID="$(compose ps -q mcp-bridge 2>/dev/null | head -n1 | clean || true)"
OBSIDIAN_CID="$(compose ps -q obsidian 2>/dev/null | head -n1 | clean || true)"

BRIDGE_PORTS='{}'
BRIDGE_MOUNTS='[]'
if [ -n "${BRIDGE_CID}" ]; then
  BRIDGE_PORTS="$(docker inspect --format '{{json .NetworkSettings.Ports}}' "${BRIDGE_CID}" 2>/dev/null || echo '{}')"
  BRIDGE_MOUNTS="$(docker inspect --format '{{json .Mounts}}' "${BRIDGE_CID}" 2>/dev/null | jq -c '[.[] | .Destination]' 2>/dev/null || echo '[]')"
fi
OBSIDIAN_PORTS='{}'
if [ -n "${OBSIDIAN_CID}" ]; then
  OBSIDIAN_PORTS="$(docker inspect --format '{{json .NetworkSettings.Ports}}' "${OBSIDIAN_CID}" 2>/dev/null || echo '{}')"
fi

# ---------------------------------------------------------------------------
# Assemble
# ---------------------------------------------------------------------------
bool() { if "$@"; then echo true; else echo false; fi; }

jq -n \
  --arg collected_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg ordinary_direct_exit "${ORDINARY_DIRECT_EXIT}" \
  --arg ordinary_direct_status "${ORDINARY_DIRECT_STATUS}" \
  --arg shared_direct_noauth "${SHARED_DIRECT_NOAUTH}" \
  --argjson shared_direct_auth_ok "$(bool test -n "$(printf '%s' "${SHARED_DIRECT_AUTH}" | jq -r '.result.serverInfo.name // empty' 2>/dev/null)")" \
  --arg bridge_noauth "${BRIDGE_NOAUTH}" \
  --argjson bridge_auth_ok "$(bool test -n "$(printf '%s' "${BRIDGE_AUTH}" | jq -r '.result.serverInfo.name // empty' 2>/dev/null)")" \
  --arg bridge_server_name "$(printf '%s' "${BRIDGE_AUTH}" | jq -r '.result.serverInfo.name // "-"' 2>/dev/null)" \
  --argjson bridge_tool_ok "$(bool test -n "$(printf '%s' "${BRIDGE_TOOL}" | jq -r '.result.content[0].text // empty' 2>/dev/null)")" \
  --arg origin_direct "${ORIGIN_DIRECT}" \
  --arg origin_via_bridge "${ORIGIN_VIA_BRIDGE}" \
  --arg wrong_token_via_bridge "${WRONG_TOKEN_VIA_BRIDGE}" \
  --arg bad_version_status "${BAD_VERSION_STATUS}" \
  --arg bad_version_rpc_code "$(printf '%s' "${BAD_VERSION_BODY}" | jq -r '.error.code // "none"' 2>/dev/null)" \
  --arg get_status "${GET_STATUS}" \
  --arg unknown_path_status "${UNKNOWN_PATH_STATUS}" \
  --arg oversize_via_bridge "${OVERSIZE_VIA_BRIDGE}" \
  --arg oversize_direct "${OVERSIZE_DIRECT}" \
  --argjson activate_bridge_is_sse "$(bool grep -qi 'content-type: text/event-stream' <<<"${ACTIVATE_VIA_BRIDGE}")" \
  --argjson activate_bridge_order_ok "$(bool notification_precedes_result "${ACTIVATE_VIA_BRIDGE}")" \
  --argjson activate_direct_is_sse "$(bool grep -qi 'content-type: text/event-stream' <<<"${ACTIVATE_DIRECT}")" \
  --argjson activate_direct_order_ok "$(bool notification_precedes_result "${ACTIVATE_DIRECT}")" \
  --argjson listen_bridge_ack "$(bool grep -q 'notifications/subscriptions/acknowledged' <<<"${LISTEN_VIA_BRIDGE}")" \
  --argjson listen_direct_ack "$(bool grep -q 'notifications/subscriptions/acknowledged' <<<"${LISTEN_DIRECT}")" \
  --arg ns_obsidian "${NS_OBSIDIAN}" \
  --arg ns_bridge "${NS_BRIDGE}" \
  --arg ns_probe_shared "${NS_PROBE_SHARED}" \
  --arg ns_probe_network "${NS_PROBE_NETWORK}" \
  --argjson bridge_ports "${BRIDGE_PORTS}" \
  --argjson obsidian_ports "${OBSIDIAN_PORTS}" \
  --argjson bridge_mounts "${BRIDGE_MOUNTS}" \
  '{
     collected_at: $collected_at,
     reachability: {
       ordinary_network_to_plugin_port: {
         curl_exit: $ordinary_direct_exit,
         http_status: $ordinary_direct_status
       },
       shared_netns_direct: {
         unauthenticated: $shared_direct_noauth,
         authenticated_initialize_ok: $shared_direct_auth_ok
       },
       via_bridge: {
         unauthenticated: $bridge_noauth,
         authenticated_initialize_ok: $bridge_auth_ok,
         server_name: $bridge_server_name,
         tool_call_ok: $bridge_tool_ok
       }
     },
     headers: {
       non_loopback_origin_direct: $origin_direct,
       non_loopback_origin_via_bridge: $origin_via_bridge,
       wrong_token_via_bridge: $wrong_token_via_bridge
     },
     status_fidelity: {
       unsupported_protocol_version: { status: $bad_version_status, jsonrpc_code: $bad_version_rpc_code },
       get_method: $get_status,
       unknown_path: $unknown_path_status,
       oversize_body_via_bridge: $oversize_via_bridge,
       oversize_body_direct: $oversize_direct
     },
     streaming: {
       activate_tool_via_bridge: { is_sse: $activate_bridge_is_sse, notification_before_result: $activate_bridge_order_ok },
       activate_tool_direct: { is_sse: $activate_direct_is_sse, notification_before_result: $activate_direct_order_ok },
       listen_ack_via_bridge: $listen_bridge_ack,
       listen_ack_direct: $listen_direct_ack
     },
     isolation: {
       netns: {
         obsidian: $ns_obsidian,
         mcp_bridge: $ns_bridge,
         probe_shared: $ns_probe_shared,
         probe_network: $ns_probe_network
       },
       bridge_shares_obsidian_netns: ($ns_bridge != "" and $ns_bridge == $ns_obsidian),
       probe_network_is_isolated: ($ns_probe_network != "" and $ns_probe_network != $ns_obsidian),
       obsidian_published_ports: $obsidian_ports,
       bridge_published_ports: $bridge_ports,
       bridge_mount_destinations: $bridge_mounts,
       bridge_holds_no_secret: ($bridge_mounts | map(select(test("secret"))) | length) == 0
     }
   }'
