# Artemis API server (the CLI's backend). Build: docker build -t artemis-api .
FROM oven/bun:1.1-alpine
RUN apk add --no-cache ripgrep git bash
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile || bun install --production
COPY src ./src
COPY server ./server
COPY sdk ./sdk
ENV HOST=0.0.0.0 \
    PORT=8080 \
    ARTEMIS_DATA_DIR=/data \
    ARTEMIS_WORKSPACES_ROOT=/workspaces
RUN mkdir -p /data /workspaces && chown -R bun:bun /data /workspaces
USER bun
VOLUME ["/data", "/workspaces"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/v1/health || exit 1
CMD ["bun", "server/index.ts"]
