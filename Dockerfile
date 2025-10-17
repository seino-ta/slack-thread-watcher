FROM node:20-alpine AS base

WORKDIR /app

# 依存関係のみ先にコピーしてインストール
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# アプリケーション本体をコピー
COPY . .

# Nodeユーザーでもログ・状態ファイルを書き込めるよう権限を調整
RUN chown -R node:node /app

USER node

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "index.js"]
