"use strict";
/*
 * stream.js — what a Sonos player is handed for each track, and serving it.
 *
 * THE RULE: Sonos S2 plays up to 24-bit / 48 kHz. Anything within that, in a
 * container Sonos reads, goes out as the stored file, byte for byte. Anything
 * above it is brought down to 24/48 — resampled, never dropped to a lossy
 * format, because losing the rate above 48 kHz is a far smaller loss than
 * losing lossless coding. Formats Sonos cannot read at all (DSD, WMA lossless,
 * APE, WavPack, Opus…) are converted to FLAC within the same ceiling.
 *
 * A transcode is written to a cache file, and a request that arrives while it
 * is still being written is served from the growing file: the speaker starts
 * as soon as the first frames exist, and every later request (a seek, a replay,
 * the next time the album is played) gets the finished file with a length and
 * byte ranges. Upcoming tracks are prepared ahead, so by the time Sonos asks for
 * the next track it is usually already complete.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const FF = require("./ffmpeg");

const MAX_RATE = 48000;
const MAX_BITS = 24;

// codec (as music-metadata names it, lowercased) → the MIME Sonos matches on.
function nativeMime(t) {
  const codec = String(t.codec || "").toLowerCase();
  const ext = path.extname(t.path || "").toLowerCase();
  if (codec === "flac" && (ext === ".flac" || ext === ".fla")) return "audio/flac";
  if (ext === ".mp3" && (!codec || /mpeg|mp3/.test(codec))) return "audio/mpeg";
  if (codec === "alac" && /\.(m4a|mp4|alac)$/.test(ext)) return "audio/mp4";
  if (/^aac|mpeg-4\/aac|^mp4a/.test(codec) && /\.(m4a|mp4|m4b)$/.test(ext)) return "audio/mp4";
  if (/^aac/.test(codec) && ext === ".aac") return "audio/aac";
  if (codec === "vorbis" && /\.(ogg|oga)$/.test(ext)) return "audio/ogg";
  // Uncompressed PCM: Sonos documents WAV/AIFF at 16 bits. Deeper files are
  // still lossless as FLAC, sample for sample, so they go that way instead.
  const pcm = /pcm|65534|^$/.test(codec);
  if (pcm && /\.wave?$/.test(ext) && (t.bitsPerSample || 16) <= 16) return "audio/wav";
  if (pcm && /\.aif[fc]?$/.test(ext) && (t.bitsPerSample || 16) <= 16) return "audio/aiff";
  return null;
}

/*
 * Decide how one track goes to the speaker.
 * → { transcode: false, mime, ext, reason }  or
 *   { transcode: true, mime: "audio/flac", ext: "flac", rate, bits, reason }
 */
function plan(t) {
  const rate = Number(t.sampleRate) || 0;
  const bits = Number(t.bitsPerSample) || 0;
  const channels = Number(t.channels) || 2;
  const mime = nativeMime(t);
  const tooHigh = rate > MAX_RATE || bits > MAX_BITS;
  const dsd = /dsd|dsf|dff/i.test(String(t.codec || "")) || /\.(dsf|dff)$/i.test(t.path || "");
  if (mime && !tooHigh && channels <= 2 && !dsd) {
    return { transcode: false, mime, ext: path.extname(t.path).slice(1).toLowerCase(), reason: "bit-perfect" };
  }
  let reason;
  if (dsd) reason = "DSD, which Sonos does not play";
  else if (tooHigh) reason = `${bits || "?"}-bit/${rate ? rate / 1000 : "?"} kHz is above what Sonos takes`;
  else if (channels > 2) reason = `${channels} channels, folded down to stereo`;
  else if (/\.(wave?|aif[fc]?)$/i.test(t.path || "")) reason = `${bits || "?"}-bit uncompressed, repacked as FLAC with the same samples`;
  else reason = `a ${t.codec || "file"} Sonos cannot read`;
  // Anything resampled, or decoded from DSD / float, carries more than 16 bits
  // of information afterwards, so it goes out at 24. A native-rate 16-bit
  // source in an unreadable container stays 16-bit — nothing is added.
  const outRate = dsd ? MAX_RATE : (rate > MAX_RATE || !rate ? MAX_RATE : rate);
  const outBits = (dsd || rate > MAX_RATE || bits > 16 || !bits) ? 24 : 16;
  return { transcode: true, mime: "audio/flac", ext: "flac", rate: outRate, bits: outBits, reason };
}

