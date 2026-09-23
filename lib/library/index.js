"use strict";
/*
 * library/index.js — the whole library, in memory, in the shapes the
 * interface asks for.
 *
 * The database is the record; this is the working copy. Every screen — the
 * random wall, the sorted Library wall, search on every keystroke, the facet
 * counts — is a pass over an array of a few thousand objects, which is
 * milliseconds, so none of it touches SQLite on a user action. It is rebuilt
 * after each scan.
 *
 * An album's `offset` in the API is its database id. The interface was written
 * for Roon, where an album is addressed by its position in a browse list and
 * that position can go stale; here the id is permanent, so the stale-offset
 * machinery the interface carries simply never fires.
 */
const N = require("./normalize");

function rateShort(hz) {
  const k = hz / 1000;
  return Number.isInteger(k) ? String(k) : k.toFixed(1);
}
function rateLabel(hz) { return hz ? rateShort(hz) + " kHz" : null; }
function channelLabel(n) {
  if (!n) return null;
  if (n === 1) return "Mono";
  if (n === 2) return "Stereo";
  return n + " channels";
}
function formatName(container, lossless) {
  const c = String(container || "");
  if (/mpeg/i.test(c) && !lossless) return "MP3";
  if (/flac/i.test(c)) return "FLAC";
  if (/wave|wav/i.test(c)) return "WAV";
  if (/aiff/i.test(c)) return "AIFF";
  if (/dsf|dsd|dff/i.test(c)) return "DSD";
  if (/ogg/i.test(c)) return "Ogg";
  if (/m4a|mp4|isom|m4b|alac/i.test(c)) return lossless ? "ALAC" : "AAC";
  if (/wavpack/i.test(c)) return "WavPack";
  if (/ape|monkey/i.test(c)) return "APE";
  return c || null;
}

