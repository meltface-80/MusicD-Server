"use strict";
/*
 * downloads.js — albums onto the Android app, to play with no server.
 *
 * Two qualities, chosen per download:
 *   original  the file as it is on disk. Formats a phone can't play (DSD,
 *             APE, WavPack, ALAC, AIFF, >2 channels) become FLAC with the
 *             same sample rate and up to 24 bits — still lossless.
 *   opus      Opus at 256 kbps (Ogg): about a tenth of the size, and very hard
 *             to tell apart on headphones.
 * Converted files are made once with ffmpeg and kept in a cache, like the
 * 24/48 files Sonos gets.
 *
 *   GET  /api/download/album?offset=&quality=   the album and its tracks
 *   GET  /api/download/t<id>?quality=           one track (Range supported)
 *   POST /api/download/albums {ids}             current titles/covers/edits
 *   POST /api/phone/plays {plays}               plays made offline
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const FF = require("../ffmpeg");
const STREAM = require("../stream");

const QUALITIES = ["original", "opus"];
const OPUS_KBPS = 256;

// What Android (ExoPlayer, no extensions) plays as it is.
function phonePlays(t) {
  const ext = path.extname(t.path || "").toLowerCase();
  const codec = String(t.codec || "").toLowerCase();
  if ((Number(t.channels) || 2) > 2) return false;
  if (ext === ".flac" || ext === ".fla") return codec === "flac" || !codec;
  if (ext === ".mp3") return true;
  if (/\.(m4a|mp4|aac|m4b)$/.test(ext)) return /^aac|mp4a|mpeg-4\/aac/.test(codec);
  if (/\.(ogg|oga|opus)$/.test(ext)) return /vorbis|opus/.test(codec) || !codec;
  if (/\.wave?$/.test(ext)) return (Number(t.bits) || 16) <= 24 && /pcm|^$/.test(codec);
  return false;
}

function mimeFor(ext) {
  return {
    flac: "audio/flac", fla: "audio/flac", mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", m4b: "audio/mp4",
    aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", wave: "audio/wav"
  }[ext] || "application/octet-stream";
}

class Downloads {
  constructor({ cacheDir, maxBytes = 4 * 1024 ** 3, log = console.log }) {
    this.dir = cacheDir;
    this.maxBytes = maxBytes;
    this.log = log;
    this.jobs = new Map();
    this.running = 0;
    this.waiting = [];
    this.concurrency = 2;
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir)) {
      if (f.endsWith(".part")) { try { fs.unlinkSync(path.join(this.dir, f)); } catch (e) { /* gone */ } }
    }
  }

  /* How a track goes out at this quality → { file?, convert?, ext, mime } */
  plan(t, quality) {
    if (quality === "opus") {
      if (/\.opus$/i.test(t.path)) return { file: t.path, ext: "opus", mime: "audio/ogg" };
      return { convert: "opus", ext: "opus", mime: "audio/ogg" };
    }
    if (phonePlays(t)) {
      const ext = path.extname(t.path).slice(1).toLowerCase();
      return { file: t.path, ext, mime: mimeFor(ext) };
    }
    return { convert: "flac", ext: "flac", mime: "audio/flac" };
  }

  keyFor(t, p) {
    const bits = Math.min(24, Number(t.bits) || 24);
    return `${t.id}-${Math.floor(Number(t.mtime) || 0)}-${p.convert === "opus" ? "opus" + OPUS_KBPS : "flac" + bits}`;
  }

  args(t, p, dest) {
    if (p.convert === "opus") {
      return ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", t.path,
        "-map", "0:a:0", "-vn", "-ac", "2", "-map_metadata", "0",
        "-c:a", "libopus", "-b:a", OPUS_KBPS + "k", "-vbr", "on", "-f", "ogg", dest];
    }
    // Lossless: the same rate (DSD comes down to 88.2 kHz), up to 24 bits.
    const dsd = /dsd|dsf|dff/i.test(String(t.codec || "")) || /\.(dsf|dff)$/i.test(t.path || "");
    const rate = dsd ? 88200 : (Number(t.sample_rate) || 44100);
    const bits = dsd ? 24 : (Number(t.bits) || 24) > 16 ? 24 : 16;
    return STREAM.ffmpegArgs(t.path, { rate, bits }, dest);
  }

  /* The file to send for this track at this quality (converted if need be). */
  async file(t, quality) {
    const p = this.plan(t, quality);
    if (p.file) return { path: p.file, ext: p.ext, mime: p.mime };
    const key = this.keyFor(t, p);
    const dest = path.join(this.dir, key + "." + p.ext);
    if (fs.existsSync(dest)) {
      const now = new Date();
      try { fs.utimesSync(dest, now, now); } catch (e) { /* best effort */ }
      return { path: dest, ext: p.ext, mime: p.mime };
    }
    let job = this.jobs.get(key);
    if (!job) {
      job = this.convert(t, p, dest).finally(() => this.jobs.delete(key));
      this.jobs.set(key, job);
    }
    await job;
    return { path: dest, ext: p.ext, mime: p.mime };
  }

  async convert(t, p, dest) {
    if (this.running >= this.concurrency) await new Promise(r => this.waiting.push(r));
    this.running++;
    try {
      const part = dest + ".part";
      await new Promise((resolve, reject) => {
        const proc = spawn(FF.info().bin, this.args(t, p, part), { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        proc.stderr.on("data", d => { if (err.length < 2000) err += d; });
        proc.on("error", reject);
        proc.on("close", (code) => {
          if (code === 0 && fs.existsSync(part)) { fs.renameSync(part, dest); resolve(); }
          else {
            try { fs.unlinkSync(part); } catch (e) { /* never made */ }
            reject(new Error(`conversion failed: ${err.trim().slice(0, 300)}`));
          }
        });
      });
      this.prune();
    } finally {
      this.running--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }

  prune() {
    let files;
    try {
      files = fs.readdirSync(this.dir).filter(f => !f.endsWith(".part")).map(f => {
        const full = path.join(this.dir, f);
        const st = fs.statSync(full);
        return { full, size: st.size, t: st.mtimeMs };
      });
    } catch (e) { return; }
    let total = files.reduce((a, f) => a + f.size, 0);
    files.sort((a, b) => a.t - b.t);
    while (total > this.maxBytes && files.length > 1) {
      const f = files.shift();
      try { fs.unlinkSync(f.full); total -= f.size; } catch (e) { /* in use */ }
    }
  }
}

function mount(app, ctx) {
  const { library, auth, db } = ctx;
  const downloads = ctx.downloads;
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { if (!res.headersSent) res.status(e.status || 500).json({ error: e.message || String(e) }); }
  };
  const quality = q => (QUALITIES.includes(q) ? q : "original");
  const artUrl = al => auth.signUrl(`${ctx.baseUrl()}/api/image/${encodeURIComponent(al.image_key)}?size=1200`);

  function albumJson(al, q) {
    const tracks = library.tracks(al.id).map(t => {
      const p = downloads.plan(t, q);
      return {
        id: t.id, title: t.title, artist: t.artist || al.artist, disc_no: t.disc_no || 1, track_no: t.track_no || null,
        duration: t.duration || 0, ext: p.ext,
        // Exact for a file sent as it is; an estimate for a conversion.
        size: p.file ? t.size : Math.round((t.duration || 0) * (p.convert === "opus" ? OPUS_KBPS * 125 : 110000)),
        path: `/api/download/t${t.id}?quality=${q}`
      };
    });
    return {
      id: al.id, title: al.title, artist: al.artist, year: al.year || null, genres: al.genres || [],
      image_key: al.image_key, art_url: artUrl(al), quality: q, tracks,
      size: tracks.reduce((a, t) => a + (t.size || 0), 0)
    };
  }

  app.get("/api/download/album", (req, res) => {
    const al = library.album(req.query.offset);
    if (!al) return res.status(404).json({ error: "That album is no longer in the library" });
    res.json(albumJson(al, quality(req.query.quality)));
  });

  app.get(/^\/api\/download\/t(\d+)$/, wrap(async (req, res) => {
    const t = library.track(Number(req.params[0]));
    if (!t) return res.status(404).json({ error: "That track is no longer in the library" });
    const f = await downloads.file(Object.assign({}, t), quality(req.query.quality));
    res.set("Content-Type", f.mime);
    res.set("Cache-Control", "no-store");
    res.set("X-Download-Ext", f.ext);
    res.sendFile(f.path, { dotfiles: "allow", acceptRanges: true, headers: { "Content-Type": f.mime } }, (err) => {
      if (err && !res.headersSent) res.status(err.statusCode || 404).end();
    });
  }));

  // Titles, covers and edits change; the phone asks now and then for its albums.
  app.post("/api/download/albums", (req, res) => {
    const ids = ((req.body || {}).ids || []).map(Number).filter(Number.isFinite).slice(0, 2000);
    res.json({
      albums: ids.map(id => {
        const al = library.album(id);
        return al
          ? { id, exists: true, title: al.title, artist: al.artist, year: al.year || null, image_key: al.image_key, art_url: artUrl(al),
              // The album as every other list has it, for the app's Home row.
              album: library.json(al) }
          : { id, exists: false };
      })
    });
  });

  // Plays made with no server: history, "Not played", Smart Picks stay right.
  app.post("/api/phone/plays", (req, res) => {
    const dev = auth.deviceOf(req);
    if (!dev || dev.kind !== "android") return res.status(403).json({ error: "Only the MusicD Android app sends offline plays" });
    const plays = ((req.body || {}).plays || []).slice(0, 5000);
    const now = Date.now();
    const insert = db.raw.prepare("INSERT INTO plays(album_id, track_id, title, artist, album, zone, ts) VALUES(?, ?, ?, ?, ?, ?, ?)");
    let n = 0;
    db.raw.transaction(() => {
      for (const p of plays) {
        const t = library.track(Number(p.track_id));
        if (!t) continue;
        const al = library.album(t.album_id);
        const ts = Math.min(now, Math.max(now - 90 * 86400000, Number(p.ts) || now));
        insert.run(al ? al.id : null, t.id, t.title, t.artist, al ? al.title : t.album, "PHONE_" + dev.id, ts);
        n++;
      }
    })();
    res.json({ ok: true, recorded: n });
  });
}

module.exports = { Downloads, mount, phonePlays, QUALITIES };
