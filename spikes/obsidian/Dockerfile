# syntax=docker/dockerfile:1.7
#
# Headless Obsidian spike image.
#
# Everything that determines behaviour is pinned: the base image by index
# digest, the Obsidian tarball and the plugin release assets by SHA-256.
# Apt package versions are deliberately NOT pinned — this is throwaway spike
# code, and the report records that as a known limitation.

ARG DEBIAN_DIGEST=sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

# ---------------------------------------------------------------------------
# Stage 1 — fetch and verify immutable artifacts
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim@${DEBIAN_DIGEST} AS fetch

ARG OBSIDIAN_VERSION=1.13.7
ARG OBSIDIAN_SHA256_AMD64=d3cbe375cbfa4024db1910b98191649f4134c5c48aee5e60b6e7713987dcdb28
ARG OBSIDIAN_SHA256_ARM64=98aac34d1f132a35cf506fc3fa196d595dcdeefdebd44b0cc5faaa7a1a210de2
ARG PLUGIN_ID=mcp-tools-istefox
ARG PLUGIN_VERSION=2.4.0
ARG PLUGIN_MAIN_SHA256=9c1653b88c5eb49585e579909083a5f215b910cfdf1635936d4ca77a078b5484
ARG PLUGIN_MANIFEST_SHA256=e58f88727e56359266cc1dc235b13560578ba44023c4abfa229c0d8198444fca
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl jq \
 && rm -rf /var/lib/apt/lists/*

# Obsidian. The tarball carries an `obsidian-<version>/` prefix, stripped here
# so the layout matches the .deb (/opt/Obsidian/obsidian, .../obsidian-cli).
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) suffix=""       ; sha="${OBSIDIAN_SHA256_AMD64}" ;; \
      arm64) suffix="-arm64" ; sha="${OBSIDIAN_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/obsidian-${OBSIDIAN_VERSION}${suffix}.tar.gz"; \
    curl -fsSL --retry 3 --retry-delay 2 -o /tmp/obsidian.tar.gz "${url}"; \
    printf '%s  %s\n' "${sha}" /tmp/obsidian.tar.gz | sha256sum -c -; \
    mkdir -p /opt/Obsidian; \
    tar -xzf /tmp/obsidian.tar.gz -C /opt/Obsidian --strip-components=1; \
    rm -f /tmp/obsidian.tar.gz; \
    test -x /opt/Obsidian/obsidian; \
    test -x /opt/Obsidian/obsidian-cli

# MCP Connector plugin, staged in the image. The entrypoint syncs it into the
# vault only when absent or when the hash differs.
RUN set -eux; \
    dir="/opt/obsidian-plugins/${PLUGIN_ID}"; \
    mkdir -p "${dir}"; \
    base="https://github.com/istefox/obsidian-mcp-connector/releases/download/${PLUGIN_VERSION}"; \
    curl -fsSL --retry 3 --retry-delay 2 -o "${dir}/main.js"       "${base}/main.js"; \
    curl -fsSL --retry 3 --retry-delay 2 -o "${dir}/manifest.json" "${base}/manifest.json"; \
    printf '%s  %s\n' "${PLUGIN_MAIN_SHA256}"     "${dir}/main.js"       | sha256sum -c -; \
    printf '%s  %s\n' "${PLUGIN_MANIFEST_SHA256}" "${dir}/manifest.json" | sha256sum -c -; \
    test "$(jq -r '.id'      "${dir}/manifest.json")" = "${PLUGIN_ID}"; \
    test "$(jq -r '.version' "${dir}/manifest.json")" = "${PLUGIN_VERSION}"

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim@${DEBIAN_DIGEST} AS runtime

ARG APP_UID=1000
ARG APP_GID=1000
ARG OBSIDIAN_VERSION=1.13.7
ARG PLUGIN_ID=mcp-tools-istefox
ARG PLUGIN_VERSION=2.4.0

LABEL org.opencontainers.image.title="agent-runtime obsidian spike" \
      org.opencontainers.image.description="Headless Obsidian + MCP Connector, P0 spike harness" \
      dev.agent-runtime.obsidian.version="${OBSIDIAN_VERSION}" \
      dev.agent-runtime.plugin.id="${PLUGIN_ID}" \
      dev.agent-runtime.plugin.version="${PLUGIN_VERSION}"

# Electron's observed shared-library closure, plus the tools the entrypoint
# and the evidence collector need. `ss` (iproute2) is required to prove the
# listener binds loopback and nothing else.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      fonts-liberation \
      iproute2 \
      jq \
      libasound2 \
      libatspi2.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libexpat1 \
      libgbm1 \
      libgtk-3-0 \
      libnotify4 \
      libnspr4 \
      libnss3 \
      libsecret-1-0 \
      libudev1 \
      libuuid1 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      libxss1 \
      libxtst6 \
      procps \
      tini \
      x11-utils \
      xvfb \
 && rm -rf /var/lib/apt/lists/*

COPY --from=fetch /opt/Obsidian /opt/Obsidian
COPY --from=fetch /opt/obsidian-plugins /opt/obsidian-plugins

# Fail the build rather than the container if the library closure is short.
RUN set -eux; \
    for bin in /opt/Obsidian/obsidian /opt/Obsidian/obsidian-cli; do \
      missing="$(ldd "${bin}" 2>/dev/null | awk '/not found/ {print $1}' || true)"; \
      if [ -n "${missing}" ]; then \
        echo "unresolved shared libraries for ${bin}:" >&2; echo "${missing}" >&2; exit 1; \
      fi; \
    done

# The mount points are created here, owned by the app user, so a FRESH named
# volume inherits that ownership from the image and the container never needs
# root to write to it.
RUN set -eux; \
    groupadd --gid "${APP_GID}" obsidian; \
    useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home --home-dir /home/obsidian --shell /usr/sbin/nologin obsidian; \
    mkdir -p /vault /home/obsidian/.config/obsidian /run/user/${APP_UID}; \
    chown -R "${APP_UID}:${APP_GID}" /vault /home/obsidian /run/user/${APP_UID}; \
    chmod 700 /run/user/${APP_UID}

COPY --chown=root:root entrypoint.sh healthcheck.sh collect-evidence.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh /usr/local/bin/collect-evidence.sh

ENV HOME=/home/obsidian \
    XDG_RUNTIME_DIR=/run/user/1000 \
    XDG_CONFIG_HOME=/home/obsidian/.config \
    DISPLAY=:99 \
    OBSIDIAN_VAULT_PATH=/vault \
    OBSIDIAN_CONFIG_DIR=/home/obsidian/.config/obsidian \
    OBSIDIAN_MCP_PORT=27200 \
    OBSIDIAN_PLUGIN_ID=mcp-tools-istefox \
    OBSIDIAN_PLUGIN_VERSION=2.4.0 \
    OBSIDIAN_PLUGIN_STAGE=/opt/obsidian-plugins \
    OBSIDIAN_TOKEN_FILE=/run/secrets/obsidian_mcp_token \
    OBSIDIAN_STARTUP_TIMEOUT=180 \
    PATH=/opt/Obsidian:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin

USER obsidian
WORKDIR /home/obsidian

HEALTHCHECK --interval=10s --timeout=6s --start-period=30s --retries=30 \
  CMD /usr/local/bin/healthcheck.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
