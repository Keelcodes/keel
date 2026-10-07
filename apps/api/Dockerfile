FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

# Zero dependencies, so there is nothing to install. The store lives on a volume
# so the ledger survives a restart.
RUN mkdir -p /data && chown node:node /data
ENV KEEL_API_PORT=8080 \
    KEEL_API_STORE=/data/api-store.json
VOLUME ["/data"]
EXPOSE 8080
USER node

CMD ["node", "src/server.mjs"]
