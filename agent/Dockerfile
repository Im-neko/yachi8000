# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
# @discordjs/opus はネイティブ拡張。prebuild が用意されているのは glibc
# 2.31 / 2.35 で、bookworm（2.36）には無いためソースからビルドされる。
# ビルド道具は deps ステージにだけ置き、runtime へは成果物だけを運ぶ。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci \
 && apt-get purge -y --auto-remove python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
# イメージのタグを渡す。起動ログに出して、デプロイが実際に入れ替わったことを確認する。
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/server.mjs"]
