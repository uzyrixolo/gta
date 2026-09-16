# Build context is the REPO ROOT, not this folder: the service loads the very same
# gpl-design-render.js and gpl-fabric.min.js the storefront serves, so both have to
# be in the image. Railway: leave Root Directory empty, Dockerfile Path is
# render-service/Dockerfile (railway.json at the repo root already sets this).
FROM node:22-bookworm-slim

# Chromium from the distro rather than puppeteer's download: one known-good binary,
# no cache-dir/user mismatch, and it is already built for this image's libc.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ca-certificates fontconfig fonts-liberation \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libpango-1.0-0 libcairo2 libasound2 \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY render-service/package.json render-service/package-lock.json ./render-service/
RUN cd render-service && npm ci --omit=dev --no-audit --no-fund

# Shared with the storefront — copied so the print file is drawn by the same code
COPY assets/gpl-design-render.js assets/gpl-fabric.min.js ./assets/
COPY render-service/ ./render-service/

# Chromium will not run as root without --no-sandbox tricks; use a plain user.
RUN useradd -m -u 10001 app && chown -R app:app /app
USER app
WORKDIR /app/render-service

EXPOSE 3000
CMD ["node", "server.js"]
