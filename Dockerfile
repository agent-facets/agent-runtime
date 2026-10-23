# Build and runtime images share the pinned Bun release (1.3.14-slim, multi-architecture index digest).
FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS build
WORKDIR /repo

# Workspace manifests first, so dependency installation is cached independently of source changes.
COPY package.json bun.lock bunfig.toml ./
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN bun install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/runtime packages/runtime
COPY packages/ui packages/ui
RUN bun run --cwd packages/runtime build

FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Private runtime state; a new named volume inherits this ownership and mode.
RUN mkdir -p /var/lib/agent-runtime && chown bun:bun /var/lib/agent-runtime && chmod 0700 /var/lib/agent-runtime

COPY --from=build /repo/packages/runtime/dist ./dist

USER bun
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "dist/main.js"]
