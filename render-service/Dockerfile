# Build context is the REPO ROOT, not this folder: the service loads the very same
# gpl-design-render.js and gpl-fabric.min.js the storefront serves, so both have to
# be in the image. Railway: leave Root Directory empty, set Dockerfile Path to
# render-service/Dockerfile.
FROM ghcr.io/puppeteer/puppeteer:23.11.1

# The base image ships Chromium and already sets PUPPETEER_EXECUTABLE_PATH.
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app
USER root

COPY render-service/package.json ./render-service/
RUN cd render-service && npm install --omit=dev --no-audit --no-fund

# Shared with the storefront — copied so the print file is drawn by the same code
COPY assets/gpl-design-render.js assets/gpl-fabric.min.js ./assets/
COPY render-service/ ./render-service/

RUN chown -R pptruser:pptruser /app
USER pptruser
WORKDIR /app/render-service

EXPOSE 3000
CMD ["node", "server.js"]
