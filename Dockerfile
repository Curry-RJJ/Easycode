# ============================================================
# EasyCode CLI — 多阶段构建
# ============================================================

# ---- Stage 1: 构建阶段 ----
FROM node:20-alpine AS builder

WORKDIR /app

# 安装依赖（利用 Docker 层缓存：先复制 package.json，再安装）
COPY package.json package-lock.json* ./
COPY packages/core/package.json ./packages/core/
COPY packages/ai/package.json ./packages/ai/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/cli/package.json ./packages/cli/

RUN npm ci

# 复制源码并构建
COPY . .
RUN npm run build

# ---- Stage 2: 运行阶段（最小化镜像）----
FROM node:20-alpine AS runner

LABEL maintainer="EasyCode"
LABEL description="EasyCode CLI — A Coding Agent powered by LLM"

WORKDIR /app

# 只复制构建产物和生产依赖
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/ai/dist ./packages/ai/dist
COPY --from=builder /app/packages/ai/package.json ./packages/ai/
COPY --from=builder /app/packages/mcp/dist ./packages/mcp/dist
COPY --from=builder /app/packages/mcp/package.json ./packages/mcp/
COPY --from=builder /app/packages/cli/dist ./packages/cli/dist
COPY --from=builder /app/packages/cli/package.json ./packages/cli/

RUN npm ci --omit=dev

# 会话数据持久化目录
VOLUME ["/root/.easycode"]

# 工作区目录（挂载用户代码）
VOLUME ["/workspace"]
WORKDIR /workspace

# 全局注册 CLI 命令
RUN npm link /app/packages/cli 2>/dev/null || true

ENV NODE_ENV=production

ENTRYPOINT ["node", "/app/packages/cli/dist/index.js"]
CMD ["--help"]
