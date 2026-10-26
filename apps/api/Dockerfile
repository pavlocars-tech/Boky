# Build-Kontext: Repository-Wurzel (docker build -f apps/api/Dockerfile .)
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @taxiads/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @taxiads/api build

FROM node:22-bookworm-slim
# ffmpeg/ffprobe für Prüfung und Umwandlung der Motive
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter @taxiads/api... && pnpm store prune
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/migrations apps/api/migrations
WORKDIR /app/apps/api
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
