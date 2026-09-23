"use strict";
/*
 * fixtures.js — a small music library made on the spot with ffmpeg, so the
 * tests use real files in every format the server has to decide about.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

function haveFfmpeg() {
  try { return spawnSync(FFMPEG, ["-version"]).status === 0; } catch (e) { return false; }
}

function gen(out, { seconds = 3, freq = 440, rate = 44100, fmt = "s16", codecArgs = [], tags = {} }) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const meta = Object.entries(tags).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]);
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}:sample_rate=${rate}`,
    "-ac", "2", "-ar", String(rate), ...(fmt ? ["-sample_fmt", fmt] : []), ...codecArgs, ...meta, out]);
  if (r.status !== 0) throw new Error("ffmpeg: " + r.stderr);
}

function makeLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-test-"));
  const music = path.join(root, "music");
  for (let i = 1; i <= 3; i++) {
    gen(path.join(music, "Artist A", "Album One", `0${i} Song ${i}.flac`), {
      freq: 200 * i, tags: { title: `Song ${i}`, artist: "Artist A", album: "Album One", track: i, date: "1997", genre: "Rock", label: "Parlophone" }
    });
  }
  for (let i = 1; i <= 2; i++) {
    gen(path.join(music, "Artist B", "Hi Res", `0${i} Hi ${i}.flac`), {
      rate: 96000, fmt: "s32", codecArgs: ["-bits_per_raw_sample", "24"], seconds: 4,
      tags: { title: `Hi ${i}`, artist: "Artist B", album: "Hi Res", track: i, date: "2020", genre: "Jazz" }
    });
  }
  gen(path.join(music, "Comp", "CD1", "01.mp3"), { fmt: null, codecArgs: ["-b:a", "192k"], tags: { title: "C1", artist: "X", album: "Best Of", track: 1 } });
  gen(path.join(music, "Comp", "CD2", "01.mp3"), { fmt: null, codecArgs: ["-b:a", "192k"], tags: { title: "C2", artist: "Y", album: "Best Of", track: 1, disc: 2 } });
  spawnSync(FFMPEG, ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=500x500", "-frames:v", "1",
    path.join(music, "Artist A", "Album One", "cover.jpg")]);
  return { root, music, data: path.join(root, "data") };
}

function probe(buf) {
  // Stream info of a FLAC read straight from its STREAMINFO block: sample
  // rate (20 bits), channels (3), bits per sample (5).
  if (!buf || buf.length < 42 || buf.toString("ascii", 0, 4) !== "fLaC") return null;
  const si = buf.subarray(8, 8 + 34);
  const rate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
  const channels = ((si[12] >> 1) & 0x7) + 1;
  const bits = (((si[12] & 1) << 4) | (si[13] >> 4)) + 1;
  return { rate, channels, bits };
}

module.exports = { haveFfmpeg, makeLibrary, gen, probe, FFMPEG };
