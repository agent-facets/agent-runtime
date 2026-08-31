#!/bin/sh
#
# Authenticated curl for the spike probes.
#
# The bearer token is read from the mounted secret into a 0600 curl config
# file on the probe's own tmpfs, so it never appears in argv, the environment,
# or anything the host-side driver can see.
#
# Usage: probe-curl [curl args...]

set -u

TOKEN_FILE="${OBSIDIAN_TOKEN_FILE:-/run/secrets/obsidian_mcp_token}"

if [ ! -r "${TOKEN_FILE}" ]; then
  echo "probe-curl: token secret ${TOKEN_FILE} is missing or unreadable" >&2
  exit 64
fi

CFG="$(mktemp)"
chmod 600 "${CFG}"
trap 'rm -f "${CFG}"' EXIT INT TERM

printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '\n' < "${TOKEN_FILE}")" > "${CFG}"

curl --config "${CFG}" "$@"
