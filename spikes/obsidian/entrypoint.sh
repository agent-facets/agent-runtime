#!/usr/bin/env bash
#
# Deterministic headless Obsidian bootstrap.
#
# Every step is a converger, not an installer: re-running it against an
# already-bootstrapped vault must change nothing. The script fails loudly
# rather than degrading — a half-configured MCP endpoint is worse than a
# container that refuses to start.
#
# The bearer token is read straight from the mounted secret file into jq via
# --rawfile. It never passes through argv or the environment, so it cannot be
# recovered from /proc, `docker inspect`, or this script's own logs.

set -Eeuo pipefail

VAULT_PATH="${OBSIDIAN_VAULT_PATH:-/vault}"
CONFIG_DIR="${OBSIDIAN_CONFIG_DIR:-${HOME}/.config/obsidian}"
VAULT_ID="${OBSIDIAN_VAULT_ID:-a9e1d4c30b7f6285}"
MCP_PORT="${OBSIDIAN_MCP_PORT:-27200}"
PLUGIN_ID="${OBSIDIAN_PLUGIN_ID:-mcp-tools-istefox}"
PLUGIN_STAGE="${OBSIDIAN_PLUGIN_STAGE:-/opt/obsidian-plugins}"
TOKEN_FILE="${OBSIDIAN_TOKEN_FILE:-/run/secrets/obsidian_mcp_token}"
STARTUP_TIMEOUT="${OBSIDIAN_STARTUP_TIMEOUT:-180}"
TOKEN_LABEL="${OBSIDIAN_TOKEN_LABEL:-agent-runtime-spike}"
TOKEN_ID="${OBSIDIAN_TOKEN_ID:-default}"
# Empty = leave the plugin's own default (`all`) alone. The bridge spike sets
# `core` so a non-core tool starts inactive and activate_tool is a real state
# change rather than an "already active" early return.
TOOL_PROFILE="${OBSIDIAN_TOOL_PROFILE:-}"

OBSIDIAN_BIN=/opt/Obsidian/obsidian
OBSIDIAN_CLI=/opt/Obsidian/obsidian-cli
PLUGIN_DIR="${VAULT_PATH}/.obsidian/plugins/${PLUGIN_ID}"
OBSIDIAN_JSON="${CONFIG_DIR}/obsidian.json"

XVFB_PID=""
OBSIDIAN_PID=""
CLI_SOCKET=""

