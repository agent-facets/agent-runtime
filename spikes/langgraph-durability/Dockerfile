# Pinned by digest. The build phase has network access; every measurement phase
# runs on a gateway-less internal network and can reach nothing but Postgres.
FROM node:24.6.0-bookworm-slim@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY fixtures ./fixtures
COPY src ./src

# Unprivileged, and no writable state anywhere: the container runs read-only
# with a tmpfs /tmp, prints one JSON object to stdout, and shares nothing with
# any other container except the database.
USER node

# Exec form with no shell and no init wrapper, so the measured Node process is
# genuinely PID 1. A `sh -c` wrapper or tini would make the shell PID 1, and
# `docker kill` would then be signalling something other than the process under
# test — the crash would become collateral of namespace teardown rather than the
# measurement.
ENTRYPOINT ["node", "--no-warnings", "src/main.ts"]
CMD ["cases"]
