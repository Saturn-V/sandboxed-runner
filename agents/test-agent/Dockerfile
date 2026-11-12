FROM node:22-slim
COPY agent.mjs /agent/agent.mjs
COPY fix/ /agent/fix/
USER 1000
ENTRYPOINT ["node", "/agent/agent.mjs"]
