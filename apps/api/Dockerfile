FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

FROM base AS deps
RUN apk add --no-cache python3 make g++
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @drawbattle/api... --filter @drawbattle/shared

FROM base AS build
COPY --from=deps /app ./
COPY tsconfig.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @drawbattle/shared build && pnpm --filter @drawbattle/api build && pnpm --filter @drawbattle/api exec prisma generate

FROM node:20-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
EXPOSE 3001
WORKDIR /app/apps/api
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/main"]