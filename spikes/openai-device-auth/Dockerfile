# Pinned by digest. The build phase has network access; every measurement phase
# runs with --network none and must never reach a provider.
FROM node:24.6.0-bookworm-slim@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff

# strace backs the independent syscall check. flock(1) comes from util-linux,
# which is Essential in Debian and therefore already present; the store's
# cross-process lock depends on it, so its absence must fail the build rather
# than surface later as a mysterious timeout.
RUN apt-get update \
    && apt-get install -y --no-install-recommends strace \
    && rm -rf /var/lib/apt/lists/* \
    && command -v flock > /dev/null

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# The official oracle. Installed from the registry, which verifies the tarball
# against its published integrity hash; the resolved version and the binary's
# own digest are recorded at run time so the evidence names what actually ran.
ARG INSTALL_ORACLE=1
ARG CODEX_VERSION=0.151.0
RUN if [ "${INSTALL_ORACLE}" = "1" ]; then \
      npm install -g --no-audit --no-fund "@openai/codex@${CODEX_VERSION}" \
      && codex --version; \
    fi

COPY tsconfig.json ./
COPY fixtures ./fixtures
COPY src ./src

# The live stage mounts a named volume here. Docker seeds a *fresh* volume from
# the image's directory ownership and mode, so creating it owned by node with
# 0700 is what makes the volume writable by the unprivileged live container and
# unreadable by anyone else. Without this the volume arrives root:root 0755 and
# the first write fails after the device code has already been issued.
RUN mkdir -p /state \
    && chown node:node /state \
    && chmod 0700 /state

# The drivers print one JSON object to stdout and write only under /tmp, so the
# container runs read-only, unprivileged, with no bind mount.
USER node

ENTRYPOINT ["node", "--no-warnings"]
CMD ["src/offline.ts"]
