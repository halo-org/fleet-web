FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
COPY public public

ENV HOST=0.0.0.0 \
    PORT=3000
CMD ["node", "server.mjs"]