log()  { printf '[entrypoint] %s\n' "$*" >&2; }
fail() { printf '[entrypoint] FATAL: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Shutdown
# ---------------------------------------------------------------------------
shutdown() {
  local code=$?
  trap - TERM INT EXIT
  [ -n "${OBSIDIAN_PID}" ] && kill -TERM "${OBSIDIAN_PID}" 2>/dev/null || true
  [ -n "${OBSIDIAN_PID}" ] && wait "${OBSIDIAN_PID}" 2>/dev/null || true
  [ -n "${XVFB_PID}" ] && kill -TERM "${XVFB_PID}" 2>/dev/null || true
  [ -n "${XVFB_PID}" ] && wait "${XVFB_PID}" 2>/dev/null || true
  rm -f "/tmp/.X11-unix/X${DISPLAY#:}" "/tmp/.X${DISPLAY#:}-lock" 2>/dev/null || true
  exit "${code}"
}
trap shutdown TERM INT EXIT

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
preflight() {
  log "preflight"

  [ -d "${VAULT_PATH}" ] || fail "vault path ${VAULT_PATH} does not exist"
  [ -w "${VAULT_PATH}" ] || fail "vault path ${VAULT_PATH} is not writable by uid $(id -u); the named volume is owned by someone else"

  mkdir -p "${CONFIG_DIR}"
  [ -w "${CONFIG_DIR}" ] || fail "config dir ${CONFIG_DIR} is not writable by uid $(id -u)"

  [ -r "${TOKEN_FILE}" ] || fail "token secret ${TOKEN_FILE} is missing or unreadable"

  # The plugin silently discards a secret shorter than 32 bytes and mints a
  # random one instead, which surfaces later as an unexplained 401.
  local bytes
  bytes="$(tr -d '\n' < "${TOKEN_FILE}" | wc -c)"
  [ "${bytes}" -ge 32 ] || fail "token secret is ${bytes} bytes; the plugin requires at least 32"
  log "token secret accepted (${bytes} bytes, value never logged)"

  [ -x "${OBSIDIAN_BIN}" ] || fail "missing ${OBSIDIAN_BIN}"
  [ -x "${OBSIDIAN_CLI}" ] || fail "missing ${OBSIDIAN_CLI}"

  mkdir -p "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  chmod 700 "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" 2>/dev/null || true
}

# Write $2 to $1 atomically, with mode $3, only when the SEMANTIC content
# differs. Comparison is canonical (sorted, compact) rather than textual:
# Obsidian and the plugin both rewrite their JSON in a compact form at
# runtime, so a byte comparison against our pretty-printed output would
# report a diff on every boot and the converger would never be idempotent.
write_json_if_changed() {
  local target="$1" content="$2" mode="${3:-0644}"
  local current next

  next="$(printf '%s' "${content}" | jq -S -c '.')" || fail "refusing to write invalid JSON to ${target}"

  if [ -f "${target}" ]; then
    current="$(jq -S -c '.' "${target}" 2>/dev/null || printf '<unparseable>')"
    [ "${current}" = "${next}" ] && return 1
  fi

  local tmp
  tmp="$(mktemp "${target}.XXXXXX")"
  printf '%s\n' "${content}" > "${tmp}"
  chmod "${mode}" "${tmp}"
  mv -f "${tmp}" "${target}"
  return 0
}

# ---------------------------------------------------------------------------
# 2. Vault registry + CLI arming
# ---------------------------------------------------------------------------
converge_obsidian_json() {
  log "converging ${OBSIDIAN_JSON}"

  local existing='{}'
  [ -f "${OBSIDIAN_JSON}" ] && existing="$(cat "${OBSIDIAN_JSON}")"

  # `cli: true` is the load-bearing hypothesis of this spike. Obsidian
  # documents the CLI as a GUI toggle under Settings -> General and does not
  # document a file-driven equivalent. If it does not arm the socket, the
  # spike reports that as a failed architectural assumption rather than
  # reaching into Chromium's LevelDB.
  local next
  next="$(printf '%s' "${existing}" | jq -S \
    --arg id "${VAULT_ID}" \
    --arg path "${VAULT_PATH}" '
      (. // {})
      | .vaults = ((.vaults // {}) | .[$id] = ((.[$id] // {})
          | .path = $path
          | .ts = (.ts // 1700000000000)
          | .open = true))
      | .cli = true
    ')"

  if write_json_if_changed "${OBSIDIAN_JSON}" "${next}" 0644; then
    log "obsidian.json updated (vault ${VAULT_ID} -> ${VAULT_PATH}, cli enabled)"
  else
    log "obsidian.json already converged"
  fi
}

# ---------------------------------------------------------------------------
# 3. Vault-side plugin state
# ---------------------------------------------------------------------------
converge_plugin_list() {
  local file="${VAULT_PATH}/.obsidian/community-plugins.json"
  mkdir -p "${VAULT_PATH}/.obsidian"

  local current='[]'
  if [ -f "${file}" ]; then
    current="$(jq -c 'if type == "array" then . else [] end' "${file}" 2>/dev/null || echo '[]')"
  fi

  # Union, never overwrite: another plugin listed here must survive.
  local next
  next="$(printf '%s' "${current}" | jq -S --arg id "${PLUGIN_ID}" '
    if index($id) then . else . + [$id] end
  ')"

  if write_json_if_changed "${file}" "${next}" 0644; then
    log "community-plugins.json now lists ${PLUGIN_ID}"
  else
    log "community-plugins.json already converged"
  fi
}

converge_plugin_files() {
  local stage="${PLUGIN_STAGE}/${PLUGIN_ID}"
  [ -d "${stage}" ] || fail "staged plugin missing at ${stage}"
  mkdir -p "${PLUGIN_DIR}"

  local f staged installed
  for f in main.js manifest.json; do
    staged="$(sha256sum "${stage}/${f}" | cut -d' ' -f1)"
    installed=""
    [ -f "${PLUGIN_DIR}/${f}" ] && installed="$(sha256sum "${PLUGIN_DIR}/${f}" | cut -d' ' -f1)"
    if [ "${staged}" != "${installed}" ]; then
      cp -f "${stage}/${f}" "${PLUGIN_DIR}/${f}.tmp"
      chmod 0644 "${PLUGIN_DIR}/${f}.tmp"
      mv -f "${PLUGIN_DIR}/${f}.tmp" "${PLUGIN_DIR}/${f}"
      log "synced ${f} (${staged})"
    else
      log "${f} already at pinned hash"
    fi
  done
}

converge_plugin_settings() {
  local file="${PLUGIN_DIR}/data.json"
  local existing='{}'
  if [ -f "${file}" ]; then
    existing="$(jq -c '.' "${file}" 2>/dev/null || echo '{}')"
  fi

  # --rawfile keeps the secret out of argv and the environment entirely.
  # Unknown keys, counters and the toolLoading slice are preserved so a
  # restart produces no diff and triggers no plugin-side rewrite.
  local next
  next="$(printf '%s' "${existing}" | jq -S \
    --rawfile tokenraw "${TOKEN_FILE}" \
    --argjson port "${MCP_PORT}" \
    --arg tokenid "${TOKEN_ID}" \
    --arg tokenlabel "${TOKEN_LABEL}" \
    --arg toolprofile "${TOOL_PROFILE}" '
      ($tokenraw | sub("\\s+$"; "")) as $token
      | (. // {})
      | .mcpTransport = ((.mcpTransport // {})
          | .port = $port
          | .tokens = (
              ((.tokens // []) | if type == "array" then . else [] end) as $t
              | if ($t | length) > 0
                then [ ($t[0] | .token = $token) ] + $t[1:]
                else [ { "id": $tokenid, "label": $tokenlabel, "token": $token, "createdAt": 0 } ]
                end
            )
          | .bearerToken = $token)
      | (if $toolprofile == "" then . else
          .toolLoading = ((.toolLoading // {})
            | .profiles = ((.profiles // {})
                | .[$tokenid] = ((.[$tokenid] // { "promoted": [], "allowed": null })
                    | .profile = $toolprofile)))
        end)
    ')"

  if write_json_if_changed "${file}" "${next}" 0600; then
    log "plugin data.json updated (port ${MCP_PORT}, token from secret${TOOL_PROFILE:+, tool profile ${TOOL_PROFILE}})"
  else
    log "plugin data.json already converged"
  fi
  chmod 0600 "${file}"
}

# ---------------------------------------------------------------------------
# 4. Processes
# ---------------------------------------------------------------------------
start_xvfb() {
  local screen="${DISPLAY#:}"

  # A container restart reuses the same filesystem, and Xvfb does not always
  # remove these on SIGTERM. A leftover socket makes an existence check pass
  # instantly against a server that is not listening, and Obsidian then
  # segfaults the moment it tries to open a window.
  rm -f "/tmp/.X11-unix/X${screen}" "/tmp/.X${screen}-lock"

  log "starting Xvfb on ${DISPLAY}"
  Xvfb "${DISPLAY}" -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  XVFB_PID=$!

  # Readiness means the server answers a query, not that a socket file exists.
  local deadline=$((SECONDS + 30))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    kill -0 "${XVFB_PID}" 2>/dev/null || fail "Xvfb exited during startup: $(tail -n 20 /tmp/xvfb.log)"
    if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
      log "Xvfb ready and answering on ${DISPLAY} (pid ${XVFB_PID})"
      return 0
    fi
    sleep 0.5
  done
  fail "Xvfb never answered on ${DISPLAY}: $(tail -n 20 /tmp/xvfb.log)"
}

start_obsidian() {
  # A previous instance that did not exit cleanly leaves these behind. Exactly
  # one Obsidian runs per container, so a surviving lock is always stale.
  rm -f "${CONFIG_DIR}/SingletonLock" "${CONFIG_DIR}/SingletonCookie" "${CONFIG_DIR}/SingletonSocket"
  rm -rf /tmp/scoped_dir* 2>/dev/null || true

  # --no-sandbox mirrors the working host unit. Chromium's own sandbox needs
  #   privileges this container deliberately does not have; the container user
  #   is still unprivileged. Recorded as a limitation in the spike report.
  # --password-store=basic keeps Chromium's OSCrypt away from libsecret and
  #   the D-Bus secret portal, which no container here provides. Hygiene, not
  #   a fix: it was added while chasing the third-boot segfault and did NOT
  #   resolve it. The cause was a stale X socket (see start_xvfb).
  # --disable-gpu because there is no GPU behind Xvfb and the SwiftShader
  #   fallback is pure startup cost. Also hygiene, also not the fix.
  log "starting Obsidian as uid $(id -u)"
  "${OBSIDIAN_BIN}" \
    --no-sandbox \
    --disable-gpu \
    --password-store=basic \
    >/tmp/obsidian.log 2>&1 &
  OBSIDIAN_PID=$!
  log "Obsidian started (pid ${OBSIDIAN_PID})"
}

find_cli_socket() {
  local candidates=(
    "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/.obsidian-cli.sock"
    "/tmp/.obsidian-cli.sock"
  )
  local c
  for c in "${candidates[@]}"; do
    [ -S "${c}" ] && { printf '%s' "${c}"; return 0; }
  done
  c="$(find /run /tmp -maxdepth 3 -name '*obsidian-cli*.sock' -type s 2>/dev/null | head -n 1 || true)"
  [ -n "${c}" ] && { printf '%s' "${c}"; return 0; }
  return 1
}

wait_for_cli() {
  log "waiting for the Obsidian CLI socket"
  local deadline=$((SECONDS + STARTUP_TIMEOUT))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    kill -0 "${OBSIDIAN_PID}" 2>/dev/null || fail "Obsidian exited during startup: $(tail -n 40 /tmp/obsidian.log)"
    if CLI_SOCKET="$(find_cli_socket)"; then
      log "CLI socket at ${CLI_SOCKET}"
      # The socket existing is not the same as the CLI being armed: a
      # disabled CLI still listens and answers every command with a refusal.
      local out rc=0
      out="$("${OBSIDIAN_CLI}" version 2>&1)" || rc=$?
      if [ "${rc}" -eq 0 ] && ! printf '%s' "${out}" | grep -qi 'not enabled'; then
        log "CLI armed: ${out}"
        return 0
      fi
      log "CLI present but not armed yet (${out})"
    fi
    sleep 2
  done

  log "obsidian.json as it now stands:"
  cat "${OBSIDIAN_JSON}" >&2 || true
  fail "the Obsidian CLI never armed within ${STARTUP_TIMEOUT}s. Setting \"cli\": true in obsidian.json did not enable it, so the documented headless control path is unavailable."
}

# ---------------------------------------------------------------------------
# 5. Restricted mode and plugin enablement
# ---------------------------------------------------------------------------
converge_restricted_mode() {
  log "disabling restricted mode"
  "${OBSIDIAN_CLI}" plugins:restrict off >/dev/null 2>&1 \
    || fail "plugins:restrict off failed"

  local state
  state="$("${OBSIDIAN_CLI}" plugins:restrict 2>&1 || true)"
  log "restricted mode reports: ${state}"

  log "enabling ${PLUGIN_ID}"
  "${OBSIDIAN_CLI}" plugin:enable "id=${PLUGIN_ID}" filter=community >/dev/null 2>&1 \
    || log "plugin:enable returned non-zero (it may already be enabled); verifying"

  local deadline=$((SECONDS + 60)) enabled=""
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    enabled="$("${OBSIDIAN_CLI}" plugins:enabled filter=community 2>&1 || true)"
    if printf '%s' "${enabled}" | grep -q "${PLUGIN_ID}"; then
      log "${PLUGIN_ID} is enabled"
      return 0
    fi
    sleep 2
  done
  fail "${PLUGIN_ID} never appeared in plugins:enabled. Last output: ${enabled}"
}

# ---------------------------------------------------------------------------
# 6. MCP readiness
# ---------------------------------------------------------------------------
mcp_status() {
  # No credential: proves the listener is bound and auth is wired without
  # this probe ever handling the secret.
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    -X POST "http://127.0.0.1:${MCP_PORT}/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}' 2>/dev/null || true
}

wait_for_mcp_listener() {
  log "waiting for an unauthenticated 401 on 127.0.0.1:${MCP_PORT}/mcp"
  local deadline=$((SECONDS + STARTUP_TIMEOUT)) code=""
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    kill -0 "${OBSIDIAN_PID}" 2>/dev/null || fail "Obsidian exited while waiting for MCP"
    code="$(mcp_status)"
    [ "${code}" = "401" ] && { log "MCP listener answering 401"; return 0; }
    sleep 2
  done
  fail "MCP never answered 401 (last status: ${code:-none})"
}

assert_authenticated_initialize() {
  log "verifying an authenticated initialize"
  local cfg body
  cfg="$(mktemp)"; chmod 600 "${cfg}"
  printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '\n' < "${TOKEN_FILE}")" > "${cfg}"

  body="$(curl -s --max-time 15 --config "${cfg}" \
    -X POST "http://127.0.0.1:${MCP_PORT}/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H 'mcp-protocol-version: 2025-11-25' \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"agent-runtime-spike","version":"0"}}}' 2>/dev/null || true)"
  rm -f "${cfg}"

  printf '%s' "${body}" | jq -e '.result.serverInfo.name' >/dev/null 2>&1 \
    || fail "authenticated initialize did not return serverInfo"

  log "initialize OK: $(printf '%s' "${body}" | jq -c '{server: .result.serverInfo, protocol: .result.protocolVersion}')"
}

# ---------------------------------------------------------------------------
main() {
  preflight
  converge_obsidian_json
  converge_plugin_list
  converge_plugin_files
  converge_plugin_settings
  start_xvfb
  start_obsidian
  wait_for_cli
  converge_restricted_mode
  wait_for_mcp_listener
  assert_authenticated_initialize

  log "READY — headless Obsidian is serving MCP on 127.0.0.1:${MCP_PORT}/mcp"
  wait "${OBSIDIAN_PID}"
}

main "$@"
