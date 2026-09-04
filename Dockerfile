# syntax=docker/dockerfile:1.7

# ── Builder stage: compile TypeScript ─────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies so only runtime deps are copied forward.
RUN npm prune --omit=dev


# ── Runtime stage: minimal image ─────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=8765

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY spec ./spec

# Run unprivileged; the image needs no write access at runtime.
USER node

EXPOSE 8765

# /health reports the tool count and the connected organization, and answers 503
# when the credentials cannot be verified — so a bad key shows up as unhealthy
# rather than as writes against the wrong company's books.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "dist/index.js"]
