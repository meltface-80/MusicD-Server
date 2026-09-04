FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="MusicD Server" \
      org.opencontainers.image.description="A simple local music server for Sonos" \
      org.opencontainers.image.source="https://github.com/meltface-80/MusicD-Server" \
      org.opencontainers.image.licenses="MIT"

# python3/make/g++ are here for better-sqlite3, which builds from source on any
# platform without a published prebuild — notably arm64, which is what a NAS or
# a Raspberry Pi is.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# This step also brings in ffmpeg-static (~80 MB), which is what decodes a
# track to draw its waveform. It is a normal dependency rather than an apt
# package so the binary is pinned with the app and the same one runs on arm64 —
# a NAS or a Pi — as on anything else. lib/waveform-decode.js falls back to an
# ffmpeg on PATH if it is ever missing, and to no waveform at all if there is
# none: the seek bar then looks exactly as it did before the feature existed.
COPY package*.json ./
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
RUN npm install --omit=dev --no-audit --no-fund --loglevel=error

COPY index.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /app/data/cache/art
VOLUME /app/data

# THE TIME ZONE MATTERS HERE, which is not true of most containers. "Not played
# in 6 months" is a calendar boundary and Smart Picks rebuild once a local day,
# so a container left on UTC quietly moves both by up to a day. Override it:
#   -e TZ=Europe/London      (or bind-mount the host's /etc/localtime)
ENV TZ=Etc/UTC

ENV PORT=3400 \
    MUSIC_DIRS=/music \
    DATA_DIR=/app/data

# Which build this is. Baked in at build time so a running container can say
# exactly what it is — "same version, no changes" is impossible to diagnose
# when every build calls itself the same thing. The workflow fills these in;
# a local `docker build` leaves them empty and the app falls back to the
# version in package.json.
ARG BUILD_COMMIT=""
ARG BUILD_DATE=""
ARG BUILD_REF=""
ENV BUILD_COMMIT=$BUILD_COMMIT \
    BUILD_DATE=$BUILD_DATE \
    BUILD_REF=$BUILD_REF

EXPOSE 3400

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3400)+'/api/status',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "index.js"]
