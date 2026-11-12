# Pechu image. Secrets (GEMINI_API_KEY, SARVAM_API_KEY, PECHU_PASSWORD, SESSION_SECRET) are
# passed at run time as env vars and are never baked into the image.
FROM oven/bun:1.4.4-debian

# GStreamer is used by server/audio.ts (gst-launch-1.0 with decodebin) to decode
# mp3/m4a/aac/ogg/webm/flac uploads.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      gstreamer1.0-tools \
      gstreamer1.0-plugins-base \
      gstreamer1.0-plugins-good \
      gstreamer1.0-plugins-bad \
      gstreamer1.0-libav \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY server/ ./server/
COPY public/ ./public/

# /data holds the meetings and the .env the app may write the Gemini key to.
# The base image's "bun" user (uid 1000) is not root.
RUN mkdir -p /data/meetings && chown -R bun:bun /data /app
USER bun

ENV HOST=0.0.0.0 \
    PORT=4317 \
    PECHU_DATA_DIR=/data/meetings \
    ENV_FILE=/data/.env \
    NODE_ENV=production

VOLUME /data
EXPOSE 4317

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["bun", "server/index.ts"]
