#!/bin/sh
# 根据环境变量组装 linux-codex-webui 启动参数。
# 所有变量说明见项目根目录 .env.example。
set -e

EXTRA_ARGS="$@"

set -- --port "${WEBUI_PORT:-5900}" --no-open

# 密码：显式禁用 > 指定密码 > 自动生成（打印在容器日志里）
if [ "${WEBUI_NO_PASSWORD:-false}" = "true" ]; then
    set -- "$@" --no-password
elif [ -n "${WEBUI_PASSWORD}" ]; then
    set -- "$@" --password "${WEBUI_PASSWORD}"
fi

# cloudflared 隧道默认关闭（镜像默认未安装 cloudflared）
if [ "${WEBUI_TUNNEL:-false}" = "true" ]; then
    set -- "$@" --tunnel
else
    set -- "$@" --no-tunnel
fi

# 容器内默认跳过交互式 codex login，推荐挂载已登录的 CODEX_HOME
if [ "${WEBUI_AUTO_LOGIN:-false}" = "true" ]; then
    set -- "$@" --login
else
    set -- "$@" --no-login
fi

if [ -n "${CODEXUI_SANDBOX_MODE}" ]; then
    set -- "$@" --sandbox-mode "${CODEXUI_SANDBOX_MODE}"
fi

if [ -n "${CODEXUI_APPROVAL_POLICY}" ]; then
    set -- "$@" --approval-policy "${CODEXUI_APPROVAL_POLICY}"
fi

exec node /app/dist-cli/index.js "$@" ${EXTRA_ARGS}
