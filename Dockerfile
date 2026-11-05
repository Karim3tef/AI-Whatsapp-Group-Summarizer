# AI WhatsApp Group Summarizer — container image
# Uses Debian's Chromium instead of Puppeteer's download (smaller and easier).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

# Writable folders: WhatsApp session + data (volumes) and the WhatsApp Web cache.
RUN mkdir -p /app/data /app/.wwebjs_auth /app/.wwebjs_cache \
 && chown -R node:node /app/data /app/.wwebjs_auth /app/.wwebjs_cache
USER node

EXPOSE 3000
CMD ["node", "src/index.js"]