// Deterministic shuffle: paging must not reshuffle between requests, so the
// order is a pure function of (album, seed).
function seededRank(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

// ---- search scoring, from MusicD Remote -------------------------------------
function consecutivePrefixStart(tokens, qTokens) {
  const last = tokens.length - qTokens.length;
  for (let i = 0; i <= last; i++) {
    let ok = true;
    for (let k = 0; k < qTokens.length; k++) {
      if (!tokens[i + k].startsWith(qTokens[k])) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}
function allTokensPrefixSomewhere(tokens, qTokens) {
  const used = new Array(tokens.length).fill(false);
  for (const qt of qTokens) {
    let found = false;
    for (let i = 0; i < tokens.length; i++) {
      if (!used[i] && tokens[i].startsWith(qt)) { used[i] = true; found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}
function isSubsequence(q, s) {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
  return i === q.length;
}
function scoreAlbum(al, q, qTokens, qJoined, singleChar) {
  let s = 0;
  if (al.nTitle === q) return 1000;
  if (al.nTitle.startsWith(q)) s = Math.max(s, 920 - Math.min(al.nTitle.length - q.length, 60));
  {
    const start = consecutivePrefixStart(al.tTitle, qTokens);
    if (start === 0) s = Math.max(s, 900 - Math.min(al.tTitle.length, 40));
    else if (start > 0 && !singleChar) s = Math.max(s, 820 - start * 4);
  }
  if (al.jTitle.startsWith(qJoined)) s = Math.max(s, 870 - Math.min(al.jTitle.length - qJoined.length, 60));
  if (!singleChar) {
    if (s < 760 && qTokens.length > 1 && allTokensPrefixSomewhere(al.tTitle, qTokens)) s = Math.max(s, 760);
    if (s < 650 && al.nTitle.includes(q)) s = Math.max(s, 650 - Math.min(al.nTitle.indexOf(q), 40));
    // "dark moon" → Dark Side of the Moon; "radiohead ok" → OK Computer.
    if (s < 700 && qTokens.length > 1 && allTokensPrefixSomewhere(al.tTitle.concat(al.tArtist), qTokens)) s = Math.max(s, 700);
  }
  if (al.nArtist) {
    if (al.nArtist === q) s = Math.max(s, 770);
    if (al.nArtist.startsWith(q)) s = Math.max(s, 740 - Math.min(al.nArtist.length - q.length, 60));
    {
      const start = consecutivePrefixStart(al.tArtist, qTokens);
      if (start === 0) s = Math.max(s, 720 - Math.min(al.tArtist.length, 40));
      else if (start > 0 && !singleChar) s = Math.max(s, 660 - start * 4);
    }
    if (al.jArtist.startsWith(qJoined)) s = Math.max(s, 700 - Math.min(al.jArtist.length - qJoined.length, 60));
    if (!singleChar) {
      if (s < 600 && qTokens.length > 1 && allTokensPrefixSomewhere(al.tArtist, qTokens)) s = Math.max(s, 600);
      if (s < 520 && al.nArtist.includes(q)) s = Math.max(s, 520 - Math.min(al.nArtist.indexOf(q), 40));
    }
  }
  if (s === 0 && !singleChar && qJoined.length >= 4) {
    if (isSubsequence(qJoined, al.jTitle)) s = 300;
    else if (isSubsequence(qJoined, al.jArtist)) s = 260;
  }
  return s;
}

const LIB_SORTS = ["album", "artist", "year", "added", "plays", "lastplayed", "random"];
const LIB_PLAYED = ["any", "never", "played", "6", "12"];
const ADDED_WINDOWS = [
  { value: "7", label: "7 days", days: 7 },
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "3 months", days: 90 },
  { value: "365", label: "12 months", days: 365 }
];
const CHIP_MAX = 40;

class Library {
  constructor(db, { musicRoot = "/music", log = () => {} } = {}) {
    this.db = db;
    this.raw = db.raw;
    this.musicRoot = musicRoot;
    this.log = log;
    this.albums = [];
    this.byId = new Map();
    this.builtAt = 0;
    this.version = 0;
    this.artistKeys = new Set();
    this.viewCache = new Map();
    this.q = {
      tracks: this.raw.prepare("SELECT * FROM tracks WHERE album_id = ? ORDER BY COALESCE(disc_no,1), COALESCE(track_no, 9999), path"),
      track: this.raw.prepare("SELECT * FROM tracks WHERE id = ?"),
      trackCount: this.raw.prepare("SELECT COUNT(*) AS n FROM tracks"),
      playsSince: this.raw.prepare("SELECT DISTINCT album_id FROM plays WHERE ts >= ? AND album_id IS NOT NULL"),
      playStats: this.raw.prepare("SELECT album_id, COUNT(*) AS n, MAX(ts) AS t FROM plays WHERE album_id IS NOT NULL GROUP BY album_id")
    };
  }

  /* Rebuild the in-memory copy from the database. */
  reload() {
    const rows = this.raw.prepare(`SELECT a.*, e.title AS e_title, e.artist AS e_artist, e.year AS e_year,
                                          e.art_hash AS e_art_hash, e.art_source AS e_art_source
                                     FROM albums a LEFT JOIN album_edits e ON e.key = a.key`).all();
    const albums = rows.map(r => {
      // A hand edit wins over the tags; the scanned values are kept alongside
      // so the editor can show them and put them back.
      const title = r.e_title || r.title || "";
      const artist = r.e_artist || r.artist || "";
      const year = r.e_year || r.year || null;
      const customArt = !!r.e_art_hash;
      const nTitle = N.fold(title);
      const nArtist = N.fold(artist);
      const names = N.splitArtists(artist).map(name => ({ name, n: N.fold(name) })).filter(x => x.n);
      return {
        id: r.id,
        offset: r.id,
        title, subtitle: artist, artist,
        image_key: customArt ? `al-${r.id}-e${r.e_art_hash}` : `al-${r.id}-${r.art_hash || "0"}`,
        nTitle, nArtist,
        tTitle: nTitle.split(" ").filter(Boolean),
        tArtist: nArtist.split(" ").filter(Boolean),
        jTitle: nTitle.replace(/ /g, ""),
        jArtist: nArtist.replace(/ /g, ""),
        sortTitle: (!r.e_title && r.sort_title) || N.sortName(title),
        sortArtist: (!r.e_artist && r.sort_artist) || N.sortName(artist),
        artistNames: names,
        year,
        genres: JSON.parse(r.genres || "[]"),
        rate: r.max_rate || null,
        bits: r.lossless ? (r.max_bits || null) : null,
        lossless: !!r.lossless,
        container: formatName(r.container, r.lossless),
        added: r.added_at || null,
        tracks: r.track_count,
        duration: r.duration,
        compilation: !!r.compilation,
        dir: r.dir,
        artPath: r.art_path,
        artEmbedded: r.art_embedded,
        artHash: r.art_hash,
        key: r.key,
        customArt,
        artSource: r.e_art_source || null,
        scanned: { title: r.title || "", artist: r.artist || "", year: r.year || null },
        edited: !!(r.e_title || r.e_artist || r.e_year || customArt)
      };
    });
    this.albums = albums;
    this.byId = new Map(albums.map(a => [a.id, a]));
    this.artistKeys = new Set();
    for (const a of albums) for (const n of a.artistNames) this.artistKeys.add(n.n);
    this.builtAt = Date.now();
    this.version++;
    this.viewCache.clear();
  }

  get count() { return this.albums.length; }
  trackCount() { return this.q.trackCount.get().n; }

  album(id) { return this.byId.get(Number(id)) || null; }

  // ------------------------------------------------------------ edits

  /* Lay corrections over an album. `fields` may carry title, artist, year
   * (an empty value puts back what was scanned) and art: a Buffer with its
   * source, or null to drop a found cover. */
  saveEdit(id, fields) {
    const al = this.album(id);
    if (!al) return null;
    const cur = this.raw.prepare("SELECT * FROM album_edits WHERE key = ?").get(al.key) || {};
    const next = {
      key: al.key,
      title: cur.title || null, artist: cur.artist || null, year: cur.year || null,
      art: cur.art || null, art_hash: cur.art_hash || null, art_source: cur.art_source || null,
      updated_at: Date.now()
    };
    const text = (v, scanned) => {
      const t = String(v == null ? "" : v).trim();
      return t && t !== scanned ? t : null;
    };
    if ("title" in fields) next.title = text(fields.title, al.scanned.title);
    if ("artist" in fields) next.artist = text(fields.artist, al.scanned.artist);
    if ("year" in fields) {
      const y = parseInt(fields.year, 10);
      next.year = y >= 1000 && y <= 2999 && y !== al.scanned.year ? y : null;
    }
    if ("art" in fields) {
      const a = fields.art;
      next.art = a ? a.buf : null;
      next.art_hash = a ? require("crypto").createHash("sha1").update(a.buf).digest("hex").slice(0, 12) : null;
      next.art_source = a ? (a.source || null) : null;
    }
    if (!next.title && !next.artist && !next.year && !next.art) {
      this.raw.prepare("DELETE FROM album_edits WHERE key = ?").run(al.key);
    } else {
      this.raw.prepare(`INSERT INTO album_edits(key, title, artist, year, art, art_hash, art_source, updated_at)
                        VALUES(@key, @title, @artist, @year, @art, @art_hash, @art_source, @updated_at)
                        ON CONFLICT(key) DO UPDATE SET title=excluded.title, artist=excluded.artist, year=excluded.year,
                          art=excluded.art, art_hash=excluded.art_hash, art_source=excluded.art_source,
                          updated_at=excluded.updated_at`).run(next);
    }
    if (this.db.backupEdits) this.db.backupEdits();
    this.reload();
    return this.album(id);
  }

  clearEdits(id) {
    const al = this.album(id);
    if (!al) return null;
    this.raw.prepare("DELETE FROM album_edits WHERE key = ?").run(al.key);
    if (this.db.backupEdits) this.db.backupEdits();
    this.reload();
    return this.album(id);
  }

  editedArt(id) {
    const al = this.album(id);
    if (!al || !al.customArt) return null;
    const r = this.raw.prepare("SELECT art FROM album_edits WHERE key = ?").get(al.key);
    return r && r.art ? r.art : null;
  }
  tracks(albumId) { return this.q.tracks.all(Number(albumId)); }
  track(id) { return this.q.track.get(Number(id)) || null; }

  qualityOf(al) {
    if (!al) return {};
    if (!al.lossless) return { quality: al.container || null, hires: false };
    let q = null;
    if (al.bits && al.rate) q = al.bits + "/" + rateShort(al.rate);
    else if (al.rate) q = rateShort(al.rate) + " kHz";
    return { quality: q || al.container, hires: !!((al.bits && al.bits > 16) || (al.rate && al.rate > 48000)) };
  }

  json(al, extra) {
    if (!al) return null;
    const q = this.qualityOf(al);
    const out = { offset: al.id, title: al.title, subtitle: al.subtitle, image_key: al.image_key, source: null };
    if (q.quality) out.quality = q.quality;
    if (q.hires) out.hires = true;
    if (al.year) out.year = al.year;
    return extra ? Object.assign(out, extra) : out;
  }

  /* Find an album from what a speaker says is playing (title + artist). */
  relocate(title, artist) {
    const t = N.fold(title);
    if (!t) return null;
    const a = N.fold(artist || "");
    let best = null;
    for (const al of this.albums) {
      if (al.nTitle !== t) continue;
      if (!a || al.nArtist === a || al.artistNames.some(n => n.n === a)) return al;
      best = best || al;
    }
    return best;
  }

  // ------------------------------------------------------------ plays

  playedAlbumIdsSince(ts) {
    return new Set(this.q.playsSince.all(ts).map(r => r.album_id));
  }
  playStats() {
    const count = new Map(), last = new Map();
    for (const r of this.q.playStats.all()) { count.set(r.album_id, r.n); last.set(r.album_id, r.t); }
    return { count, last };
  }

  // ----------------------------------------------------------- search

  search(query, limit = 60) {
    const q = N.fold(query);
    if (!q) return [];
    const qTokens = q.split(" ").filter(Boolean);
    const qJoined = q.replace(/ /g, "");
    const singleChar = qJoined.length <= 1;
    const out = [];
    for (const al of this.albums) {
      const score = scoreAlbum(al, q, qTokens, qJoined, singleChar);
      if (score > 0) out.push({ al, score });
    }
    out.sort((a, b) => b.score - a.score || a.al.nTitle.localeCompare(b.al.nTitle) || a.al.nArtist.localeCompare(b.al.nArtist));
    return out.slice(0, limit).map(({ al, score }) => this.json(al, { score }));
  }

  searchArtists(query) {
    const q = N.fold(query);
    if (!q) return [];
    const seen = new Map();
    for (const al of this.albums) {
      for (const { name, n } of al.artistNames) {
        if (!n.includes(q)) continue;
        if (seen.has(n)) seen.get(n).count++;
        else seen.set(n, { name, n, count: 1, albumCount: 0 });
      }
    }
    return [...seen.values()]
      .map(x => Object.assign(x, { albumCount: x.count }))
      .sort((a, b) => (a.n.startsWith(q) ? 0 : 1) - (b.n.startsWith(q) ? 0 : 1) || b.count - a.count)
      .slice(0, 8);
  }

  // ---------------------------------------------------- lists & facets

  artistAlbums(name) {
    const q = N.fold(name);
    const primary = [], featured = [];
    if (!q) return { primary, featured };
    for (const al of this.albums) {
      const names = al.artistNames.map(x => x.n);
      if (al.nArtist !== q && !names.includes(q)) continue;
      if (al.nArtist === q || names[0] === q) primary.push(al); else featured.push(al);
    }
    // A compilation track credit: albums where this artist is on a track but
    // not the album credit. Found through the tracks table.
    const viaTracks = this.raw.prepare(
      "SELECT DISTINCT album_id FROM tracks WHERE lower(artist) = lower(?) LIMIT 200").all(name);
    for (const r of viaTracks) {
      const al = this.byId.get(r.album_id);
      if (al && !primary.includes(al) && !featured.includes(al)) featured.push(al);
    }
    const byYear = (a, b) => (a.year || 9999) - (b.year || 9999) || a.sortTitle.localeCompare(b.sortTitle);
    primary.sort(byYear); featured.sort(byYear);
    return { primary, featured };
  }

  artists(sort = "az", seed = 1) {
    const m = new Map();
    for (const al of this.albums) {
      if (al.compilation) continue;
      for (const { name, n } of al.artistNames) {
        if (!m.has(n)) m.set(n, { name, n, albumCount: 0, image_key: al.image_key, sortName: N.sortName(name) });
        m.get(n).albumCount++;
      }
    }
    const list = [...m.values()];
    if (sort === "random") list.sort((a, b) => seededRank(a.n, seed) - seededRank(b.n, seed));
    else if (sort === "albums") list.sort((a, b) => b.albumCount - a.albumCount || a.sortName.localeCompare(b.sortName));
    else list.sort((a, b) => a.sortName.localeCompare(b.sortName));
    return list;
  }

  genres() {
    const m = new Map();
    for (const al of this.albums) for (const g of al.genres) m.set(g, (m.get(g) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([title, n]) => ({
      title, subtitle: `${n.toLocaleString()} album${n === 1 ? "" : "s"}`, count: n
    }));
  }

  decades() {
    const m = new Map();
    for (const al of this.albums) {
      if (!al.year) continue;
      const d = Math.floor(al.year / 10) * 10;
      m.set(d, (m.get(d) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0]).map(([d, n]) => ({
      title: d + "s", subtitle: `${n.toLocaleString()} album${n === 1 ? "" : "s"}`, count: n
    }));
  }

  facetDefs() {
    return [
      { id: "genre", label: "Genre", values: al => al.genres },
      { id: "decade", label: "Decade", sort: "numeric-desc", labels: v => v + "s",
        values: al => al.year ? [String(Math.floor(al.year / 10) * 10)] : [] },
      { id: "format", label: "Format", values: al => al.container ? [al.container] : [] },
      { id: "rate", label: "Sample rate", sort: "numeric-asc", labels: v => rateLabel(parseInt(v, 10)) || v,
        values: al => al.rate ? [String(al.rate)] : [] },
      { id: "bits", label: "Bit depth", sort: "numeric-asc", labels: v => v + "-bit",
        values: al => al.bits ? [String(al.bits)] : [] },
      { id: "letter", label: "Starts with",
        values: al => { const c = (al.sortTitle || "").charAt(0).toUpperCase(); return c ? [/[A-Z]/.test(c) ? c : "#"] : []; } },
      { id: "added", label: "Added in the last", sort: "none",
        labels: v => (ADDED_WINDOWS.find(w => w.value === v) || { label: v }).label,
        values: al => {
          if (!al.added) return [];
          const age = Date.now() - al.added;
          return ADDED_WINDOWS.filter(w => age <= w.days * 86400000).map(w => w.value);
        } }
    ];
  }

  facets() {
    const defs = this.facetDefs();
    const counts = defs.map(() => new Map());
    for (const al of this.albums) {
      for (let i = 0; i < defs.length; i++) {
        for (const v of defs[i].values(al)) counts[i].set(v, (counts[i].get(v) || 0) + 1);
      }
    }
    const facets = defs.map((def, i) => {
      const m = counts[i];
      let values = [...m.keys()];
      if (def.sort === "numeric-desc") values.sort((a, b) => parseFloat(b) - parseFloat(a));
      else if (def.sort === "numeric-asc") values.sort((a, b) => parseFloat(a) - parseFloat(b));
      else if (def.sort === "none") values = ADDED_WINDOWS.map(w => w.value).filter(v => m.has(v));
      else values.sort((a, b) => (m.get(b) - m.get(a)) || a.localeCompare(b));
      const labelOf = v => typeof def.labels === "function" ? def.labels(v) : v;
      return {
        id: def.id, label: def.label, total_values: values.length,
        values: values.slice(0, CHIP_MAX).map(v => ({ value: v, label: labelOf(v), count: m.get(v) }))
      };
    }).filter(f => f.values.length);
    const countWith = id => {
      const def = defs.find(d => d.id === id);
      return this.albums.filter(al => def.values(al).length).length;
    };
    let hasPlays = false;
    try { hasPlays = !!this.raw.prepare("SELECT 1 FROM plays LIMIT 1").get(); } catch (e) { /* no table yet */ }
    return {
      total: this.albums.length,
      facets,
      coverage: {
        decade: countWith("decade"), genre: countWith("genre"),
        format: countWith("format"), added: countWith("added")
      },
      sources_derived: false,
      played: LIB_PLAYED,
      hasPlays
    };
  }

  /*
   * The Library wall: facets (a "!" prefix excludes), a starts-with prefix,
   * listening history, then one of seven sorts. Same vocabulary as MusicD
   * Remote's libraryView, so saved dynamic playlists carry over unchanged.
   */
  view(q = {}) {
    const sort = LIB_SORTS.includes(String(q.sort || "")) ? String(q.sort) : "album";
    const desc = String(q.dir || "asc") === "desc";
    const seed = parseInt(q.seed, 10) || 1;
    const played = String(q.played || "any");
    const asList = v => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v])).map(String).filter(Boolean);
    const defs = this.facetDefs();
    const picked = defs.map(d => ({ def: d, sel: asList(q[d.id]) })).filter(x => x.sel.length);
    const prefix = N.fold(q.prefix || "").slice(0, 40);
    const sig = [this.version, sort, desc, seed, played, prefix]
      .concat(picked.map(x => x.def.id + "=" + x.sel.slice().sort().join(","))).join("|");
    const usesPlays = played !== "any" || sort === "plays" || sort === "lastplayed";
    const hit = !usesPlays && !prefix ? this.viewCache.get(sig) : null;
    if (hit) return hit;

    let list = this.albums;
    for (const { def, sel } of picked) list = list.filter(al => facetMatch(sel, def.values(al)));
    if (prefix) {
      list = list.filter(al => al.sortTitle.startsWith(prefix) || al.nTitle.startsWith(prefix) ||
        al.nArtist.startsWith(prefix) || al.artistNames.some(a => a.n.startsWith(prefix)));
    }
    if (played !== "any") {
      const months = parseInt(played, 10);
      const since = (played === "never" || played === "played") ? 0
        : Date.now() - (Number.isFinite(months) && months > 0 ? months : 6) * 30 * 86400000;
      const seen = this.playedAlbumIdsSince(since);
      const want = played === "played";
      list = list.filter(al => seen.has(al.id) === want);
    }
    const stats = (sort === "plays" || sort === "lastplayed") ? this.playStats() : null;
    const cmp = {
      album: (a, b) => a.sortTitle.localeCompare(b.sortTitle) || a.nArtist.localeCompare(b.nArtist),
      artist: (a, b) => a.sortArtist.localeCompare(b.sortArtist) || (a.year || 0) - (b.year || 0) || a.sortTitle.localeCompare(b.sortTitle),
      year: (a, b) => a.year - b.year || a.sortTitle.localeCompare(b.sortTitle),
      added: (a, b) => a.added - b.added || a.sortTitle.localeCompare(b.sortTitle),
      plays: (a, b) => (stats.count.get(a.id) || 0) - (stats.count.get(b.id) || 0) || a.sortTitle.localeCompare(b.sortTitle),
      lastplayed: (a, b) => (stats.last.get(a.id) || 0) - (stats.last.get(b.id) || 0) || a.sortTitle.localeCompare(b.sortTitle),
      random: (a, b) => seededRank(a.nTitle + a.nArtist, seed) - seededRank(b.nTitle + b.nArtist, seed)
    }[sort];
    let out;
    if (sort === "year" || sort === "added") {
      const key = sort === "year" ? "year" : "added";
      const known = [], unknown = [];
      for (const al of list) (al[key] ? known : unknown).push(al);
      known.sort(cmp);
      if (desc) known.reverse();
      unknown.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
      out = known.concat(unknown);
    } else {
      out = list.slice().sort(cmp);
      if (desc) out.reverse();
    }
    if (!usesPlays && !prefix) {
      if (this.viewCache.size > 64) this.viewCache.delete(this.viewCache.keys().next().value);
      this.viewCache.set(sig, out);
    }
    return out;
  }

  /* A random draw, optionally filtered, optionally seeded (Home's daily row). */
  random(count, filter, seed) {
    let pool = this.albums;
    if (filter) pool = this.filtered(filter);
    const n = Math.min(count, pool.length);
    if (seed != null && Number.isFinite(Number(seed))) {
      return { albums: pool.slice().sort((a, b) => seededRank(a.nTitle + a.nArtist, Number(seed)) - seededRank(b.nTitle + b.nArtist, Number(seed))).slice(0, n), total: pool.length };
    }
    const picked = new Set();
    while (picked.size < n) picked.add(Math.floor(Math.random() * pool.length));
    return { albums: [...picked].map(i => pool[i]), total: pool.length };
  }

  filtered(f) {
    const v = N.fold(f.value);
    if (f.type === "genre") return this.albums.filter(al => al.genres.some(g => N.fold(g) === v));
    if (f.type === "decade") {
      const d = parseInt(String(f.value), 10);
      return this.albums.filter(al => al.year && al.year >= d && al.year < d + 10);
    }
    return [];   // tags: a Roon feature with no file-tag equivalent
  }

  albumOfTheDay() {
    if (!this.albums.length) return null;
    const now = new Date();
    const dstr = now.getFullYear() + "-" + (now.getMonth() + 1) + "-" + now.getDate();
    const sorted = this.albums.slice().sort((a, b) => a.id - b.id);
    return sorted[fnv1a(dstr) % sorted.length];
  }
}

function facetMatch(selected, values) {
  if (!selected || !selected.length) return true;
  let wanted = false, sawInclude = false;
  for (const sel of selected) {
    if (sel.charAt(0) === "!") { if (values.includes(sel.slice(1))) return false; }
    else { sawInclude = true; if (values.includes(sel)) wanted = true; }
  }
  return sawInclude ? wanted : true;
}

module.exports = { Library, seededRank, fnv1a, rateShort, rateLabel, channelLabel, formatName, LIB_SORTS, LIB_PLAYED };
