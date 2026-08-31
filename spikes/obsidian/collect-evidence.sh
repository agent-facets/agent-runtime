#!/usr/bin/env bash
#
# Evidence collector. Runs INSIDE the container and prints one JSON object to
# stdout. Everything it emits is sanitized: secrets are compared by digest and
# never reproduced, and no response header is echoed.

set -Eeuo pipefail

VAULT_PATH="${OBSIDIAN_VAULT_PATH:-/vault}"
CONFIG_DIR="${OBSIDIAN_CONFIG_DIR:-${HOME}/.config/obsidian}"
MCP_PORT="${OBSIDIAN_MCP_PORT:-27200}"
PLUGIN_ID="${OBSIDIAN_PLUGIN_ID:-mcp-tools-istefox}"
TOKEN_FILE="${OBSIDIAN_TOKEN_FILE:-/run/secrets/obsidian_mcp_token}"
OBSIDIAN_CLI=/opt/Obsidian/obsidian-cli
PLUGIN_DIR="${VAULT_PATH}/.obsidian/plugins/${PLUGIN_ID}"

cli() { "${OBSIDIAN_CLI}" "$@" 2>&1 || true; }

sha_of_file() { [ -f "$1" ] && sha256sum "$1" | cut -d' ' -f1 || printf 'absent'; }
mode_of()     { [ -e "$1" ] && stat -c '%a' "$1" || printf 'absent'; }

# --- authenticated request helper -------------------------------------------
# The credential goes into a 0600 curl config file, never into argv.
CURL_CFG="$(mktemp)"; chmod 600 "${CURL_CFG}"
printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '\n' < "${TOKEN_FILE}")" > "${CURL_CFG}"
cleanup() { rm -f "${CURL_CFG}"; }
trap cleanup EXIT

mcp_auth() {
  curl -s --max-time 20 --config "${CURL_CFG}" \
    -X POST "http://127.0.0.1:${MCP_PORT}/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H 'mcp-protocol-version: 2025-11-25' \
    --data "$1" 2>/dev/null || true
}

mcp_status_noauth() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
    -X POST "http://127.0.0.1:${MCP_PORT}/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}' 2>/dev/null || true
}

mcp_status_badauth() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
    -X POST "http://127.0.0.1:${MCP_PORT}/mcp" \
    -H 'authorization: Bearer not-the-right-token-but-long-enough-to-parse' \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}' 2>/dev/null || true
}

# --- probes -----------------------------------------------------------------
STATUS_NOAUTH="$(mcp_status_noauth)"
STATUS_BADAUTH="$(mcp_status_badauth)"

INIT_BODY="$(mcp_auth '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"agent-runtime-spike","version":"0"}}}')"
TOOLS_BODY="$(mcp_auth '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_server_info","arguments":{}}}')"

# --- token identity ---------------------------------------------------------
# Compare digests, never values.
SECRET_SHA="$(tr -d '\n' < "${TOKEN_FILE}" | sha256sum | cut -d' ' -f1)"
STORED_SHA="$(jq -r '.mcpTransport.bearerToken // ""' "${PLUGIN_DIR}/data.json" 2>/dev/null | tr -d '\n' | sha256sum | cut -d' ' -f1)"
TOKEN_MATCHES=false
[ "${SECRET_SHA}" = "${STORED_SHA}" ] && TOKEN_MATCHES=true