function ffmpegArgs(src, p, dest) {
  const ff = FF.info();
  const resampler = ff.soxr ? "resampler=soxr:precision=28:" : "";
  const dither = p.bits === 16 ? "dither_method=triangular_hp" : "dither_method=triangular";
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-i", src,
    "-map", "0:a:0",
    "-vn",
    "-af", `aresample=${resampler}osr=${p.rate}:${dither}`,
    "-ar", String(p.rate),
    "-ac", "2",
    "-sample_fmt", p.bits === 16 ? "s16" : "s32",
    "-bits_per_raw_sample", String(p.bits),
    "-map_metadata", "0",
    "-c:a", "flac", "-compression_level", "5",
    "-f", "flac",
    dest
  ];
}

class Transcoder {
  constructor({ cacheDir, maxBytes = 4 * 1024 ** 3, log = console.log }) {
    this.dir = cacheDir;
    this.maxBytes = maxBytes;
    this.log = log;
    this.jobs = new Map();   // key -> { promise, part, proc, done, failed }
    this.queue = [];         // background prefetch: [{ key, track, plan }]
    this.running = 0;
    this.concurrency = Math.max(1, Number(process.env.TRANSCODE_CONCURRENCY) || 2);
    fs.mkdirSync(this.dir, { recursive: true });
    // Leftover partial files from a crash are never complete.
    for (const f of fs.readdirSync(this.dir)) {
      if (f.endsWith(".part")) { try { fs.unlinkSync(path.join(this.dir, f)); } catch (e) { /* removed by someone else */ } }
    }
  }

  keyFor(track, p) {
    const mtime = Math.floor(Number(track.mtime) || 0);
    return `${track.id}-${mtime}-${p.rate}-${p.bits}`;
  }

  finalPath(key) { return path.join(this.dir, key + ".flac"); }

  status(track, p) {
    const key = this.keyFor(track, p);
    if (fs.existsSync(this.finalPath(key))) return "ready";
    const j = this.jobs.get(key);
    return j ? "running" : "none";
  }

  /* Start (or join) a transcode now. Resolves with the job. */
  start(track, p) {
    const key = this.keyFor(track, p);
    const dest = this.finalPath(key);
    if (fs.existsSync(dest)) {
      const now = new Date();
      try { fs.utimesSync(dest, now, now); } catch (e) { /* LRU touch is best-effort */ }
      return { key, done: true, failed: false, final: dest, part: dest };
    }
    const existing = this.jobs.get(key);
    if (existing) return existing;

    const part = dest + ".part";
    const job = { key, done: false, failed: false, final: dest, part, waiters: new Set(), error: "" };
    const ff = FF.info();
    const proc = spawn(ff.bin, ffmpegArgs(track.path, p, part), { stdio: ["ignore", "ignore", "pipe"] });
    job.proc = proc;
    let err = "";
    proc.stderr.on("data", d => { if (err.length < 4000) err += d.toString(); });
    job.promise = new Promise((resolve) => {
      proc.on("error", (e) => { err += e.message; });
      proc.on("close", (code) => {
        if (code === 0 && fs.existsSync(part)) {
          try { fs.renameSync(part, dest); } catch (e) { job.failed = true; err += e.message; }
        } else {
          job.failed = true;
          try { fs.unlinkSync(part); } catch (e) { /* ffmpeg may not have created it */ }
        }
        job.done = true;
        job.error = err.trim();
        if (job.failed) this.log(`[stream] transcode failed for ${track.path}: ${job.error.slice(0, 300)}`);
        this.jobs.delete(key);
        for (const w of job.waiters) w();
        resolve(job);
        this.prune();
      });
    });
    this.jobs.set(key, job);
    this.log(`[stream] ${path.basename(track.path)}: ${p.reason} → FLAC ${p.bits}/${p.rate / 1000} kHz`);
    return job;
  }

