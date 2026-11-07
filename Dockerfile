# Build, development and runtime images share the pinned Bun release (1.4.4-slim, multi-architecture index digest).
# Stages: deps (installed dependencies) → source → build (bundled server, static console, MCP programs) → runtime,
# the production image and the default target. `dev` (target `dev`) runs from source for compose.dev.yaml.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS deps
WORKDIR /repo

# Workspace manifests first, so dependency installation is cached independently of source changes.
COPY package.json bun.lock bunfig.toml ./
COPY packages/anthropic-subscription/package.json packages/anthropic-subscription/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/facet-adapter/package.json packages/facet-adapter/package.json
COPY packages/mcp-programs/package.json packages/mcp-programs/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS source
COPY tsconfig.base.json ./
COPY packages/anthropic-subscription packages/anthropic-subscription
COPY packages/contracts packages/contracts
COPY packages/facet-adapter packages/facet-adapter
COPY packages/mcp-programs packages/mcp-programs
COPY packages/runtime packages/runtime
COPY packages/ui packages/ui
# The deployment's MCP server programs (packages/mcp-programs/src/programs.ts), self-contained and digest-named.
RUN bun run --cwd packages/mcp-programs build

FROM source AS build
RUN bun run --cwd packages/runtime build

# Development: runs the source tree, whose package sources compose.dev.yaml mounts read-only over the copies here;
# installed dependencies stay the image's own. It records the fingerprint of what installation depended on, so a
# checkout whose dependencies changed is refused until the image is rebuilt.
FROM source AS dev
ENV NODE_ENV=development
ENV AGENT_RUNTIME_DEPENDENCY_RECORD=/usr/local/share/agent-runtime/dependency-fingerprint
RUN mkdir -p /usr/local/share/agent-runtime /opt/agent-runtime \
  && bun packages/runtime/src/dev/dependencies.ts /repo > "$AGENT_RUNTIME_DEPENDENCY_RECORD" \
  && cp -R packages/mcp-programs/dist/programs /opt/agent-runtime/mcp \
  && mkdir -p /var/lib/agent-runtime && chown bun:bun /var/lib/agent-runtime && chmod 0700 /var/lib/agent-runtime
USER bun
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "packages/runtime/src/dev/supervisor.ts"]

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Private runtime state; a new named volume inherits this ownership and mode.
RUN mkdir -p /var/lib/agent-runtime && chown bun:bun /var/lib/agent-runtime && chmod 0700 /var/lib/agent-runtime

COPY --from=build /repo/packages/runtime/dist ./dist
# Read-only program bundles at <programId>/<sha256>.js beside their manifest; operator configuration names them by
# path and digest. Only selected programs are built here: test servers never enter the build context.
COPY --from=build /repo/packages/mcp-programs/dist/programs /opt/agent-runtime/mcp
# The bundle includes code derived from third-party MIT material; its notice and license travel with the image.
COPY --from=build /repo/packages/anthropic-subscription/THIRD_PARTY_NOTICES.md ./licenses/anthropic-subscription/
COPY --from=build /repo/packages/anthropic-subscription/licenses ./licenses/anthropic-subscription/licenses

USER bun
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "dist/main.js"]
