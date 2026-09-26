ARG BASE_IMAGE=linux-codex-webui-startup-complete:20260926
FROM ${BASE_IMAGE}
ARG CODEX_VERSION=0.154.0
COPY linux-codex-webui.tgz /tmp/webui.tgz
# The build context contains the already installed pinned npm runtime, including
# its native package and resources. Never copy a user's CODEX_HOME here.
COPY codex-runtime/node_modules /opt/plan-progress-runtime/node_modules
RUN npm install --prefix /opt/plan-progress-webui --omit=dev --prefer-offline /tmp/webui.tgz --no-audit --no-fund \
    && /opt/plan-progress-runtime/node_modules/.bin/codex --version | grep -Fx "codex-cli ${CODEX_VERSION}" \
    && rm /tmp/webui.tgz
ENV PATH="/opt/plan-progress-webui/node_modules/.bin:/opt/plan-progress-runtime/node_modules/.bin:${PATH}"
ENV CODEX_HOME=/codex-home
WORKDIR /project
CMD ["sh", "-c", "linux-codex-webui --port ${PORT:-4190} --no-password --no-open --no-tunnel --no-login"]
