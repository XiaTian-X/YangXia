# 养夏自托管镜像（两阶段构建：先构建静态网页端 apps/web/dist，再以非 root Node 24 运行服务端）
FROM node:24-slim AS web-builder

WORKDIR /build
COPY package.json package-lock.json ./
COPY packages/course-core/package.json ./packages/course-core/
COPY apps/sequencer/package.json ./apps/sequencer/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

RUN npm ci --workspace=@yangxia/course-core --workspace=@yangxia/web

COPY packages/course-core ./packages/course-core
COPY apps/web ./apps/web
RUN npm run build -w @yangxia/web

FROM node:24-slim

ENV NODE_ENV=production \
    TZ=UTC \
    HOST=0.0.0.0 \
    PORT=3000 \
    YANGXIA_DATA_DIR=/data \
    YANGXIA_TEMPLATES=/templates

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/course-core/package.json ./packages/course-core/
COPY apps/sequencer/package.json ./apps/sequencer/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

RUN npm ci --omit=dev --workspace=@yangxia/course-core --workspace=@yangxia/server

COPY scripts ./scripts
COPY contracts ./contracts
COPY packages/course-core ./packages/course-core
COPY apps/server ./apps/server
COPY --from=web-builder /build/apps/web/dist ./apps/web/dist

RUN mkdir -p /data /templates && chown -R node:node /app /data /templates
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/server/src/index.ts"]
