# Pinned by digest. The build phase has network access; every measurement phase
# runs on a gateway-less internal network and can reach nothing but Postgres.
FROM node:24.6.0-bookworm-slim@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY fixtures ./fixtures
COPY src ./src

USER node

# Exec form, no shell, no init wrapper: the measured Node process is genuinely
# PID 1, so `docker kill` signals the process under test rather than a wrapper.
ENTRYPOINT ["node", "--no-warnings", "src/main.ts"]
CMD ["cases"]
