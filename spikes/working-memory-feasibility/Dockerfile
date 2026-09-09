# Pinned by digest, matching the pin set the earlier spikes used.
FROM node:24.6.0-bookworm-slim@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

USER node
ENTRYPOINT ["node", "--no-warnings"]
CMD ["src/demo.ts"]
