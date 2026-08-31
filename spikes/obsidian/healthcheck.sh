#!/usr/bin/env bash
#
# Container healthcheck.
#
# An unauthenticated POST must answer exactly 401. That single status proves
# the listener is bound, the path is served, and bearer auth is wired — and it
# needs no credential, so the health command never handles the secret.

set -Eeuo pipefail

port="${OBSIDIAN_MCP_PORT:-27200}"

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  -X POST "http://127.0.0.1:${port}/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}' 2>/dev/null || true)"

if [ "${code}" != "401" ]; then
  echo "expected 401 from the MCP endpoint, got ${code:-no response}" >&2
  exit 1
fi
