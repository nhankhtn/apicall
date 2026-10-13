# ApiCall Runner: web UI + proxy/realtime server.
#   docker build -t apicall .
#   docker run -p 3939:3939 -v apicall-data:/data -e APICALL_USER=me -e APICALL_PASSWORD=secret apicall

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.title="apicall-runner"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3939 \
    DATA_DIR=/data

WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node server ./server
COPY --chown=node:node src/lib ./src/lib
COPY --chown=node:node src/db.js ./src/db.js
COPY --chown=node:node bin ./bin

# The server keeps legacy data and attachments in /data; collections live in each browser.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3939
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3939) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server.js"]
