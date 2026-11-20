FROM node:20-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ pkg-config openssl \
  libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @drawbattle/api... --filter @drawbattle/shared

FROM base AS build
COPY --from=deps /app ./
COPY tsconfig.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @drawbattle/api exec prisma generate && \
  pnpm --filter @drawbattle/shared build && \
  pnpm --filter @drawbattle/api build

FROM node:20-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
  openssl ca-certificates postgresql-client \
  libcairo2 libpango-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
# Seed only when the word catalogue is empty. The seed script uses upserts, so
# re-running it against a populated database cannot duplicate words.
EXPOSE 3001
WORKDIR /app/apps/api
CMD ["sh", "-c", "set -e; pnpm exec prisma migrate deploy; WORD_COUNT=$(psql \"$DATABASE_URL\" -tAc 'SELECT count(*) FROM words'); if [ \"$WORD_COUNT\" = '0' ]; then echo 'Seeding empty word catalogue'; pnpm exec tsx prisma/seed.ts; else echo \"Word catalogue has $WORD_COUNT words; skipping seed\"; fi; exec node dist/main"]