"use strict";
/*
 * api-library.js — the library, its artwork, everything written about it,
 * and the settings behind the screens that show it.
 */
const fs = require("fs");
const shareLinks = require("../share-links");
const similar = require("../similar");
const qobuzDeep = require("../qobuz-deeplink");
const META = require("../meta");
const WF = require("../waveform");
const WFD = require("../waveform-decode");
const N = require("../library/normalize");
const ArtFind = require("../library/artfind");
const { Artwork } = require("../library/artwork");

const DAY = 86400000;

module.exports = function mountLibrary(app, ctx) {
  const { db, library, scanner, artwork, zones, features } = ctx;

  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { res.status(e.status || 500).json({ error: e.message || String(e) }); }
  };
  const building = () => scanner.state.running && !library.count;
  const notReady = res => res.status(503).json({ error: "The library is still being scanned" });

  // ------------------------------------------------------------- status

  app.get("/api/status", (req, res) => {
    res.json({
      paired: true,
      core_id: "musicd-server",
      core_name: "MusicD Server",
      zone_count: zones.zones().length,
      library_importing: scanner.state.running,
      library_recheck_pending: false,
      index_built_at: library.builtAt || null,
      index_count: library.count,
      // Additive: what the setup screen needs to say when nothing shows up.
      sonos: {
        rooms: zones.topology.rooms().length,
        discovered: zones.discovered,
        searching: zones.searching,
        error: zones.topology.lastError || null
      },
      music_dir: ctx.config.musicDir,
      // What the "nothing here yet" notice needs to say why.
      music_dir_exists: fs.existsSync(ctx.config.musicDir),
      // false: the data folder isn't a Docker volume, so the library and
      // your edits go with the container. null: couldn't tell.
      data_persistent: db.persistent,
      scan: {
        running: scanner.state.running,
        progress: scanner.state.progress,
        files_seen: scanner.state.files,
        last: scanner.state.lastResult || null
      },
      version: ctx.version,
      server: true
    });
  });

  app.get("/api/library-stats", (req, res) => res.json({ albums: library.count, tracks: library.trackCount(), building: building() }));
  app.get("/api/music-mount", (req, res) => res.json({ mounted: fs.existsSync(ctx.config.musicDir), path: ctx.config.musicDir }));

  app.get("/api/search-status", (req, res) => res.json({
    indexed: library.count, building: scanner.state.running, progress: scanner.state.progress,
    builtAt: library.builtAt, ready: library.count > 0 || !scanner.state.running, count: library.count
  }));

  async function rescan(force) {
    const r = await scanner.scan({ force });
    if (r.status !== "running") ctx.afterScan();
    return r;
  }

  app.post("/api/library/rescan", wrap(async (req, res) => {
    if (scanner.state.running) return res.json({ status: "running", progress: scanner.state.progress });
    // A big first scan takes minutes: answer at once and let the page poll.
    const p = rescan(!!(req.body && req.body.force));
    const quick = await Promise.race([p, new Promise(r => setTimeout(() => r(null), 8000))]);
    if (!quick) return res.json({ status: "running", progress: scanner.state.progress });
    res.json({ status: quick.status === "updated" ? "rebuilt" : quick.status, count: library.count, ...quick });
  }));
  app.post("/api/reindex", wrap(async (req, res) => {
    const r = await rescan(true);
    res.json({ ok: true, indexed: library.count, ...r });
  }));

  // ------------------------------------------------------------ albums

  function parseFilter(src) {
    const type = String(src.filter_type || "").trim();
    const value = String(src.filter_value || "").trim();
    if (!type || !value) return null;
    if (!["genre", "tag", "decade"].includes(type)) return null;
    return { type, value, parent: String(src.filter_parent || "").trim() || undefined };
  }

  app.get("/api/random-albums", (req, res) => {
    if (building()) return notReady(res);
    const count = Math.max(1, Math.min(96, parseInt(req.query.count || "30", 10) || 30));
    const filter = parseFilter(req.query);
    const seed = req.query.seed !== undefined ? parseInt(req.query.seed, 10) : null;
    const r = library.random(count, filter, Number.isFinite(seed) ? seed : null);
    res.json({ albums: r.albums.map(a => library.json(a)), total: r.total, filtered: !!filter });
  });

  app.get("/api/library/albums", (req, res) => {
    if (building()) return notReady(res);
    const view = library.view(req.query);
    const total = view.length;
    const offset = Math.max(0, Math.min(total, parseInt(req.query.offset || "0", 10) || 0));
    const count = Math.max(1, Math.min(200, parseInt(req.query.count || "60", 10) || 60));
    res.json({ albums: view.slice(offset, offset + count).map(a => library.json(a)), offset, total });
  });

  app.get("/api/library/facets", (req, res) => {
    if (building()) return notReady(res);
    res.json(library.facets());
  });

  function trackRows(al) {
    const tracks = library.tracks(al.id);
    const discs = new Set(tracks.map(t => t.disc_no || 1));
    return tracks.map(t => {
      // The list numbers its own rows; a multi-disc set says which disc.
      const disc = discs.size > 1 ? `Disc ${t.disc_no || 1}` : "";
      const credit = t.artist && N.fold(t.artist) !== al.nArtist ? t.artist : "";
      const fmt = [];
      if (t.lossless && t.bits && t.sample_rate) fmt.push(`${t.bits}/${t.sample_rate / 1000 % 1 ? (t.sample_rate / 1000).toFixed(1) : t.sample_rate / 1000}`);
      return {
        title: t.title,
        subtitle: [credit, disc, fmtLen(t.duration)].filter(Boolean).join(" · "),
        length: Math.round(t.duration || 0),
        track_id: t.id,
        quality: fmt[0] || null
      };
    });
  }

  app.get("/api/album", (req, res) => {
    const al = library.album(req.query.offset);
    if (!al) return res.status(409).json({ error: "That album is no longer in the library — rescan to refresh" });
    const tracks = trackRows(al);
    res.json({
      album: Object.assign(library.json(al), { year: al.year, genres: al.genres }),
      tracks,
      actions: [
        { kind: "play_now", title: "Play Now" },
        { kind: "queue", title: "Queue" },
        { kind: "play_next", title: "Play Next" },
        { kind: "shuffle", title: "Shuffle" },
        { kind: "radio", title: "Start Radio" }
      ],
      offset: al.id,
      artists: al.compilation ? [al.artist] : N.splitArtists(al.artist),
      library_moved: false,
      partial: false,
      declared_tracks: tracks.length
    });
  });

  // ------------------------------------------------------- album edits
  //
  // The music folders are mounted read-only, so corrections are kept in the
  // database and laid over what the scan found (see library.saveEdit).

  async function editState(al) {
    return {
      offset: al.id,
      title: al.title, artist: al.artist, year: al.year,
      scanned: al.scanned,
      edited: al.edited,
      image_key: al.image_key,
      art: { own: await artwork.hasOwnArt(al), found: al.customArt, source: al.artSource }
    };
  }

  app.get("/api/album/edit", wrap(async (req, res) => {
    const al = library.album(req.query.offset);
    if (!al) return res.status(404).json({ error: "That album is no longer in the library" });
    res.json(await editState(al));
  }));

  const artSearches = new Map();
  app.get("/api/album/art-search", wrap(async (req, res) => {
    const al = library.album(req.query.offset);
    if (!al) return res.status(404).json({ error: "That album is no longer in the library" });
    // Searched by the scanned names too when they differ: a corrected title
    // is usually the better query, but the tags are what's on the files.
    const key = al.id + "|" + al.title + "|" + al.artist;
    let p = artSearches.get(key);
    if (!p) {
      p = ArtFind.find(al, library.tracks(al.id).map(t => t.title), { log: ctx.log });
      artSearches.set(key, p);
      p.catch(() => {}).finally(() => setTimeout(() => artSearches.delete(key), 10 * 60 * 1000));
    }
    res.json(await p);
  }));

  app.post("/api/album/edit", wrap(async (req, res) => {
    const b = req.body || {};
    let al = library.album(b.offset);
    if (!al) return res.status(404).json({ error: "That album is no longer in the library" });
    const fields = {};
    for (const k of ["title", "artist", "year"]) if (k in b) fields[k] = b[k];
    if (b.art_url) {
      const got = await Artwork.download(String(b.art_url).trim());
      fields.art = { buf: got.buf, source: String(b.art_source || b.art_url).slice(0, 500) };
    } else if (b.art === null || b.art === "remove") {
      fields.art = null;
    }
    const keyBefore = al.image_key;
    al = library.saveEdit(al.id, fields);
    if (al.image_key !== keyBefore) artwork.forget(al.id, al.image_key);
    res.json(Object.assign(await editState(al), { album: library.json(al, { year: al.year }) }));
  }));

  app.post("/api/album/edit/reset", wrap(async (req, res) => {
    let al = library.album((req.body || {}).offset);
    if (!al) return res.status(404).json({ error: "That album is no longer in the library" });
    const keyBefore = al.image_key;
    al = library.clearEdits(al.id);
    if (al.image_key !== keyBefore) artwork.forget(al.id, al.image_key);
    res.json(Object.assign(await editState(al), { album: library.json(al, { year: al.year }) }));
  }));

  // ------------------------------------------------------------ search

  app.get("/api/search", (req, res) => {
    const q = String(req.query.q || "");
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || "60", 10) || 60));
    if (!q.trim()) return res.json({ query: q, results: [], artists: [], labels: [], indexed: library.count });
    if (building()) return res.json({ query: q, results: [], artists: [], labels: [], building: true, progress: scanner.state.progress });
    const results = library.search(q, limit);
    res.json({
      query: q, count: results.length, indexed: library.count, results,
      labels: [], artists: library.searchArtists(q)
    });
  });

  app.get("/api/search/external", wrap(async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ query: q, qobuz: null, tidal: null, pitchfork: [] });
    const pf = await Promise.race([
      META.searchPitchforkReviews(q, 6).catch(() => []),
      new Promise(r => setTimeout(() => r([]), 10000))
    ]);
    res.json({ query: q, qobuz: null, tidal: null, pitchfork: pf });
  }));

  // ------------------------------------------------------------ artists

  app.get("/api/artists", (req, res) => {
    const all = library.artists(String(req.query.sort || "az"), parseInt(req.query.seed, 10) || 1);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 120));
    res.json({
      artists: all.slice(offset, offset + limit).map(a => ({ name: a.name, albumCount: a.albumCount, image_key: a.image_key })),
      offset, total: all.length
    });
  });

  app.get("/api/artist-albums", (req, res) => {
    const artist = String(req.query.artist || "").trim();
    if (!artist) return res.status(400).json({ error: "artist required" });
    const { primary, featured } = library.artistAlbums(artist);
    res.json({ artist, primary: primary.map(a => library.json(a)), featured: featured.map(a => library.json(a)) });
  });

  const bioMemo = new Map();
  async function artistBio(name, album) {
    const key = N.fold(name) + "||" + N.fold(album || "");
    if (bioMemo.has(key)) return bioMemo.get(key);
    let bio = db.cacheGet("artist-bio", key, 30 * DAY);
    if (bio === undefined) {
      bio = await META.fetchWikiArtist(name, album || null).catch(() => null);
      db.cachePut("artist-bio", key, bio || null);
    }
    bioMemo.set(key, bio);
    if (bioMemo.size > 500) bioMemo.delete(bioMemo.keys().next().value);
    return bio;
  }

  app.get("/api/artist-bio", wrap(async (req, res) => {
    const artist = String(req.query.artist || "").trim();
    if (!artist) return res.status(400).json({ error: "artist required" });
    const bio = await artistBio(artist, String(req.query.album || "").trim());
    if (!bio || !bio.description) return res.json({ bio: null });
    res.json({ bio: { name: bio.name || artist, text: bio.description, source: bio.source || "Wikipedia", image: null } });
  }));

  // ----------------------------------------------------------- filters

  app.get("/api/filters/genres", (req, res) => res.json({ genres: library.genres().map(g => ({ title: g.title, subtitle: g.subtitle })) }));
  app.get("/api/filters/decades", (req, res) => {
    if (building()) return notReady(res);
    res.json({ decades: library.decades().map(d => ({ title: d.title, subtitle: d.subtitle })) });
  });
  app.get("/api/filters/tags", (req, res) => res.json({ tags: [] }));

  // -------------------------------------------------------------- home

  app.get("/api/home/unplayed", (req, res) => {
    let months = parseInt(req.query.months, 10);
    if (!Number.isFinite(months) || months <= 0 || months > 60) months = 6;
    let count = parseInt(req.query.count, 10);
    if (!Number.isFinite(count) || count <= 0 || count > 96) count = 12;
    const r = features.unplayed(count, months);
    res.json({ albums: r.albums.map(a => library.json(a)), total: r.total, months });
  });

  app.get("/api/home/history", (req, res) => {
    const count = Math.min(60, Math.max(1, parseInt(req.query.count, 10) || 60));
    res.json({ albums: features.historyAlbums(count, 30).map(a => library.json(a)), days: 30 });
  });

  app.get("/api/home/album-of-the-day", (req, res) => {
    const al = library.albumOfTheDay();
    if (!al) return res.json({ album: null });
    if (features.playedToday(al.id)) return res.json({ album: null, played: true });
    res.json({ album: library.json(al) });
  });

  function isoWeekKey(d = new Date()) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return t.getUTCFullYear() + "-W" + Math.ceil(((t - yStart) / DAY + 1) / 7);
  }

  app.get("/api/home/label-of-the-week", (req, res) => res.json({ label: null, albums: [] }));

  /*
   * Home's "Browse by genre" row, split into Pop and Rock/Metal the way the
   * original's Roon genre tree was. File tags are flat, so the same patterns
   * sort each tagged genre into one family or neither.
   */
  app.get("/api/home/genre-groups", (req, res) => {
    const SOFT_RE = /\b(soft\s*rock|folk[\s-]?rock|country[\s-]?rock|adult\s*contemporary|easy\s*listening|singer[\s\/-]*songwriter|new\s*age|lounge|smooth\s*jazz|yacht\s*rock)\b/i;
    const HARD_RE = /\b(metal|metalcore|thrash|sludge|doom|hard\s*rock|album\s*rock|classic\s*rock|blues[\s-]?rock|southern\s*rock|stoner|post[\s-]?rock|prog|art\s*rock|krautrock|psychedel|britpop|grunge|punk|hardcore|emo|shoegaze|indie|alternative|garage|rockabilly|surf|glam|goth|industrial|ska|rock)\b/i;
    const POPFAM_RE = /\b(pop|dance|disco|synth|new\s*wave|electropop|r&b|rhythm\s*&\s*blues|soul|motown|funk)\b/i;
    const pop = [], rockmetal = [];
    for (const g of library.genres()) {
      const entry = { title: g.title, count: g.count };
      if (/\bpop\b/i.test(g.title)) pop.push(entry);
      else if (SOFT_RE.test(g.title)) continue;
      else if (HARD_RE.test(g.title)) rockmetal.push(entry);
      else if (POPFAM_RE.test(g.title)) pop.push(entry);
    }
    res.json({ parent: null, pop, rockmetal, flat: true });
  });

  // ------------------------------------------------------------ labels
  // Labels are not part of MusicD Server: no label pages, no Label of the
  // week, no label facet or search. These answer "off" in the shapes the
  // interface already handles, so nothing it asks for becomes an error.
  app.get("/api/filters/labels", (req, res) => res.json({ labels: [], scanning: false, progress: 0, count: 0 }));
  app.get("/api/label-albums", (req, res) => res.json({ albums: [], total: 0, label: String(req.query.label || ""), order: "alpha", logo_url: null }));
  app.get("/api/labels-scan-status", (req, res) => res.json({ scanning: false, progress: 0, count: 0, builtAt: library.builtAt }));
  app.all(/^\/api\/labels(\/.*)?$/, (req, res) => res.status(410).json({ error: "Labels aren't part of MusicD Server" }));
  app.get("/api/labels-scan-log", (req, res) => res.json({ lines: [] }));
  app.get("/api/settings/labels", (req, res) => res.json({ enabled: false, count: 0, scanning: false }));
  app.post("/api/settings/labels", (req, res) => res.status(410).json({ error: "Labels aren't part of MusicD Server", enabled: false }));
  // Asked for by the Settings screen as it opens; both belong to labels.
  app.get("/api/settings/label-folder-depth", (req, res) => res.json({ depth: 0 }));
  app.get("/api/settings/discogs-token", (req, res) => res.json({ set: false, configured: false }));
  for (const [route, key, field] of [["fanart-key", "fanartKey", "key"]]) {
    app.get(`/api/settings/${route}`, (req, res) => {
      const v = String(db.setting(key, "") || "");
      // Enough of the key to recognise it, never the whole thing.
      res.json({ set: !!v, configured: !!v, masked: v ? "••••" + v.slice(-4) : "" });
    });
    app.post(`/api/settings/${route}`, (req, res) => {
      db.setSetting(key, String((req.body || {})[field] || "").trim());
      res.json({ ok: true, set: !!db.setting(key, "") });
    });
  }

  // ------------------------------------------------------------ images

  app.get("/api/image/:key", wrap(async (req, res) => {
    const size = req.query.size || req.query.width || 400;
    // An album's address changes with its cover. One from before a change —
    // a tile drawn earlier, a Sonos queue from before the edit — is answered
    // with the album's CURRENT cover, and not cached, so it can't go on
    // showing the old picture. The current address never changes what it
    // shows, so that one is cached for good.
    let key = req.params.key;
    let current = true;
    const m = /^al-(\d+)-/.exec(key);
    if (m) {
      const al = library.album(Number(m[1]));
      if (al && al.image_key !== key) { key = al.image_key; current = false; }
    }
    const got = await artwork.get(key, size);
    if (!got) return res.status(404).end();
    res.set("Cache-Control", current ? "public, max-age=604800, immutable" : "no-cache");
    res.type(got.type);
    res.sendFile(got.file);
  }));

  // ---------------------------------------------------- write-ups, reviews

  const extrasMemo = new Map();
  async function albumExtras(title, artist) {
    const key = N.fold(title) + "||" + N.fold(artist);
    if (extrasMemo.has(key)) return extrasMemo.get(key);
    let v = db.cacheGet("extras", key, 30 * DAY);
    if (v === undefined) {
      const [year, bios] = await Promise.all([
        META.fetchAlbumYear(title, artist).catch(() => null),
        META.fetchAlbumBios(title, artist).catch(() => null)
      ]);
      v = { year, bios };
      // Only a real answer is kept for a month; a miss is retried tomorrow.
      if (year || (bios && (bios.album || bios.artist))) db.cachePut("extras", key, v);
    }
    extrasMemo.set(key, v);
    if (extrasMemo.size > 500) extrasMemo.delete(extrasMemo.keys().next().value);
    return v;
  }

  app.get("/api/album/extras", wrap(async (req, res) => {
    const title = String(req.query.title || "");
    const artist = String(req.query.artist || "");
    if (!title) return res.status(400).json({ error: "title query parameter required" });
    const al = library.relocate(title, artist);
    let year = al && al.year ? String(al.year) : null;
    let bios = null;
    if (req.query.fast !== "1") {
      const ex = await albumExtras(title, artist);
      year = year || ex.year;
      bios = ex.bios;
    } else {
      const hit = db.cacheGet("extras", N.fold(title) + "||" + N.fold(artist));
      if (hit) { year = year || hit.year; bios = hit.bios; }
    }
    if (bios && bios.album && year) bios.album.year = year;
    // No labels anywhere: not on the album page, not on the share card.
    if (bios && bios.album) bios.album = Object.assign({}, bios.album, { label: null });
    const services = ctx.shareServices();
    const reviews = ctx.shareReviews();
    const locale = shareLinks.localeFromAcceptLanguage(req.headers["accept-language"]);
    res.json({
      year,
      album: bios ? bios.album : null,
      artist: bios ? bios.artist : null,
      card: { review: cardReview() },
      links: {
        services: shareLinks.serviceLinks(artist, title, { locale, enabled: services }),
        reviews: shareLinks.reviewLinks(artist, title, {
          enabled: reviews,
          wikipediaUrl: bios && bios.urls ? bios.urls.wikipediaAlbum : null,
          pitchforkUrl: bios && bios.urls ? bios.urls.pitchfork : null,
          wikipediaArtistUrl: bios && bios.urls ? bios.urls.wikipediaArtist : null
        })
      }
    });
  }));

  app.get("/api/pitchfork/reviews", wrap(async (req, res) => {
    const type = req.query.type === "best" ? "best" : "latest";
    res.json({ type, items: await META.getPitchforkReviews(type) });
  }));
  app.get("/api/pitchfork/review", (req, res) => {
    let u;
    try { u = new URL(String(req.query.url || "")); } catch (e) { return res.status(400).json({ error: "Invalid url" }); }
    if (u.hostname !== "pitchfork.com" || !u.pathname.startsWith("/reviews/albums/")) {
      return res.status(400).json({ error: "Not a Pitchfork album-review URL" });
    }
    const album = String(req.query.album || ""), artist = String(req.query.artist || "");
    const al = library.relocate(album, artist);
    let match = al ? library.json(al) : null;
    if (!match && N.fold(album)) {
      // The same confident-only rule as the original: a Play button must
      // never point at the wrong record.
      const want = N.fold(album);
      match = library.search((artist ? artist + " " : "") + album, 3)
        .find(h => { const got = N.fold(h.title); return got && (got === want || got.startsWith(want) || want.startsWith(got)); }) || null;
    }
    res.json({ review: null, match });
  });

  // ------------------------------------------------------ share card

  // Whether the card itself carries the write-up (the paragraph under the
  // cover). On unless switched off in Settings → Share Card.
  const cardReview = () => db.setting("shareCardReview", true) !== false;
  app.get("/api/settings/share-links", (req, res) => res.json({
    services: { all: shareLinks.SERVICES, enabled: ctx.shareServices() },
    reviews: { all: shareLinks.REVIEWS, enabled: ctx.shareReviews() },
    card: { review: cardReview() }
  }));
  app.post("/api/settings/share-links", (req, res) => {
    const b = req.body || {};
    let touched = false;
    if (Array.isArray(b.services)) { db.setSetting("shareServices", shareLinks.sanitiseIds(b.services, shareLinks.knownServiceIds())); touched = true; }
    if (Array.isArray(b.reviews)) { db.setSetting("shareReviews", shareLinks.sanitiseIds(b.reviews, shareLinks.knownReviewIds())); touched = true; }
    if (typeof b.card_review === "boolean") { db.setSetting("shareCardReview", b.card_review); touched = true; }
    if (!touched) return res.status(400).json({ error: "services, reviews and/or card_review required" });
    res.json({ ok: true, services: ctx.shareServices(), reviews: ctx.shareReviews(), card: { review: cardReview() } });
  });

  const qobuzLinkMemo = new Map();
  app.get("/api/qobuz-link", wrap(async (req, res) => {
    const album = String(req.query.album || "").trim();
    const artist = String(req.query.artist || "").trim();
    if (!album) return res.status(400).json({ error: "album query parameter required" });
    const store = shareLinks.qobuzStorefront(shareLinks.localeFromAcceptLanguage(req.headers["accept-language"]));
    const key = store + "|" + similar.normalize(artist) + "|" + similar.normalize(album);
    let id = qobuzLinkMemo.get(key);
    if (id === undefined) {
      id = "";
      try {
        const query = shareLinks.searchQuery(shareLinks.primaryArtist(artist), album);
        if (query) {
          const html = await META.httpText(qobuzDeep.searchUrl(store, query), {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9"
          });
          id = qobuzDeep.pickAlbumId(html, store, shareLinks.primaryArtist(artist), album) || "";
        }
      } catch (e) { id = ""; }
      qobuzLinkMemo.set(key, id);
      if (qobuzLinkMemo.size > 500) qobuzLinkMemo.delete(qobuzLinkMemo.keys().next().value);
    }
    res.set("Cache-Control", "public, max-age=604800");
    res.json({ url: qobuzDeep.deepLink(id || null) });
  }));

  const similarMemo = new Map();
  app.get("/api/similar", wrap(async (req, res) => {
    const artist = String(req.query.artist || "").trim();
    if (!artist) return res.status(400).json({ error: "artist query parameter required" });
    const primary = shareLinks.primaryArtist(artist);
    const key = similar.normalize(primary);
    let acts = similarMemo.get(key) || db.cacheGet("similar", key, DAY);
    if (!acts) {
      acts = [];
      try {
        const search = await META.httpJson("https://api.deezer.com/search/artist?limit=" + similar.SEARCH_ROWS + "&q=" + encodeURIComponent(primary));
        for (const cand of similar.readDeezerArtists(search, primary).slice(0, similar.CANDIDATES)) {
          const rel = similar.readDeezerRelated(await META.httpJson("https://api.deezer.com/artist/" + encodeURIComponent(cand.id) + "/related?limit=" + similar.WANTED));
          if (!rel.length) continue;
          for (const act of rel) {
            let album = null;
            try { album = similar.readDeezerAlbums(await META.httpJson("https://api.deezer.com/artist/" + encodeURIComponent(act.id) + "/albums?limit=50")); } catch (e) { album = null; }
            acts.push(similar.toAct(act, album));
          }
          break;
        }
        db.cachePut("similar", key, acts);
      } catch (e) { acts = []; }
      similarMemo.set(key, acts);
    }
    const enabled = ctx.shareServices();
    const locale = shareLinks.localeFromAcceptLanguage(req.headers["accept-language"]);
    res.set("Cache-Control", "no-store");
    res.json({
      acts: acts.map(act => {
        // In the library by that act → it can be played; otherwise any of
        // their albums we own will do before sending someone to a store.
        let inLib = act.album ? library.relocate(act.album, act.name) : null;
        if (!inLib) {
          const mine = library.artistAlbums(act.name).primary;
          if (mine.length) inLib = mine[0];
        }
        return Object.assign({}, act, {
          album: inLib ? inLib.title : act.album,
          in_library: !!inLib, offset: inLib ? inLib.id : null,
          library_title: inLib ? inLib.title : null, library_subtitle: inLib ? inLib.artist : null,
          services: inLib ? [] : shareLinks.serviceLinks(act.name, act.album || "", { locale, enabled })
        });
      })
    });
  }));

  // ------------------------------------------------------------ waveform

  const waveformOn = () => db.setting("waveformEnabled", false);
  let wfBusy = null;
  const wfInflight = new Map();

  function wfTrack(title, album, artist) {
    const al = library.relocate(album, artist) || library.relocate(album, null);
    if (!al) return null;
    const want = N.fold(title);
    return library.tracks(al.id).find(t => N.fold(t.title) === want) || null;
  }

  async function waveformFor(t) {
    const key = `t${t.id}-${t.mtime}`;
    const hit = db.cacheGet("waveform", key);
    if (hit) return Object.assign({ cached: true }, hit);
    if (wfInflight.has(key)) return wfInflight.get(key);
    const p = (async () => {
      const peaks = await WFD.decodeWaveform(t.path, { expectSeconds: t.duration || 0 });
      if (!peaks) {
        ctx.log(`[waveform] no waveform for ${t.title}: ${WFD.lastDecodeError() || "undecodable"}`);
        return null;
      }
      const v = { peaks: WF.encode(peaks), n: peaks.length };
      db.cachePut("waveform", key, v);
      return Object.assign({ cached: false }, v);
    })().finally(() => wfInflight.delete(key));
    wfInflight.set(key, p);
    return p;
  }
  ctx.waveformFor = (t) => waveformOn() ? waveformFor(t).catch(() => null) : null;

  app.get("/api/waveform", wrap(async (req, res) => {
    if (!waveformOn()) return res.json({ peaks: null, reason: "off" });
    const title = String(req.query.track || "").trim();
    if (!title && !req.query.track_id) return res.status(400).json({ error: "track required" });
    const t = req.query.track_id ? library.track(req.query.track_id) :
      wfTrack(title, String(req.query.album || ""), String(req.query.artist || ""));
    if (!t) return res.json({ peaks: null, reason: "no-local-file" });
    if (wfBusy && wfBusy !== t.id && !wfInflight.size) wfBusy = null;
    wfBusy = t.id;
    try {
      const out = await waveformFor(t);
      if (!out) return res.json({ peaks: null, reason: "undecodable" });
      res.set("Cache-Control", "public, max-age=604800, immutable");
      res.json({ peaks: out.peaks, n: out.n, cached: out.cached });
    } finally { wfBusy = null; }
  }));

  app.get("/api/settings/waveform", (req, res) => res.json({
    enabled: waveformOn(), decoder: !!require("../ffmpeg").info().ok,
    qobuz_secret_set: false, qobuz_sign_app_id: null, qobuz_sign_token_set: false,
    qobuz_connected: false, qobuz_user: "", qobuz_ready: false
  }));
  app.post("/api/settings/waveform", (req, res) => {
    if ((req.body || {}).enabled === undefined) return res.status(400).json({ error: "enabled required" });
    db.setSetting("waveformEnabled", !!req.body.enabled);
    res.json({ ok: true, enabled: !!req.body.enabled, qobuz_secret_set: false });
  });

  // ------------------------------------------------------ wall display

  const displayOn = () => db.setting("displayEnabled", true);
  app.get("/api/settings/display", (req, res) => res.json({ enabled: displayOn(), seconds: db.setting("displaySeconds", 20) }));
  app.post("/api/settings/display", (req, res) => {
    const b = req.body || {};
    if (typeof b.enabled === "boolean") db.setSetting("displayEnabled", b.enabled);
    if (b.seconds != null) {
      const s = parseInt(b.seconds, 10);
      if (Number.isFinite(s) && s >= 5 && s <= 60) db.setSetting("displaySeconds", s);
    }
    res.json({ ok: true, enabled: displayOn(), seconds: db.setting("displaySeconds", 20) });
  });

  async function artistPhotos(name) {
    const key = db.setting("fanartKey", "");
    if (!key || !name) return [];
    const ck = N.fold(name);
    const hit = db.cacheGet("fanart", ck, 7 * DAY);
    if (hit) return hit;
    let photos = [];
    try {
      const mb = await META.httpJson(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${name.replace(/"/g, "")}"`)}&fmt=json&limit=5`, { "User-Agent": META.MB_USER_AGENT });
      const a = (mb.artists || []).find(x => META.namesEqualLoose(x.name, name));
      if (a && a.id) {
        const j = await META.httpJson(`https://webservice.fanart.tv/v3/music/${encodeURIComponent(a.id)}?api_key=${encodeURIComponent(key)}`);
        photos = [].concat(j.artistbackground || [], j.artistthumb || []).map(x => x && x.url).filter(Boolean).slice(0, 4);
      }
    } catch (e) { photos = []; }
    db.cachePut("fanart", ck, photos);
    return photos;
  }

  app.get("/api/display/content", wrap(async (req, res) => {
    if (!displayOn()) return res.status(403).json({ error: "Wall display is turned off in Settings" });
    const z = zones.zone(String(req.query.zone || ""));
    const st = z && z._state;
    if (!st || (!st.title && !st.trackId)) return res.json({ artistPhotos: [], review: null, video: null });
    const t = st.trackId ? library.track(st.trackId) : null;
    const al = t ? library.album(t.album_id) : null;
    const artist = (al && al.artist) || (t && t.artist) || st.artist || "";
    const album = (al && al.title) || st.album || "";
    const primary = shareLinks.primaryArtist(artist);
    const [photos, ex] = await Promise.all([
      artistPhotos(primary),
      album ? albumExtras(album, artist).catch(() => null) : null
    ]);
    const bios = ex && ex.bios;
    const review = bios && bios.album && bios.album.description
      ? { text: bios.album.description, attribution: "About this album — " + (bios.album.description_source || bios.album.source || "") } : null;
    const names = (al && al.compilation) ? [t && t.artist].filter(Boolean) : N.splitArtists(artist).slice(0, 4);
    const bioList = (await Promise.all(names.map(async n => {
      const w = await artistBio(n, album);
      return w && w.description ? { name: w.name || n, text: w.description, attribution: "About " + (w.name || n) + " — " + (w.source || "Wikipedia") } : null;
    }))).filter(Boolean);
    const moreArtist = library.artistAlbums(primary).primary.filter(a => !al || a.id !== al.id).slice(0, 12);
    res.json({
      artistPhotos: photos, review, bio: bioList[0] || null, bios: bioList,
      moreAlbums: {
        artist: moreArtist.length >= 3 ? { name: primary, albums: moreArtist.map(a => library.json(a)) } : null,
        label: null
      }
    });
  }));

  // --------------------------------------------------- smart picks etc

  app.get("/api/smart-picks", (req, res) => res.json(features.smartPicksJson()));
  app.post("/api/smart-picks/rebuild", (req, res) => { features.kickSmartPicks(true); res.json({ ok: true, building: true }); });
  app.post("/api/smart-picks/block", (req, res) => {
    const artist = String((req.body || {}).artist || "").trim();
    if (!artist) return res.status(400).json({ error: "artist required" });
    try { features.blockArtist(artist); res.json({ ok: true, artist }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get("/api/settings/smart-picks", (req, res) => res.json(features.smartSettings()));
  app.post("/api/settings/smart-picks", (req, res) => {
    const b = req.body || {};
    if (b.hour !== undefined) {
      const h = Number(b.hour);
      if (!Number.isFinite(h) || h < 0 || h > 23) return res.status(400).json({ error: "hour must be 0-23" });
      db.setSetting("smartPicksHour", Math.trunc(h));
    }
    if (b.enabled !== undefined) db.setSetting("smartPicksEnabled", !!b.enabled);
    res.json(Object.assign({ ok: true }, features.smartSettings()));
  });

  app.get("/api/discover", (req, res) => res.json(features.discoverJson(req)));
  app.post("/api/discover/rebuild", (req, res) => {
    if (!features.discoverSettings().enabled) return res.status(400).json({ error: "Discover is switched off" });
    features.kickDiscover(true);
    res.json({ ok: true, building: true });
  });
  app.get("/api/settings/discover", (req, res) => res.json(features.discoverSettings()));
  app.post("/api/settings/discover", (req, res) => {
    const b = req.body || {};
    if (b.hour !== undefined) {
      const h = Number(b.hour);
      if (!Number.isFinite(h) || h < 0 || h > 23) return res.status(400).json({ error: "hour must be 0-23" });
      db.setSetting("discoverHour", Math.trunc(h));
    }
    if (b.enabled !== undefined) db.setSetting("discoverEnabled", !!b.enabled);
    if (b.enabled) features.kickDiscover(true);
    const s = features.discoverSettings();
    res.json({ ok: true, enabled: s.enabled, hour: s.hour });
  });

  // ------------------------------------------------------- home rows

  const HOME_ROWS = ["unplayed", "history", "picks", "random", "library", "genres"];
  function homeRows() {
    const stored = db.setting("homeRows", null);
    const out = [], seen = new Set();
    if (Array.isArray(stored)) {
      for (const r of stored) {
        if (!r || !HOME_ROWS.includes(r.id) || seen.has(r.id)) continue;
        seen.add(r.id); out.push({ id: r.id, on: r.on !== false });
      }
    }
    for (const id of HOME_ROWS) if (!seen.has(id)) out.push({ id, on: true });
    return out;
  }
  app.get("/api/settings/home-rows", (req, res) => res.json({
    rows: homeRows().map(r => Object.assign({}, r, {
      unavailable: r.id === "picks" && !features.smartSettings().enabled ? "Smart Picks is off in Settings" : null
    }))
  }));
  app.post("/api/settings/home-rows", (req, res) => {
    const rows = (req.body || {}).rows;
    if (!Array.isArray(rows)) return res.status(400).json({ error: "rows array required" });
    const clean = [], seen = new Set();
    for (const r of rows) {
      if (!r || !HOME_ROWS.includes(r.id) || seen.has(r.id)) continue;
      seen.add(r.id); clean.push({ id: r.id, on: r.on !== false });
    }
    if (!clean.length) return res.status(400).json({ error: "no recognisable rows" });
    db.setSetting("homeRows", clean);
    res.json({ ok: true, rows: homeRows() });
  });

  // ------------------------------------------- streaming: not in this build

  const noStreaming = (res) => res.status(410).json({ error: "MusicD Server plays your own files — there are no streaming accounts to connect." });
  app.get("/api/settings/qobuz", (req, res) => res.json({ connected: false, configured: false, available: false }));
  app.get("/api/settings/tidal", (req, res) => res.json({ connected: false, configured: false, available: false }));
  app.get("/api/settings/tidal/status", (req, res) => res.json({ connected: false, pending: false }));
  app.all(/^\/api\/(qobuz|tidal)(\/.*)?$/, (req, res) => noStreaming(res));
  app.all(/^\/api\/settings\/(qobuz|tidal)\/.*$/, (req, res) => noStreaming(res));

  function fmtLen(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    if (!sec) return "";
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
};
