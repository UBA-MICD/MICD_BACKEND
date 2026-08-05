# Pinned by digest for reproducible builds (avoids silent base-image drift);
# override with --build-arg NODE_IMAGE=... to bump it deliberately.
ARG NODE_IMAGE=node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

COPY package*.json ./
# --include=dev is explicit on purpose: this stage needs typescript to compile.
# A plain `npm ci` silently drops devDependencies when the build host has
# NODE_ENV=production (or omit=dev in any npmrc) leaking in, which fails later
# and confusingly at `npm run build` with `sh: tsc: not found`.
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

# tini as PID 1: reaps zombies and forwards signals correctly, which plain
# `node` as PID 1 does not do (SIGTERM from `docker stop` would otherwise be
# ignored by default, delaying shutdown until the kill timeout).
RUN apk add --no-cache tini

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Liveness only (no dependency I/O) — matches GET /api/livez. Reads
# PORT/TLS_ENABLED from the container's own env so it stays correct however
# those are configured, instead of a hardcoded scheme/port.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD proto=http; [ "$TLS_ENABLED" = "true" ] && proto=https; wget --no-check-certificate -qO- "$proto://localhost:${PORT}/api/livez" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]

# ── Stage 3: Test ─────────────────────────────────────────────────────────────
# Full toolchain (dev deps + tests) for running the integration suite against a
# live stack from inside the Docker network. Built/used by docker-compose.test.yml.
FROM ${NODE_IMAGE} AS test

WORKDIR /app

COPY package*.json ./
# Same reason as the builder stage: this one needs jest/ts-jest from devDeps.
RUN npm ci --include=dev

COPY tsconfig.json tsconfig.jest.json jest.config.js ./
COPY src/ ./src/
COPY tests/ ./tests/

ENV NODE_ENV=test

# Default: run the integration suites. Files run in parallel (jest default) so
# every suite's beforeAll acquires its auth token up-front, before the auth
# suite's rate-limit test trips the per-IP login limiter — running --runInBand
# would serialize them and poison later logins. --forceExit because the pg pool
# keeps a handle open after the run. The sample DICOM under .data.example is
# provided at runtime via a read-only bind mount (see docker-compose.test.yml).
CMD ["npx", "jest", "--testPathPatterns=integration", "--forceExit"]
