"use strict";
/*
 * ffmpeg.js — where the ffmpeg binary is, and what it was built with.
 *
 * The Docker image installs Debian's ffmpeg; FFMPEG_PATH points anywhere else.
 * Whether it has libsoxr decides the resampler: soxr at high precision is the
 * better converter for a 96k → 48k step, and swr is the fallback that every
 * build has.
 */
const { spawnSync } = require("child_process");

let cached = null;

function info() {
  if (cached) return cached;
  const bin = process.env.FFMPEG_PATH || "ffmpeg";
  let ok = false, soxr = false, version = "";
  try {
    const r = spawnSync(bin, ["-hide_banner", "-buildconf"], { encoding: "utf8", timeout: 10000 });
    ok = r.status === 0;
    soxr = /--enable-libsoxr/.test(r.stdout || "");
    const v = spawnSync(bin, ["-hide_banner", "-version"], { encoding: "utf8", timeout: 10000 });
    version = ((v.stdout || "").split("\n")[0] || "").trim();
  } catch (e) {
    ok = false;
  }
  cached = { bin, ok, soxr, version };
  return cached;
}

module.exports = { info };
