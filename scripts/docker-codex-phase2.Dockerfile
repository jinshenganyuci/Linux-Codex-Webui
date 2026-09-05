ARG BASE_IMAGE=linux-codex-webui-phase1:d2242b1
FROM ${BASE_IMAGE}
COPY linux-codex-webui.tgz /tmp/webui.tgz
RUN npm install --prefix /opt/phase2 --omit=dev --prefer-offline /tmp/webui.tgz --no-audit --no-fund && rm /tmp/webui.tgz
ENV PATH="/opt/phase2/node_modules/.bin:${PATH}"
