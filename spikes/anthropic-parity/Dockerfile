# Pinned by digest. The build phase has network access; the measurement phase
# runs with --network none and must never reach a provider.
FROM node:24.6.0-bookworm-slim@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY fixtures ./fixtures
COPY src ./src

# The drivers write nothing to disk: each prints one JSON object to stdout so
# the container can run --read-only with an unprivileged user.
#
# uid 1000 is node's own uid in this image and matches the owner of the
# credential file the live stage bind-mounts read-only.
USER node

ENTRYPOINT ["node", "--no-warnings"]
CMD ["src/run.ts"]
