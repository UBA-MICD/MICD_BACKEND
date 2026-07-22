# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/server.js"]

# ── Stage 3: Test ─────────────────────────────────────────────────────────────
# Full toolchain (dev deps + tests) for running the integration suite against a
# live stack from inside the Docker network. Built/used by docker-compose.test.yml.
FROM node:20-alpine AS test

WORKDIR /app

COPY package*.json ./
RUN npm ci

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