  /* Queue tracks to be prepared in the background, in order. */
  prefetch(items) {
    for (const { track, plan: p } of items) {
      if (!p.transcode) continue;
      const key = this.keyFor(track, p);
      if (this.jobs.has(key) || fs.existsSync(this.finalPath(key))) continue;
      if (this.queue.some(q => q.key === key)) continue;
      this.queue.push({ key, track, plan: p });
    }
    this.pump();
  }

  pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const { track, plan: p } = this.queue.shift();
      const job = this.start(track, p);
      if (job.done) continue;
      this.running++;
      job.promise.then(() => { this.running--; this.pump(); });
    }
  }

  /* Keep the cache under its ceiling, least recently used first. */
  prune() {
    let files;
    try {
      files = fs.readdirSync(this.dir).filter(f => f.endsWith(".flac")).map(f => {
        const full = path.join(this.dir, f);
        const st = fs.statSync(full);
        return { full, size: st.size, t: st.mtimeMs };
      });
    } catch (e) { return; }
    let total = files.reduce((a, f) => a + f.size, 0);
    files.sort((a, b) => a.t - b.t);
    while (total > this.maxBytes && files.length > 1) {
      const f = files.shift();
      try { fs.unlinkSync(f.full); total -= f.size; } catch (e) { /* in use or gone */ }
    }
  }

  cacheStats() {
    try {
      const files = fs.readdirSync(this.dir).filter(f => f.endsWith(".flac"));
      const bytes = files.reduce((a, f) => a + fs.statSync(path.join(this.dir, f)).size, 0);
      return { files: files.length, bytes, running: this.jobs.size, queued: this.queue.length };
    } catch (e) { return { files: 0, bytes: 0, running: 0, queued: 0 }; }
  }
}

/*
 * Serve a file that is still being written: send what exists, wait for more,
 * stop when the writer finishes. No Content-Length — the length is not known
 * yet — so this goes out chunked, the way an internet radio stream does.
 */
function tailFollow(req, res, job, mime) {
  res.status(200);
  res.set({ "Content-Type": mime, "Cache-Control": "no-store", "Accept-Ranges": "none" });
  if (req.method === "HEAD") return res.end();
  let pos = 0;
  let fd = null;
  let closed = false;
  const buf = Buffer.alloc(256 * 1024);
  const cleanup = () => {
    closed = true;
    job.waiters && job.waiters.delete(wake);
    if (fd != null) { try { fs.closeSync(fd); } catch (e) { /* already closed */ } fd = null; }
  };
  let timer = null;
  const wake = () => { if (timer) { clearTimeout(timer); timer = null; } setImmediate(pump); };
  req.on("close", cleanup);
  const openFile = () => {
    const f = job.done && !job.failed ? job.final : job.part;
    try { return fs.openSync(f, "r"); } catch (e) { return null; }
  };
  function pump() {
    if (closed) return;
    if (fd == null) fd = openFile();
    if (fd == null) {
      if (job.done) { cleanup(); return job.failed ? res.destroy() : res.end(); }
      timer = setTimeout(pump, 100);
      return;
    }
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, buf.length, pos); } catch (e) {
      // The .part was renamed under us: reopen the finished file at the same place.
      try { fs.closeSync(fd); } catch (e2) { /* already closed */ }
      fd = null;
      return setImmediate(pump);
    }
    if (n > 0) {
      pos += n;
      const ok = res.write(Buffer.from(buf.subarray(0, n)));
      if (ok) setImmediate(pump); else res.once("drain", pump);
      return;
    }
    if (job.done) {
      // Renamed? The part fd still reads the same inode, so a zero read here
      // after done really is the end.
      cleanup();
      return res.end();
    }
    job.waiters && job.waiters.add(wake);
    timer = setTimeout(pump, 200);
  }
  pump();
}

module.exports = { plan, nativeMime, ffmpegArgs, Transcoder, tailFollow, MAX_RATE, MAX_BITS };
