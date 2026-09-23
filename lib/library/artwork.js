"use strict";
/*
 * artwork.js — album covers, sized for the screen asking.
 *
 * A cover comes from the album's folder (cover.jpg, folder.jpg…) or, failing
 * that, the picture embedded in its first track. Covers are often several
 * megabytes; a tile wants a few kilobytes, so each size is rendered once with
 * sharp and kept on disk. Sizes are snapped to a handful of steps so the cache
 * does not fill with 401px and 403px copies of the same thing.
 *
 * Keys carry a fingerprint of the source file, so a replaced cover is a new
 * URL and browsers can cache every image forever.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const sharp = require("sharp");

const STEPS = [120, 200, 300, 400, 600, 800, 1200];
sharp.cache(false);
sharp.concurrency(2);

function snap(size) {
  const s = Math.max(64, Math.min(1200, Number(size) || 400));
  return STEPS.find(x => x >= s) || 1200;
}

let mmPromise = null;
function mm() { return mmPromise || (mmPromise = import("music-metadata")); }

async function embeddedPicture(file) {
  const { parseFile } = await mm();
  const md = await parseFile(file, { skipCovers: false, duration: false });
  const pics = (md.common && md.common.picture) || [];
  const front = pics.find(p => /front/i.test(p.type || "")) || pics[0];
  return front ? Buffer.from(front.data) : null;
}

function fetchUrl(url, depth = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 3) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, url).toString(), depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      const chunks = [];
      let n = 0;
      res.on("data", c => { n += c.length; if (n > 15 * 1024 * 1024) req.destroy(new Error("too large")); else chunks.push(c); });
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

function escapeXml(t) {
  return String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

// A cover for an album that has none: a colour of its own (from its name, so
// it is the same every time), a note, and the title and artist.
async function placeholder(al, size) {
  const h = crypto.createHash("md5").update(al.title + "|" + al.artist).digest();
  const hue = Math.round((h[0] / 255) * 360);
  const wrap = (text, max) => {
    const words = String(text).split(/\s+/), lines = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim();
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 3);
  };
  const title = wrap(al.title, 16);
  const tspans = title.map((l, i) => `<tspan x="40" dy="${i ? 58 : 0}">${escapeXml(l)}</tspan>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},38%,30%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},45%,14%)"/>
    </linearGradient></defs>
    <rect width="600" height="600" fill="url(#g)"/>
    <text x="540" y="140" font-family="sans-serif" font-size="110" fill="rgba(255,255,255,0.18)" text-anchor="end">♪</text>
    <text x="40" y="${470 - (title.length - 1) * 58}" font-family="sans-serif" font-weight="700" font-size="50" fill="#fff">${tspans}</text>
    <text x="40" y="540" font-family="sans-serif" font-size="30" fill="rgba(255,255,255,0.75)">${escapeXml(String(al.artist).slice(0, 34))}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).resize(size, size).jpeg({ quality: 85 }).toBuffer();
}

class Artwork {
  constructor({ library, cacheDir, log = () => {} }) {
    this.library = library;
    this.dir = cacheDir;
    this.log = log;
    this.inflight = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /* Foreign art (a radio station, a track queued from the Sonos app) travels
   * as a key that wraps its URL, so the page asks for it the same way. */
  static foreignKey(url) {
    return "u-" + Buffer.from(url).toString("base64url");
  }

  async source(key) {
    if (key.startsWith("u-")) {
      let url;
      try { url = Buffer.from(key.slice(2), "base64url").toString("utf8"); } catch (e) { return null; }
      if (!/^https?:\/\//.test(url)) return null;
      // Only ever a player on the LAN or a public image host; never this server.
      return { buf: await fetchUrl(url), id: crypto.createHash("sha1").update(url).digest("hex").slice(0, 16) };
    }
    const m = /^al-(\d+)-/.exec(key);
    if (!m) return null;
    const al = this.library.album(Number(m[1]));
    if (!al) return null;
    if (al.artPath) {
      try { return { buf: await fs.promises.readFile(al.artPath), id: `${al.id}-${al.artHash}` }; } catch (e) { /* moved: try embedded */ }
    }
    const tracks = this.library.tracks(al.id);
    for (const t of tracks.slice(0, 3)) {
      try {
        const buf = await embeddedPicture(t.path);
        if (buf) return { buf, id: `${al.id}-${al.artHash}` };
      } catch (e) { /* unreadable tag: next track */ }
    }
    return null;
  }

  /* → { file, type } or null. */
  async get(key, size) {
    const s = snap(size);
    const safe = key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 200);
    const file = path.join(this.dir, `${safe}@${s}.jpg`);
    if (fs.existsSync(file)) return { file, type: "image/jpeg" };
    const k = file;
    if (this.inflight.has(k)) return this.inflight.get(k);
    const p = (async () => {
      const src = await this.source(key);
      if (!src || !src.buf) {
        // No cover anywhere: a drawn one, so the wall never shows a broken
        // image. Album keys only — foreign art that fails is simply absent.
        const m = /^al-(\d+)-/.exec(key);
        const al = m && this.library.album(Number(m[1]));
        if (!al) return null;
        return this.write(file, await placeholder(al, s));
      }
      const out = await sharp(src.buf, { failOn: "none" })
        .rotate()
        .resize(s, s, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#000" })
        .jpeg({ quality: 86, mozjpeg: true })
        .toBuffer();
      return this.write(file, out);
    })().catch((e) => { this.log(`[art] ${key}: ${e.message}`); return null; })
      .finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  async write(file, buf) {
    const tmp = file + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, file);
    return { file, type: "image/jpeg" };
  }

  /* Warm the tile size for every album in the background after a scan, so the
   * first scroll through the Library wall is not a render per tile. */
  async prewarm(size = 400) {
    for (const al of this.library.albums) {
      await this.get(al.image_key, size).catch(() => null);
      await new Promise(r => setImmediate(r));
    }
  }
}

module.exports = { Artwork, snap };
