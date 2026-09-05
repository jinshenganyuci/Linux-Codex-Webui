ARG BASE_IMAGE=linux-codex-webui-phase2:5eba11f
FROM ${BASE_IMAGE}
COPY linux-codex-webui.tgz /tmp/webui.tgz
RUN npm install --prefix /opt/phase3 --omit=dev --prefer-offline /tmp/webui.tgz --no-audit --no-fund && rm /tmp/webui.tgz
ENV PATH="/opt/phase3/node_modules/.bin:${PATH}"
