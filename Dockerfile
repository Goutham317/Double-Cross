FROM node:22-bookworm-slim

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

WORKDIR /app/server
ENV NODE_ENV=production
CMD ["npm", "start"]
