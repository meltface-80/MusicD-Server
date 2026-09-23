"use strict";
/*
 * api-playlists.js — playlists you make, dynamic playlists (saved Library
 * views), playlist sharing, and the update check.
 *
 * A user playlist entry names an album and a track's position on it, exactly
 * as MusicD Remote stores it, so the interface plays it through the same
 * /api/play-track route as an album page. Positions are stable here — an
 * album's track order only changes if its files do.
 */
const crypto = require("crypto");
const https = require("https");
const SH = require("./share");
const N = require("../library/normalize");
const { seededRank, LIB_SORTS, LIB_PLAYED } = require("../library/index");

const PL_MAX = 50, PL_TRACKS_MAX = 500, PL_ADD_MAX = 200, PL_ALBUM_ADD_MAX = 30, PL_NAME_MAX = 60;
const SMART_MAX = 50, SMART_LIMIT_DEFAULT = 100, SMART_LIMIT_MAX = 400;

module.exports = function mountPlaylists(app, ctx) {
  const { db, library } = ctx;
  const newId = () => crypto.randomBytes(6).toString("hex");

  // ------------------------------------------------------- user playlists

  const load = () => (db.setting("userPlaylists", []) || []).filter(p => p && p.id && p.name);
  const save = list => db.setSetting("userPlaylists", list.slice(0, PL_MAX));
  const summary = p => {
    const keys = [];
    for (const t of p.tracks) { if (t.image_key && !keys.includes(t.image_key)) keys.push(t.image_key); if (keys.length === 4) break; }
    return { id: p.id, name: p.name, track_total: p.tracks.length, art_keys: keys, updated_at: p.updated_at };
  };
  const trackRecord = t => {
    if (!t || typeof t !== "object") return null;
    const title = SH.shareText(t.title, 500);
    const albumTitle = SH.shareText(t.album_title, 500);
    const off = SH.shareInt(t.album_offset, 0, 50000000);
    if (!title || !albumTitle || off === null) return null;
    return {
      album_offset: off, album_title: albumTitle, album_subtitle: SH.shareText(t.album_subtitle, 500),
      track_index: SH.shareInt(t.track_index, 0, 9999) || 0, title,
      subtitle: SH.shareText(t.subtitle, 500), image_key: SH.shareText(t.image_key, 200) || null,
      track_no: SH.shareInt(t.track_no, 1, 999)
    };
  };
  const recordFor = (al, t, index) => ({
    album_offset: al.id, album_title: al.title, album_subtitle: al.artist, track_index: index,
    title: t.title, subtitle: t.artist || al.artist, image_key: al.image_key, track_no: t.track_no || null
  });

  function target(list, body) {
    const id = SH.shareText(body.id, 64);
    if (id) {
      const p = list.find(x => x.id === id);
      return p ? { playlist: p } : { error: "No such playlist", status: 404 };
    }
    const name = SH.shareText(body.name, PL_NAME_MAX);
    if (!name) return { error: "id or name required", status: 400 };
    if (list.length >= PL_MAX) return { error: `That's ${PL_MAX} playlists — delete one first`, status: 400 };
    const p = { id: newId(), name, tracks: [], created_at: Date.now(), updated_at: Date.now() };
    list.push(p);
    return { playlist: p };
  }
  function append(p, incoming) {
    let added = 0, skipped = 0, full = false;
    for (const t of incoming) {
      if (p.tracks.length >= PL_TRACKS_MAX) { full = true; break; }
      const one = trackRecord(t);
      if (one) { p.tracks.push(one); added++; } else skipped++;
    }
    p.updated_at = Date.now();
    return { added, skipped, full };
  }

  app.get("/api/user-playlists", (req, res) => res.json({ playlists: load().map(summary) }));
  app.get("/api/user-playlist", (req, res) => {
    const p = load().find(x => x.id === String(req.query.id || ""));
    if (!p) return res.status(404).json({ error: "No such playlist" });
    res.json({ id: p.id, name: p.name, tracks: p.tracks, track_total: p.tracks.length });
  });
  app.post("/api/user-playlists", (req, res) => {
    const b = req.body || {};
    const list = load();
    const name = SH.shareText(b.name, PL_NAME_MAX);
    if (!name) return res.status(400).json({ error: "name required" });
    if (b.id) {
      const p = list.find(x => x.id === b.id);
      if (!p) return res.status(404).json({ error: "No such playlist" });
      p.name = name; p.updated_at = Date.now();
    } else {
      if (list.length >= PL_MAX) return res.status(400).json({ error: `That's ${PL_MAX} playlists — delete one first` });
      list.push({ id: newId(), name, tracks: [], created_at: Date.now(), updated_at: Date.now() });
    }
    save(list);
    res.json({ ok: true, playlists: list.map(summary) });
  });
  app.post("/api/user-playlists/delete", (req, res) => {
    const list = load();
    const at = list.findIndex(x => x.id === (req.body || {}).id);
    if (at === -1) return res.status(404).json({ error: "No such playlist" });
    list.splice(at, 1);
    save(list);
    res.json({ ok: true, playlists: list.map(summary) });
  });
  app.post("/api/user-playlists/add", (req, res) => {
    const b = req.body || {};
    const incoming = Array.isArray(b.tracks) ? b.tracks : [];
    if (!incoming.length) return res.status(400).json({ error: "tracks required" });
    if (incoming.length > PL_ADD_MAX) return res.status(400).json({ error: `Too many at once — ${PL_ADD_MAX} maximum` });
    const list = load();
    const t = target(list, b);
    if (t.error) return res.status(t.status).json({ error: t.error });
    const r = append(t.playlist, incoming);
    save(list);
    res.json(Object.assign({ ok: true, id: t.playlist.id, name: t.playlist.name, track_total: t.playlist.tracks.length }, r));
  });
  app.post("/api/user-playlists/add-albums", (req, res) => {
    const b = req.body || {};
    const albums = Array.isArray(b.albums) ? b.albums : [];
    if (!albums.length) return res.status(400).json({ error: "albums required" });
    if (albums.length > PL_ALBUM_ADD_MAX) return res.status(400).json({ error: `Too many albums at once — ${PL_ALBUM_ADD_MAX} maximum` });
    const list = load();
    const t = target(list, b);
    if (t.error) return res.status(t.status).json({ error: t.error });
    const tracks = [], failed = [];
    for (const a of albums) {
      const al = library.album(a && a.offset);
      if (!al) { failed.push(String((a && a.title) || "?")); continue; }
      library.tracks(al.id).forEach((tr, i) => tracks.push(recordFor(al, tr, i)));
    }
    const r = append(t.playlist, tracks);
    save(list);
    res.json(Object.assign({ ok: true, id: t.playlist.id, name: t.playlist.name,
      albums_read: albums.length - failed.length, albums_failed: failed, track_total: t.playlist.tracks.length }, r));
  });

  // Roon's own playlists: there is no second system here to read them from.
  app.get("/api/playlists", (req, res) => res.json({ playlists: [] }));
  app.get("/api/playlist", (req, res) => res.status(404).json({ error: "No such playlist" }));
  app.get("/api/playlist/art", (req, res) => res.status(404).end());
  app.post("/api/playlist/play", (req, res) => res.status(404).json({ error: "No such playlist" }));
  app.post("/api/playlist/play-track", (req, res) => res.status(404).json({ error: "No such playlist" }));

  // ---------------------------------------------------- dynamic playlists

  function sanitizeView(v) {
    v = v && typeof v === "object" ? v : {};
    const asList = x => (x === undefined || x === null ? [] : (Array.isArray(x) ? x : [x]));
    const seed = parseInt(v.seed, 10);
    const out = {
      sort: LIB_SORTS.includes(String(v.sort)) ? String(v.sort) : "album",
      dir: String(v.dir) === "desc" ? "desc" : "asc",
      seed: Number.isFinite(seed) && seed > 0 ? seed : 1,
      played: LIB_PLAYED.includes(String(v.played)) ? String(v.played) : "any"
    };
    for (const def of library.facetDefs()) {
      out[def.id] = [...new Set(asList(v[def.id]).filter(x => x !== null && x !== undefined && typeof x !== "object")
        .map(String).map(s => s.trim()).filter(Boolean).map(s => s.slice(0, 120)))].slice(0, 40);
    }
    return out;
  }
  function smartRecord(p) {
    if (!p || typeof p !== "object") return null;
    const name = String(p.name || "").trim().slice(0, 60);
    const id = String(p.id || "").trim();
    if (!name || !id) return null;
    const lim = parseInt(p.limit, 10);
    return {
      id, name, view: sanitizeView(p.view),
      limit: Number.isFinite(lim) && lim > 0 ? Math.min(lim, SMART_LIMIT_MAX) : SMART_LIMIT_DEFAULT,
      mode: p.mode === "tracks" ? "tracks" : "albums",
      order: p.order === "random" ? "random" : "album"
    };
  }
  const loadSmart = () => (db.setting("smartPlaylists", []) || []).map(smartRecord).filter(Boolean);
  const smartAlbums = sp => {
    const view = library.view(sp.view);
    if (sp.order !== "random") return view;
    const seed = sp.view.seed || 1;
    return view.slice().sort((a, b) => seededRank(a.nTitle + a.nArtist, seed) - seededRank(b.nTitle + b.nArtist, seed));
  };

  app.get("/api/smart-playlists", (req, res) => {
    res.json({
      playlists: loadSmart().map(p => {
        const view = smartAlbums(p);
        const keys = view.slice(0, 4).map(a => a.image_key);
        return Object.assign({}, p, { count: Math.min(view.length, p.limit), matched: view.length, art_keys: keys });
      }),
      limits: { default: SMART_LIMIT_DEFAULT, max: SMART_LIMIT_MAX, options: [25, 50, 100, 200, 400] },
      modes: ["albums", "tracks"], orders: ["album", "random"]
    });
  });
  app.post("/api/smart-playlists", (req, res) => {
    const b = req.body || {};
    const list = loadSmart();
    const rec = smartRecord(Object.assign({}, b, { id: b.id || newId() }));
    if (!rec) return res.status(400).json({ error: "name required" });
    const at = list.findIndex(p => p.id === rec.id);
    if (at >= 0) list[at] = rec;
    else {
      if (list.length >= SMART_MAX) return res.status(400).json({ error: `That's ${SMART_MAX} dynamic playlists — delete one first` });
      list.push(rec);
    }
    db.setSetting("smartPlaylists", list);
    res.json({ ok: true, playlist: rec, playlists: list });
  });
  app.post("/api/smart-playlists/delete", (req, res) => {
    const list = loadSmart();
    const at = list.findIndex(p => p.id === (req.body || {}).id);
    if (at === -1) return res.status(404).json({ error: "No such dynamic playlist" });
    list.splice(at, 1);
    db.setSetting("smartPlaylists", list);
    res.json({ ok: true, playlists: list });
  });
  app.get("/api/smart-playlist", (req, res) => {
    const sp = loadSmart().find(p => p.id === String(req.query.id || ""));
    if (!sp) return res.status(404).json({ error: "No such dynamic playlist" });
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const count = Math.max(1, Math.min(8, parseInt(req.query.count, 10) || 8));
    const view = smartAlbums(sp).slice(0, sp.limit);
    const slice = view.slice(offset, offset + count);
    let tracks = [];
    for (const al of slice) {
      library.tracks(al.id).forEach((t, i) => tracks.push({
        album_offset: al.id, album_title: al.title, album_artist: al.artist, image_key: al.image_key,
        track_index: i, title: t.title, subtitle: t.artist || al.artist, track_no: t.track_no || null
      }));
    }
    if (sp.order === "random") {
      const seed = sp.view.seed || 1;
      tracks.sort((a, b) => seededRank(a.album_title + "|" + a.title + "|" + a.track_index, seed) -
        seededRank(b.album_title + "|" + b.title + "|" + b.track_index, seed));
    }
    res.json({ id: sp.id, name: sp.name, view: sp.view, tracks, album_offset: offset,
      albums_expanded: slice.length, album_total: view.length, done: offset + slice.length >= view.length });
  });
  app.get("/api/smart-playlist/albums", (req, res) => {
    const sp = loadSmart().find(p => p.id === String(req.query.id || ""));
    if (!sp) return res.status(404).json({ error: "No such dynamic playlist" });
    const view = smartAlbums(sp);
    const max = Math.min(Math.max(1, Math.min(SMART_LIMIT_MAX, parseInt(req.query.max, 10) || SMART_LIMIT_DEFAULT)), sp.limit);
    res.json({ id: sp.id, name: sp.name,
      albums: view.slice(0, max).map(a => ({ offset: a.id, title: a.title, subtitle: a.artist, image_key: a.image_key })),
      total: Math.min(view.length, sp.limit), matched: view.length });
  });

  // ------------------------------------------------------------- sharing

  app.post("/api/share/encode", (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.tracks) || !b.tracks.length) return res.status(400).json({ error: "tracks required" });
    if (b.tracks.length > SH.shareInputMax()) return res.status(400).json({ error: `Too many entries — ${SH.shareInputMax()} at most` });
    const built = SH.buildShareDoc({ name: b.name, annotation: b.annotation }, b.tracks);
    if (!built.track_count) return res.status(400).json({ error: "None of those tracks had a title to share" });
    const blob = SH.encodeSharePayload(built.doc);
    res.json({ blob, bytes: Buffer.byteLength(blob, "utf8"), track_count: built.track_count, skipped: built.skipped, truncated: built.truncated });
  });

  // An entry is found by its own names: album + artist first, then the same
  // track title by that artist on any album (a compilation, a reissue).
  function resolveEntry(e) {
    const title = SH.shareText(e && e.title, 500);
    if (!title) return null;
    const album = SH.shareText(e && e.album, 500);
    const artist = SH.shareText(e && e.creator, 500);
    const want = N.fold(title);
    const al = album ? (library.relocate(album, artist) || library.relocate(album, null)) : null;
    if (al) {
      const tracks = library.tracks(al.id);
      const i = tracks.findIndex(t => N.fold(t.title) === want);
      if (i >= 0) return { track: recordFor(al, tracks[i], i), via: "album", album: al };
    }
    const rows = ctx.db.raw.prepare("SELECT * FROM tracks WHERE lower(title) = lower(?) LIMIT 20").all(title);
    const hit = rows.find(r => artist && N.fold(r.artist) === N.fold(artist)) || (!artist && rows[0]);
    if (hit) {
      const a2 = library.album(hit.album_id);
      const i = library.tracks(a2.id).findIndex(t => t.id === hit.id);
      return { track: recordFor(a2, hit, i), via: "tracks", album: a2 };
    }
    return null;
  }

  app.post("/api/share/import", (req, res) => {
    const blob = (req.body || {}).blob;
    if (typeof blob !== "string" || !blob.trim()) return res.status(400).json({ error: "blob required" });
    let doc;
    try { doc = SH.decodeSharePayload(blob); } catch (e) { return res.status(400).json({ error: e.message }); }
    const entries = doc.playlist.track.slice(0, PL_TRACKS_MAX);
    const resolved = [], missing = [], substituted = [];
    for (const e of entries) {
      const f = resolveEntry(e);
      if (f) {
        resolved.push(f.track);
        if (f.via !== "album") substituted.push({ title: SH.shareText(e.title, 200), artist: SH.shareText(e.creator, 200), shared_album: SH.shareText(e.album, 200), found_album: f.album.title });
      } else {
        missing.push({ title: SH.shareText(e && e.title, 200), artist: SH.shareText(e && e.creator, 200), album: SH.shareText(e && e.album, 200) });
      }
    }
    res.json({ ok: true, name: SH.shareText(doc.playlist.title, PL_NAME_MAX) || "Shared playlist",
      total: doc.playlist.track.length, truncated: doc.playlist.track.length > PL_TRACKS_MAX,
      resolved, missing, substituted, deep_available: false });
  });

  // -------------------------------------------------------------- updates

  const REPO = process.env.UPDATE_REPO || "meltface-80/MusicD-Server";
  const upd = { current: ctx.version, latest: null, latestTag: null, available: false, isDowngrade: false,
    html_url: null, notes: null, source: null, checkedAt: null, checking: false, error: null, viaLauncher: false,
    apply: { phase: "idle", error: null, version: null } };
  const cmp = (a, b) => {
    const pa = String(a).replace(/^v/, "").split(".").map(Number), pb = String(b).replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
  };
  function check() {
    if (upd.checking || process.env.UPDATE_CHECK === "false") return Promise.resolve();
    upd.checking = true;
    return new Promise((resolve) => {
      const req = https.get({ host: "api.github.com", path: `/repos/${REPO}/releases/latest`, timeout: 10000,
        headers: { "User-Agent": "MusicD-Server", Accept: "application/vnd.github+json" } }, (r) => {
        let body = "";
        r.on("data", c => { body += c; });
        r.on("end", () => {
          try {
            if (r.statusCode === 200) {
              const j = JSON.parse(body);
              upd.latestTag = j.tag_name; upd.latest = String(j.tag_name).replace(/^v/, "");
              upd.html_url = j.html_url; upd.notes = j.body || null; upd.source = "release";
              upd.available = cmp(upd.latest, upd.current) > 0; upd.error = null;
            } else if (r.statusCode === 404) { upd.error = null; upd.available = false; }
            else upd.error = "GitHub answered " + r.statusCode;
          } catch (e) { upd.error = e.message; }
          upd.checkedAt = Date.now(); upd.checking = false; resolve();
        });
      });
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", (e) => { upd.error = e.message; upd.checking = false; upd.checkedAt = Date.now(); resolve(); });
    });
  }
  setTimeout(check, 30000).unref();
  setInterval(check, 12 * 3600 * 1000).unref();

  app.get("/api/update/status", (req, res) => res.json(Object.assign({}, upd, { is_docker: process.env.DOCKER === "1" })));
  app.post("/api/update/check", async (req, res) => { await check(); res.json(Object.assign({}, upd, { is_docker: process.env.DOCKER === "1" })); });
  app.post("/api/update/apply", (req, res) => res.status(409).json({
    error: "Update the container instead: docker pull ghcr.io/meltface-80/musicd-server:latest, then re-run your docker run / docker compose up -d."
  }));
};