# --- normalized plugin settings ---------------------------------------------
# Redact secrets; drop per-request counters that legitimately move.
DATA_NORMALIZED="$(jq -S '
  (. // {})
  | .mcpTransport = ((.mcpTransport // {})
      | del(.eraCounters, .eraCountersByToken)
      | .bearerToken = (if .bearerToken then "<redacted>" else null end)
      | .tokens = [ (.tokens // [])[] | .token = "<redacted>" ])
' "${PLUGIN_DIR}/data.json" 2>/dev/null || echo 'null')"

OBSIDIAN_JSON_CONTENT="$(jq -S '.' "${CONFIG_DIR}/obsidian.json" 2>/dev/null || echo 'null')"
COMMUNITY_PLUGINS="$(jq -S '.' "${VAULT_PATH}/.obsidian/community-plugins.json" 2>/dev/null || echo 'null')"

# --- vault tree -------------------------------------------------------------
VAULT_TREE="$(
  cd "${VAULT_PATH}" 2>/dev/null && find .obsidian -type f 2>/dev/null | LC_ALL=C sort | while read -r f; do
    printf '%s\t%s\t%s\n' "${f}" "$(sha256sum "${f}" | cut -d' ' -f1)" "$(stat -c '%a' "${f}")"
  done | jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t") | {path: .[0], sha256: .[1], mode: .[2]})'
)"

# --- listeners --------------------------------------------------------------
LISTENERS="$(ss -H -tln 2>/dev/null | awk '{print $4}' | LC_ALL=C sort -u \
  | jq -R -s -c 'split("\n") | map(select(length > 0))')"

# --- process ----------------------------------------------------------------
OBSIDIAN_PROC="$(ps -o user=,uid=,args= -C obsidian 2>/dev/null | head -n 1 | sed 's/[[:space:]]\+/ /g' | sed 's/^ //' || true)"

# --- CLI state --------------------------------------------------------------
CLI_VERSION="$(cli version)"
CLI_VAULT="$(cli vault info=path)"
CLI_RESTRICT="$(cli plugins:restrict)"
CLI_ENABLED="$(cli plugins:enabled filter=community versions)"

jq -n \
  --arg collected_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg container_uid "$(id -u)" \
  --arg container_user "$(id -un)" \
  --arg cli_version "${CLI_VERSION}" \
  --arg cli_vault "${CLI_VAULT}" \
  --arg cli_restrict "${CLI_RESTRICT}" \
  --arg cli_enabled "${CLI_ENABLED}" \
  --arg status_noauth "${STATUS_NOAUTH}" \
  --arg status_badauth "${STATUS_BADAUTH}" \
  --argjson init_body "$(printf '%s' "${INIT_BODY}" | jq -c '.' 2>/dev/null || echo 'null')" \
  --argjson tools_body "$(printf '%s' "${TOOLS_BODY}" | jq -c '.' 2>/dev/null || echo 'null')" \
  --argjson token_matches "${TOKEN_MATCHES}" \
  --arg plugin_main_sha "$(sha_of_file "${PLUGIN_DIR}/main.js")" \
  --arg plugin_manifest_sha "$(sha_of_file "${PLUGIN_DIR}/manifest.json")" \
  --arg data_json_mode "$(mode_of "${PLUGIN_DIR}/data.json")" \
  --argjson data_normalized "${DATA_NORMALIZED}" \
  --argjson obsidian_json "${OBSIDIAN_JSON_CONTENT}" \
  --argjson community_plugins "${COMMUNITY_PLUGINS}" \
  --argjson vault_tree "${VAULT_TREE}" \
  --argjson listeners "${LISTENERS}" \
  --arg obsidian_proc "${OBSIDIAN_PROC}" \
  '{
     collected_at: $collected_at,
     container: { uid: $container_uid, user: $container_user, obsidian_process: $obsidian_proc },
     cli: {
       version: $cli_version,
       vault_path: $cli_vault,
       restricted_mode: $cli_restrict,
       enabled_community_plugins: $cli_enabled
     },
     mcp: {
       status_unauthenticated: $status_noauth,
       status_wrong_token: $status_badauth,
       initialize: {
         ok: ($init_body != null and ($init_body.result.serverInfo.name? != null)),
         server_name: $init_body.result.serverInfo.name?,
         server_version: $init_body.result.serverInfo.version?,
         protocol_version: $init_body.result.protocolVersion?
       },
       get_server_info: {
         ok: ($tools_body != null and ($tools_body.result? != null) and ($tools_body.result.isError? != true)),
         error: $tools_body.error?
       }
     },
     secret: { token_matches_secret: $token_matches, data_json_mode: $data_json_mode },
     pinned_artifacts: { plugin_main_sha256: $plugin_main_sha, plugin_manifest_sha256: $plugin_manifest_sha },
     managed_state: {
       obsidian_json: $obsidian_json,
       community_plugins: $community_plugins,
       plugin_data_normalized: $data_normalized
     },
     vault_tree: $vault_tree,
     listeners: $listeners
   }'
