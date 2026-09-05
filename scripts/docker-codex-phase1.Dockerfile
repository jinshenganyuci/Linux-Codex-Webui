FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY linux-codex-webui.tgz /tmp/webui.tgz
RUN npm install --global /tmp/webui.tgz @openai/codex@0.153.4 --no-audit --no-fund && rm /tmp/webui.tgz
ENV CODEX_HOME=/codex-home
WORKDIR /project
CMD ["sh", "-c", "linux-codex-webui --port ${PORT:-4190} --no-password --no-open --no-tunnel --no-login"]
