# MusicD Server — your own music files, played to Sonos.
#
# Two stages: native modules (better-sqlite3, sharp) are installed where a
# compiler is available in case a platform has no prebuilt binary, and the
# image that runs carries only Node, ffmpeg and the app.
FROM node:22-bookworm-slim AS deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="MusicD Server" \
      org.opencontainers.image.description="Your own music files, played to Sonos, with MusicD Remote's interface" \
      org.opencontainers.image.source="https://github.com/meltface-80/MusicD-Server" \
      org.opencontainers.image.licenses="MIT"

# ffmpeg converts anything above 24-bit/48 kHz (and formats Sonos cannot
# read) to FLAC 24/48. Debian's build includes libsoxr, the better resampler.
# tini reaps ffmpeg children and passes SIGTERM on, so a stop is immediate.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json index.js launcher.js reset-password.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    DOCKER=1 \
    PORT=3500 \
    MUSIC_DIR=/music \
    DATA_DIR=/app/data

# The data volume holds the library database, play history, settings, the
# artwork cache and the transcode cache. Keep it across upgrades.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# Informational: host networking is required (SSDP to find the speakers, and
# the speakers must reach this port to fetch audio).
EXPOSE 3500

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3500)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# launcher.js runs the server and, when Settings → Check for updates installs
# a new release, swaps the files in while the server is stopped and starts it
# again — the container keeps running throughout.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "launcher.js"]
