FROM node:22-slim
ARG CLAUDE_CODE_VERSION=2.1.322
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
COPY entrypoint.sh /entrypoint.sh
USER 1000
ENV HOME=/tmp
ENTRYPOINT ["/entrypoint.sh"]
