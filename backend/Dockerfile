# ── Build stage ──────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build

# ── Production stage ─────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/generated ./generated

RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && mkdir -p /app/logs && chown appuser:appgroup /app/logs
USER appuser

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main"]
