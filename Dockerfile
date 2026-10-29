FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY double-cross-source-*.b64 /tmp/source-archive/

RUN cat /tmp/source-archive/double-cross-source-*.b64 | base64 -d > /tmp/double-cross-source.zip \
    && unzip -q /tmp/double-cross-source.zip -d /tmp/dc-source \
    && cp -a "/tmp/dc-source/Double Cross/." /app/ \
    && rm -rf /tmp/dc-source /tmp/double-cross-source.zip /tmp/source-archive

WORKDIR /app/server
RUN npm ci && npm run build

WORKDIR /app/client
RUN npm ci && npm run build

WORKDIR /app/server
ENV NODE_ENV=production
CMD ["npm", "start"]
