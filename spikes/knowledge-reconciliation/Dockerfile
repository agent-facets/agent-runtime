# Build context is `spikes/`, not this directory, so the Anthropic transport can
# be copied in at the same relative path it has in the repository. That keeps
# `../anthropic-parity/src/candidate.ts` resolving identically for the type
# checker on the host and for Node inside the container.
FROM node:24.6.0-bookworm-slim@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff

WORKDIR /app/knowledge-reconciliation

COPY knowledge-reconciliation/package.json knowledge-reconciliation/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# Only the transport. Not the parity experiment, and not its live harness.
COPY anthropic-parity/src/candidate.ts anthropic-parity/src/profile.ts \
     anthropic-parity/src/canonical.ts /app/anthropic-parity/src/

# The copied files are ESM, and without a package.json beside them both Node and
# tsc would read them as CommonJS. The original spike's package.json says the
# same thing; only this marker is needed, and copying its dependency list would
# imply an install that does not happen. These three files import nothing but
# each other and node:crypto.
RUN printf '{"type":"module"}\n' > /app/anthropic-parity/package.json

COPY knowledge-reconciliation/tsconfig.json ./
COPY knowledge-reconciliation/src ./src
COPY knowledge-reconciliation/fixtures ./fixtures

USER node
ENTRYPOINT ["node", "--no-warnings"]
CMD ["src/cli.ts"]
