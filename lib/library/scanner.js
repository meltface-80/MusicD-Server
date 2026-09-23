"use strict";
/*
 * scanner.js — reading the music folder into the database.
 *
 * Incremental: a file whose size and modification time are unchanged is not
 * opened again, so a rescan of an untouched library is a directory walk and
 * nothing else. Work is done one directory at a time, because what an album IS
 * depends on its neighbours: a folder of tracks by different artists with no
 * album-artist tag is one compilation, not twenty one-track albums.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const N = require("./normalize");

const AUDIO_EXT = new Set([
  ".flac", ".fla", ".mp3", ".m4a", ".mp4", ".m4b", ".alac", ".aac", ".wav", ".wave",
  ".aif", ".aiff", ".aifc", ".ogg", ".oga", ".opus", ".dsf", ".dff", ".wv", ".ape", ".wma"
]);
const ART_NAMES = ["cover", "folder", "front", "album", "albumart", "albumartsmall", "thumb"];
const IMG_EXT = [".jpg", ".jpeg", ".png", ".webp"];
const DISC_DIR = /^(cd|disc|disk|side)\s*[-_.]?\s*\d+\b/i;

let mmPromise = null;
function mm() {
  if (!mmPromise) mmPromise = import("music-metadata");
  return mmPromise;
}

function yearOf(v) {
  const m = String(v == null ? "" : v).match(/(\d{4})/);
  if (!m) return null;
  const y = Number(m[1]);
  return y > 1000 && y < 3000 ? y : null;
}

function splitGenres(list) {
  const out = [];
  for (const g of list || []) {
    for (const part of String(g).split(/\s*;\s*|\u0000/)) {
      const t = part.trim();
      if (t && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
    }
  }
  return out;
}

async function readTags(file) {
  const { parseFile } = await mm();
  const md = await parseFile(file, { skipCovers: true, duration: false });
  const c = md.common || {};
  const f = md.format || {};
  const labelTag = (c.label && c.label[0]) || (c.publisher && c.publisher[0]) || null;
  return {
    title: c.title || path.basename(file, path.extname(file)),
    artist: c.artist || (c.artists && c.artists.join(", ")) || "",
    album_artist: c.albumartist || "",
    album: c.album || "",
    artist_sort: c.albumartistsort || c.artistsort || "",
    compilation: !!c.compilation,
    track_no: (c.track && c.track.no) || null,
    disc_no: (c.disk && c.disk.no) || null,
    duration: Number(f.duration) || 0,
    codec: f.codec || null,
    container: f.container || null,
    sample_rate: f.sampleRate || null,
    bits: f.bitsPerSample || null,
    channels: f.numberOfChannels || null,
    lossless: f.lossless ? 1 : 0,
    year: yearOf(c.originaldate) || yearOf(c.originalyear) || yearOf(c.date) || yearOf(c.year),
    label: labelTag ? String(labelTag).trim() : null,
    genres: splitGenres(c.genre)
  };
}

async function walk(root, onDir) {
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const dir = stack.pop();
    let real;
    try { real = fs.realpathSync(dir); } catch (e) { continue; }
    if (seen.has(real)) continue;        // a symlink loop
    seen.add(real);
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
    const files = [];
    const images = [];
    const discDirs = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      let isDir = e.isDirectory(), isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try { const st = fs.statSync(full); isDir = st.isDirectory(); isFile = st.isFile(); } catch (err) { continue; }
      }
      if (isDir) {
        // "CD1", "Disc 2"…: one album split across folders. Read them as part
        // of this folder so the album is decided with every disc in view.
        if (DISC_DIR.test(e.name)) discDirs.push(full); else stack.push(full);
      } else if (isFile) {
        const ext = path.extname(e.name).toLowerCase();
        if (AUDIO_EXT.has(ext)) files.push(full);
        else if (IMG_EXT.includes(ext)) images.push(full);
      }
    }
    const discImages = new Map();
    for (const d of discDirs.sort()) {
      let inner;
      try { inner = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) { continue; }
      const imgs = [];
      for (const e of inner) {
        if (e.name.startsWith(".")) continue;
        const full = path.join(d, e.name);
        const ext = path.extname(e.name).toLowerCase();
        if (e.isDirectory()) stack.push(full);
        else if (AUDIO_EXT.has(ext)) files.push(full);
        else if (IMG_EXT.includes(ext)) imgs.push(full);
      }
      discImages.set(d, imgs);
    }
    if (files.length || images.length) await onDir(dir, files.sort(), images, discImages);
  }
}

function pickArt(images) {
  if (!images.length) return null;
  const scored = images.map(p => {
    const base = path.basename(p, path.extname(p)).toLowerCase();
    let score = 100;
    const i = ART_NAMES.indexOf(base);
    if (i >= 0) score = i;
    else if (/front|cover/.test(base)) score = 20;
    else if (/back|inlay|cd|disc|booklet|tray/.test(base)) score = 200;
    return { p, score };
  }).sort((a, b) => a.score - b.score || a.p.localeCompare(b.p));
  // Only a lone image, or one whose name says what it is, stands for the album.
  if (scored[0].score < 100 || images.length === 1) return scored[0].p;
  return null;
}

function artHash(p) {
  try {
    const st = fs.statSync(p);
    return crypto.createHash("sha1").update(`${p}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 10);
  } catch (e) { return null; }
}

class Scanner {
  constructor({ db, root, log = console.log }) {
    this.db = db.raw;
    this.root = root;
    this.log = log;
    this.state = { running: false, progress: 0, files: 0, parsed: 0, errors: 0, startedAt: null, finishedAt: null, lastResult: null };
    this.prep();
  }

  prep() {
    const d = this.db;
    this.q = {
      trackByPath: d.prepare("SELECT * FROM tracks WHERE path = ?"),
      albumByKey: d.prepare("SELECT id FROM albums WHERE key = ?"),
      insertAlbum: d.prepare(`INSERT INTO albums(key, title, artist, sort_title, sort_artist, dir, added_at, updated_at, compilation)
                              VALUES(@key, @title, @artist, @sort_title, @sort_artist, @dir, @now, @now, @compilation)`),
      upsertTrack: d.prepare(`INSERT INTO tracks(album_id, path, mtime, size, title, artist, album_artist, album, track_no, disc_no, duration,
                                codec, container, sample_rate, bits, channels, lossless, year, label, genres)
                              VALUES(@album_id, @path, @mtime, @size, @title, @artist, @album_artist, @album, @track_no, @disc_no, @duration,
                                @codec, @container, @sample_rate, @bits, @channels, @lossless, @year, @label, @genres)
                              ON CONFLICT(path) DO UPDATE SET album_id=excluded.album_id, mtime=excluded.mtime, size=excluded.size,
                                title=excluded.title, artist=excluded.artist, album_artist=excluded.album_artist, album=excluded.album,
                                track_no=excluded.track_no, disc_no=excluded.disc_no, duration=excluded.duration, codec=excluded.codec,
                                container=excluded.container, sample_rate=excluded.sample_rate, bits=excluded.bits, channels=excluded.channels,
                                lossless=excluded.lossless, year=excluded.year, label=excluded.label, genres=excluded.genres`),
      moveTrack: d.prepare("UPDATE tracks SET album_id = ? WHERE id = ?"),
      deleteTrack: d.prepare("DELETE FROM tracks WHERE id = ?"),
      albumTracks: d.prepare("SELECT * FROM tracks WHERE album_id = ? ORDER BY COALESCE(disc_no,1), COALESCE(track_no, 9999), path"),
      updateAlbum: d.prepare(`UPDATE albums SET year=@year, label=@label, genres=@genres, dir=@dir, art_path=@art_path, art_embedded=@art_embedded,
                               art_hash=@art_hash, track_count=@track_count, duration=@duration, max_rate=@max_rate, max_bits=@max_bits,
                               lossless=@lossless, container=@container, added_at=@added_at, updated_at=@now WHERE id=@id`),
      emptyAlbums: d.prepare("SELECT a.id FROM albums a LEFT JOIN tracks t ON t.album_id = a.id WHERE t.id IS NULL"),
      deleteAlbum: d.prepare("DELETE FROM albums WHERE id = ?")
    };
  }

  /*
   * Decide each track's album within one directory.
   *   - The album-artist tag wins when present.
   *   - A compilation flag, or several track artists on one album title with
   *     no album artist, makes it "Various Artists".
   *   - Otherwise the track artist is the album artist.
   * A missing album tag names the album after its folder (or the folder above
   * a "CD1"-style disc folder).
   */
  groupDir(dir, rows) {
    const byAlbum = new Map();
    const dirName = path.basename(dir);
    for (const r of rows) {
      const title = r.album || dirName;
      const k = N.key(title);
      if (!byAlbum.has(k)) byAlbum.set(k, { title, rows: [] });
      byAlbum.get(k).rows.push(r);
    }
    for (const g of byAlbum.values()) {
      const tagged = g.rows.find(r => r.album_artist);
      const artists = new Set(g.rows.map(r => N.key(r.artist)).filter(Boolean));
      let albumArtist;
      if (tagged) albumArtist = tagged.album_artist;
      else if (g.rows.some(r => r.compilation) || artists.size > 1) albumArtist = "Various Artists";
      else albumArtist = (g.rows[0] && g.rows[0].artist) || "Unknown Artist";
      g.artist = albumArtist;
      g.compilation = N.key(albumArtist) === "various artists" ? 1 : 0;
      g.sortArtist = (g.rows.find(r => r.artist_sort) || {}).artist_sort || albumArtist;
      g.key = N.key(albumArtist) + "\u0001" + N.key(g.title);
    }
    return [...byAlbum.values()];
  }

  albumIdFor(g, dir, now) {
    const hit = this.q.albumByKey.get(g.key);
    if (hit) return hit.id;
    const info = this.q.insertAlbum.run({
      key: g.key, title: g.title, artist: g.artist,
      sort_title: N.sortName(g.title), sort_artist: N.sortName(g.sortArtist),
      dir, now, compilation: g.compilation
    });
    return Number(info.lastInsertRowid);
  }

  /* Recompute an album's derived columns from its tracks. */
  refreshAlbum(id, imagesByDir) {
    const tracks = this.q.albumTracks.all(id);
    if (!tracks.length) return;
    const now = Date.now();
    const count = (vals) => {
      const m = new Map();
      for (const v of vals) if (v) m.set(v, (m.get(v) || 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    };
    const years = count(tracks.map(t => t.year));
    const labels = count(tracks.map(t => t.label));
    const genres = [];
    for (const t of tracks) for (const g of JSON.parse(t.genres || "[]")) if (!genres.includes(g)) genres.push(g);
    const dirs = count(tracks.map(t => path.dirname(t.path)));
    let dir = dirs[0] || "";
    if (DISC_DIR.test(path.basename(dir))) dir = path.dirname(dir);
    // Folder art: the album's own folder, then each disc folder.
    let art = null;
    for (const d of [dir, ...dirs]) {
      const imgs = imagesByDir && imagesByDir.get(d);
      const list = imgs || listImages(d);
      art = pickArt(list);
      if (art) break;
    }
    const lossy = tracks.some(t => !t.lossless);
    const rates = tracks.map(t => t.sample_rate || 0);
    const bits = tracks.map(t => t.bits || 0);
    const containers = count(tracks.map(t => t.container));
    this.q.updateAlbum.run({
      id,
      year: years[0] || null,
      label: labels[0] || null,
      genres: JSON.stringify(genres.slice(0, 8)),
      dir,
      art_path: art,
      art_embedded: art ? null : tracks[0].path,
      art_hash: art ? artHash(art) : artHash(tracks[0].path),
      track_count: tracks.length,
      duration: tracks.reduce((a, t) => a + (t.duration || 0), 0),
      max_rate: Math.max(...rates) || null,
      max_bits: Math.max(...bits) || null,
      lossless: lossy ? 0 : 1,
      container: containers[0] || null,
      added_at: Math.min(...tracks.map(t => t.mtime)) || now,
      now
    });
  }

  async scan({ force = false } = {}) {
    if (this.state.running) return { status: "running" };
    const t0 = Date.now();
    this.state = { running: true, progress: 0, files: 0, parsed: 0, errors: 0, startedAt: t0, finishedAt: null, lastResult: this.state.lastResult };
    if (!fs.existsSync(this.root)) {
      this.state.running = false;
      this.state.lastResult = { status: "no-music", root: this.root };
      this.log(`[scan] ${this.root} does not exist — mount your music there`);
      return this.state.lastResult;
    }
    const known = new Map();
    for (const r of this.db.prepare("SELECT id, path, mtime, size, album_id FROM tracks").all()) known.set(r.path, r);
    const seen = new Set();
    const touchedAlbums = new Set();
    const imagesByDir = new Map();
    let added = 0, changed = 0;
    const knownTotal = known.size || 1;

    await walk(this.root, async (dir, files, images, discImages) => {
      imagesByDir.set(dir, images);
      for (const [d, imgs] of discImages || []) imagesByDir.set(d, imgs);
      if (!files.length) return;
      const rows = [];
      let dirty = false;
      for (const file of files) {
        seen.add(file);
        this.state.files++;
        let st;
        try { st = fs.statSync(file); } catch (e) { continue; }
        const mtime = Math.floor(st.mtimeMs);
        const prev = known.get(file);
        if (!force && prev && prev.mtime === mtime && prev.size === st.size) {
          rows.push({ unchanged: true, prev });
          continue;
        }
        dirty = true;
        try {
          const tags = await readTags(file);
          this.state.parsed++;
          rows.push(Object.assign({ path: file, mtime, size: st.size }, tags));
          if (prev) changed++; else added++;
        } catch (e) {
          this.state.errors++;
          if (this.state.errors <= 20) this.log(`[scan] could not read ${file}: ${e.message}`);
        }
        this.state.progress = Math.min(99, Math.round(100 * this.state.files / Math.max(knownTotal, this.state.files + 1)));
      }
      if (!dirty) return;
      // Regroup the whole folder, unchanged neighbours included.
      const full = rows.map(r => {
        if (!r.unchanged) return r;
        const t = this.q.trackByPath.get(r.prev.path);
        return Object.assign({ unchanged: true, genres: JSON.parse(t.genres || "[]") }, t);
      });
      const groups = this.groupDir(dir, full);
      const now = Date.now();
      this.db.transaction(() => {
        for (const g of groups) {
          const albumId = this.albumIdFor(g, dir, now);
          touchedAlbums.add(albumId);
          for (const r of g.rows) {
            if (r.unchanged) {
              if (r.album_id !== albumId) { touchedAlbums.add(r.album_id); this.q.moveTrack.run(albumId, r.id); }
              continue;
            }
            const prev = known.get(r.path);
            if (prev) touchedAlbums.add(prev.album_id);
            this.q.upsertTrack.run({
              album_id: albumId, path: r.path, mtime: r.mtime, size: r.size, title: r.title, artist: r.artist,
              album_artist: r.album_artist, album: r.album, track_no: r.track_no, disc_no: r.disc_no, duration: r.duration,
              codec: r.codec, container: r.container, sample_rate: r.sample_rate, bits: r.bits, channels: r.channels,
              lossless: r.lossless, year: r.year, label: r.label, genres: JSON.stringify(r.genres || [])
            });
          }
        }
      })();
      // Let the event loop breathe between folders: the API stays responsive.
      await new Promise(r => setImmediate(r));
    });

    let removed = 0;
    this.db.transaction(() => {
      for (const [p, r] of known) {
        if (!seen.has(p)) { this.q.deleteTrack.run(r.id); touchedAlbums.add(r.album_id); removed++; }
      }
    })();
    this.db.transaction(() => {
      for (const id of touchedAlbums) this.refreshAlbum(id, imagesByDir);
      for (const r of this.q.emptyAlbums.all()) this.q.deleteAlbum.run(r.id);
    })();

    const albums = this.db.prepare("SELECT COUNT(*) AS n FROM albums").get().n;
    const tracks = this.db.prepare("SELECT COUNT(*) AS n FROM tracks").get().n;
    const result = {
      status: (added || changed || removed) ? "updated" : "unchanged",
      added, changed, removed, albums, tracks,
      errors: this.state.errors, ms: Date.now() - t0
    };
    this.state.running = false;
    this.state.progress = 100;
    this.state.finishedAt = Date.now();
    this.state.lastResult = result;
    this.log(`[scan] ${result.status}: +${added} ~${changed} -${removed} files; ${albums} albums, ${tracks} tracks in ${(result.ms / 1000).toFixed(1)}s`);
    return result;
  }
}

function listImages(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => IMG_EXT.includes(path.extname(f).toLowerCase()) && !f.startsWith("."))
      .map(f => path.join(dir, f));
  } catch (e) { return []; }
}

module.exports = { Scanner, readTags, pickArt, AUDIO_EXT, yearOf };
