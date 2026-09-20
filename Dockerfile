# syntax=docker/dockerfile:1
#
# **ビルド文脈はリポジトリのルート。** イメージには agent（本体）と web
# （アバターのビューアと設定 UI）の両方が入る —— web の成果物は agent が
# 配信するので（→ D-36 の 5）、同じイメージに焼く。
FROM node:22-bookworm-slim AS base
WORKDIR /app

FROM base AS agent-deps
WORKDIR /app/agent
COPY agent/package.json agent/package-lock.json ./
# @discordjs/opus はネイティブ拡張。prebuild が用意されているのは glibc
# 2.31 / 2.35 で、bookworm（2.36）には無いためソースからビルドされる。
# ビルド道具は deps ステージにだけ置き、runtime へは成果物だけを運ぶ。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci \
 && apt-get purge -y --auto-remove python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

FROM agent-deps AS agent-build
COPY agent/ ./
RUN npm run build

# web は純粋なフロントエンドなので、ネイティブ拡張のビルド道具は要らない。
FROM base AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
# イメージのタグを渡す。起動ログに出して、デプロイが実際に入れ替わったことを確認する。
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
COPY --from=agent-deps /app/agent/node_modules ./node_modules
COPY agent/package.json ./
COPY --from=agent-build /app/agent/dist ./dist
# WEB_DIST_PATH の既定値（./web）に合わせる。無くても起動は止まらない。
COPY --from=web-build /app/web/dist ./web

EXPOSE 3000
CMD ["node", "dist/server.mjs"]
