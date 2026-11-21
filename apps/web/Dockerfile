FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @drawbattle/web... --filter @drawbattle/shared

FROM base AS build
COPY --from=deps /app ./
COPY tsconfig.json ./
COPY packages ./packages
COPY apps/web ./apps/web
# Leave NEXT_PUBLIC_API_URL empty by default: the browser uses same-origin
# /api/* and /game/* paths, proxied to INTERNAL_API_URL by Next.js rewrites.
# Override at build time only when the API has a different public origin.
ARG NEXT_PUBLIC_API_URL=""
ARG INTERNAL_API_URL=http://api:3001
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV INTERNAL_API_URL=$INTERNAL_API_URL
RUN pnpm --filter @drawbattle/shared build && pnpm --filter @drawbattle/web build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/next.config.js ./apps/web/next.config.js
EXPOSE 3002
WORKDIR /app/apps/web
CMD ["pnpm", "start"]
