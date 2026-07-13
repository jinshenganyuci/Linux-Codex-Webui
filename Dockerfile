# syntax=docker/dockerfile:1

########################################
# 构建阶段：安装依赖并编译前端 + CLI
########################################
FROM node:22-bookworm-slim AS builder

# node-pty 为原生模块，编译需要 python3 / make / g++
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# 先复制依赖清单与 postinstall 所需脚本，最大化利用构建缓存
COPY package.json pnpm-lock.yaml .npmrc ./
COPY scripts/fix-pty-native-build.cjs scripts/
RUN pnpm install --frozen-lockfile

# 复制源代码并构建（vite 前端 -> dist/，tsup CLI -> dist-cli/）
COPY . .
RUN pnpm run build

# 移除 devDependencies，只保留运行时依赖
RUN pnpm prune --prod

########################################
# 运行阶段
########################################
FROM node:22-bookworm-slim

# 运行时工具：
#   git        - Codex 操作项目仓库需要
#   ripgrep    - 服务端文件搜索（CODEXUI_RG_COMMAND 可覆盖）
#   curl       - 健康检查及部分网络功能
#   python3    - Codex skill-installer 等脚本需要
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep curl ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*

# 安装 Codex CLI（服务端会通过 PATH 解析 codex 命令）
RUN npm install -g @openai/codex && npm cache clean --force

# 可选：安装 cloudflared 以支持 --tunnel（默认关闭，构建时传 --build-arg INSTALL_CLOUDFLARED=true 开启）
ARG INSTALL_CLOUDFLARED=false
RUN if [ "$INSTALL_CLOUDFLARED" = "true" ]; then \
        ARCH=$(dpkg --print-architecture) \
        && curl -fsSL -o /usr/local/bin/cloudflared \
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}" \
        && chmod +x /usr/local/bin/cloudflared; \
    fi

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-cli ./dist-cli

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Codex 配置目录（auth.json、会话记录等）与默认工作目录
ENV CODEX_HOME=/data/codex \
    WEBUI_PORT=5900
RUN mkdir -p /data/codex /workspace && chown -R node:node /data /workspace /app

USER node

EXPOSE 5900
VOLUME ["/data", "/workspace"]

# 任意 HTTP 响应（含登录页）即视为存活
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -s -o /dev/null "http://127.0.0.1:${WEBUI_PORT}/" || exit 1

ENTRYPOINT ["entrypoint.sh"]
