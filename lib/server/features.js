"use strict";
/*
 * features.js — the parts of MusicD Remote that learn from listening:
 * play history, Random Album Radio, Smart Picks and Discover.
 *
 * History is the foundation. Each track that plays long enough to count is
 * written to the plays table with its album's id — a real id here, not a
 * title, so two artists' "Greatest Hits" never share a play count.
 */
const shareLinks = require("../share-links");
const similar = require("../similar");
const newRel = require("../newreleases");
const META = require("../meta");
const N = require("../library/normalize");
const { seededRank } = require("../library/index");

const DAY = 86400000;

function dayKey(d = new Date()) {
  const p = n => (n < 10 ? "0" + n : String(n));
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

class Features {
  constructor(ctx) {
    this.ctx = ctx;  // { db, library, zones, playback, log }
    this.raw = ctx.db.raw;
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS smart_blocks (canon TEXT PRIMARY KEY, artist TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS smart_picks (day TEXT, rank INTEGER, album_id INTEGER, reason TEXT, PRIMARY KEY(day, rank));
      CREATE TABLE IF NOT EXISTS new_releases (day TEXT, rank INTEGER, artist TEXT, album TEXT, album_id TEXT,
        cover TEXT, release_date TEXT, ts INTEGER, PRIMARY KEY(day, rank));
    `);
    this.insertPlay = this.raw.prepare(
      "INSERT INTO plays(album_id, track_id, title, artist, album, zone, ts) VALUES(?,?,?,?,?,?,?)");
    this.radioBusy = new Set();
    this.smartBuilding = null;
    this.discoverBuilding = null;
  }

  // ------------------------------------------------------------- history

  wire() {
    const { zones } = this.ctx;
    zones.on("played", (e) => this.recordPlay(e));
    zones.on("queue-low", (e) => this.radioTopUp(e.zoneId).catch(err => this.ctx.log(`[radio] ${err.message}`)));
    setInterval(() => this.maintenance(), 10 * 60 * 1000).unref();
    setTimeout(() => this.maintenance(), 60 * 1000).unref();
  }

  recordPlay(e) {
    const t = e.trackId ? this.ctx.library.track(e.trackId) : null;
    const al = t ? this.ctx.library.album(t.album_id) : null;
    try {
      this.insertPlay.run(
        al ? al.id : null, t ? t.id : null,
        (t && t.title) || e.title || "", (t && t.artist) || e.artist || "",
        (al && al.title) || e.album || "", e.zoneId, Date.now());
    } catch (err) { this.ctx.log(`[history] ${err.message}`); }
  }

  historyAlbums(count = 60, days = 30) {
    const rows = this.raw.prepare(
      "SELECT album_id, MAX(ts) AS ts FROM plays WHERE ts >= ? AND album_id IS NOT NULL GROUP BY album_id ORDER BY ts DESC LIMIT ?"
    ).all(Date.now() - days * DAY, count);
    return rows.map(r => this.ctx.library.album(r.album_id)).filter(Boolean);
  }

  playedToday(albumId) {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    return !!this.raw.prepare("SELECT 1 FROM plays WHERE album_id = ? AND ts >= ? LIMIT 1").get(albumId, midnight.getTime());
  }

  unplayed(count = 12, months = 6) {
    const heard = this.ctx.library.playedAlbumIdsSince(Date.now() - months * 30 * DAY);
    const pool = this.ctx.library.albums.filter(al => !heard.has(al.id));
    const out = new Set();
    const want = Math.min(count, pool.length);
    while (out.size < want) out.add(pool[Math.floor(Math.random() * pool.length)]);
    return { albums: [...out], total: pool.length };
  }

  // --------------------------------------------------------------- radio

  radioZones() { return new Set(this.ctx.db.setting("radioZones", [])); }
  radioEnabled(zoneId) { return this.radioZones().has(zoneId); }
  setRadio(zoneId, on) {
    const s = this.radioZones();
    if (on) s.add(zoneId); else s.delete(zoneId);
    this.ctx.db.setSetting("radioZones", [...s]);
  }

  /* Another whole album, one not heard lately, on the end of the queue. */
  async radioTopUp(zoneId, force = false) {
    if (!force && !this.radioEnabled(zoneId)) return null;
    if (this.radioBusy.has(zoneId)) return null;
    this.radioBusy.add(zoneId);
    try {
      const lib = this.ctx.library;
      if (!lib.count) return null;
      const recent = lib.playedAlbumIdsSince(Date.now() - 60 * DAY);
      let pool = lib.albums.filter(al => !recent.has(al.id));
      if (!pool.length) pool = lib.albums;
      const al = pool[Math.floor(Math.random() * pool.length)];
      await this.ctx.playback.playAlbum(zoneId, al.id, "queue");
      this.ctx.log(`[radio] ${zoneId}: queued "${al.title}" by ${al.artist}`);
      return al;
    } finally {
      this.radioBusy.delete(zoneId);
    }
  }

  // --------------------------------------------------------- smart picks

  smartSettings() {
    return {
      enabled: this.ctx.db.setting("smartPicksEnabled", true),
      hour: this.ctx.db.setting("smartPicksHour", 4),
      auto_add: false,
      service_ready: true
    };
  }

  readSmartPicks(day) {
    return this.raw.prepare("SELECT * FROM smart_picks WHERE day = ? ORDER BY rank").all(day);
  }

  blockArtist(artist) {
    const canon = N.fold(artist);
    if (!canon) throw new Error("unrecognisable artist name");
    this.raw.prepare("INSERT OR REPLACE INTO smart_blocks(canon, artist, ts) VALUES(?,?,?)").run(canon, artist, Date.now());
    const day = dayKey();
    for (const r of this.readSmartPicks(day)) {
      const al = this.ctx.library.album(r.album_id);
      if (al && al.artistNames.some(n => n.n === canon)) {
        this.raw.prepare("DELETE FROM smart_picks WHERE day = ? AND rank = ?").run(day, r.rank);
      }
    }
  }

  /*
   * Smart Picks, for a library of files: five records you OWN and have not
   * been playing, by acts next to the ones you have. The neighbours come from
   * Deezer's related-artists lists (keyless, public), seeded by what you played
   * over the last three months. With no history yet, or no network, it falls
   * back to the least-played corners of the library — still a daily five,
   * still steady until tomorrow.
   */
  async buildSmartPicks(day) {
    const lib = this.ctx.library;
    if (!lib.count) return;
    const blocked = new Set(this.raw.prepare("SELECT canon FROM smart_blocks").all().map(r => r.canon));
    const recent = lib.playedAlbumIdsSince(Date.now() - 180 * DAY);
    const eligible = al => !recent.has(al.id) && !al.artistNames.some(n => blocked.has(n.n)) && !al.compilation;
    const picks = [];
    const used = new Set();
    const seeds = newRel.playedArtists(
      this.raw.prepare("SELECT artist, ts FROM plays WHERE ts >= ? AND artist != ''").all(Date.now() - 90 * DAY),
      { split: shareLinks.primaryArtist, limit: 8 });
    for (const seed of seeds) {
      if (picks.length >= 5) break;
      let acts = [];
      try { acts = await this.relatedActs(seed.name); } catch (e) { acts = []; }
      for (const act of acts) {
        if (picks.length >= 5) break;
        const q = N.fold(act.name);
        const owned = lib.albums.filter(al => eligible(al) && !used.has(al.id) &&
          (al.nArtist === q || al.artistNames.some(n => n.n === q)));
        if (!owned.length) continue;
        const al = owned[seededRank(day + al0(owned), 7) % owned.length];
        used.add(al.id);
        picks.push({ album_id: al.id, reason: `Because you have been playing ${seed.name}` });
      }
    }
    // Fill with the least-played corners of the library.
    if (picks.length < 5) {
      const stats = lib.playStats();
      const pool = lib.albums.filter(al => eligible(al) && !used.has(al.id))
        .sort((a, b) => (stats.count.get(a.id) || 0) - (stats.count.get(b.id) || 0) ||
          seededRank(day + a.nTitle, 3) - seededRank(day + b.nTitle, 3));
      const bottom = pool.slice(0, Math.max(40, Math.ceil(pool.length / 4)));
      bottom.sort((a, b) => seededRank(day + a.nTitle + a.nArtist, 11) - seededRank(day + b.nTitle + b.nArtist, 11));
      for (const al of bottom) {
        if (picks.length >= 5) break;
        used.add(al.id);
        const n = stats.count.get(al.id) || 0;
        picks.push({ album_id: al.id, reason: n ? `Played ${n} time${n === 1 ? "" : "s"}, and not for a while` : "Never played here" });
      }
    }
    const ins = this.raw.prepare("INSERT OR REPLACE INTO smart_picks(day, rank, album_id, reason) VALUES(?,?,?,?)");
    this.raw.transaction(() => {
      this.raw.prepare("DELETE FROM smart_picks WHERE day = ?").run(day);
      picks.forEach((p, i) => ins.run(day, i, p.album_id, p.reason));
      this.raw.prepare("DELETE FROM smart_picks WHERE day < ?").run(dayKey(new Date(Date.now() - 7 * DAY)));
    })();
    this.ctx.log(`[smart] ${day}: ${picks.length} picks from ${seeds.length} seed artists`);
  }

  async relatedActs(name) {
    const key = N.fold(name);
    const hit = this.ctx.db.cacheGet("related", key, 7 * DAY);
    if (hit) return hit;
    const search = await META.httpJson("https://api.deezer.com/search/artist?limit=" + similar.SEARCH_ROWS + "&q=" + encodeURIComponent(name));
    const cands = similar.readDeezerArtists(search, name);
    let acts = [];
    for (const c of cands.slice(0, similar.CANDIDATES)) {
      const rel = await META.httpJson("https://api.deezer.com/artist/" + encodeURIComponent(c.id) + "/related?limit=25");
      acts = similar.readDeezerRelated(rel).map(a => ({ name: a.name, id: a.id }));
      if (acts.length) break;
    }
    this.ctx.db.cachePut("related", key, acts);
    return acts;
  }

  kickSmartPicks(force = false) {
    const s = this.smartSettings();
    if (!s.enabled || this.smartBuilding || !this.ctx.library.count) return;
    const day = dayKey();
    if (!force && this.readSmartPicks(day).length) return;
    this.smartBuilding = this.buildSmartPicks(day)
      .catch(e => this.ctx.log(`[smart] ${e.message}`))
      .finally(() => { this.smartBuilding = null; });
  }

  smartPicksJson() {
    const day = dayKey();
    const rows = this.readSmartPicks(day);
    if (!rows.length) this.kickSmartPicks();
    const s = this.smartSettings();
    return {
      day, enabled: s.enabled, service_ready: true, auto_add: false, hour: s.hour,
      building: !rows.length && !!this.smartBuilding,
      picks: rows.map(r => {
        const al = this.ctx.library.album(r.album_id);
        if (!al) return null;
        return {
          artist: al.artist, album: al.title,
          image: `/api/image/${encodeURIComponent(al.image_key)}?size=400`,
          reason: r.reason, offset: al.id,
          library_title: al.title, library_subtitle: al.artist, image_key: al.image_key
        };
      }).filter(Boolean)
    };
  }

  // ------------------------------------------------------------ discover

  discoverSettings() {
    return {
      enabled: this.ctx.db.setting("discoverEnabled", false),
      hour: this.ctx.db.setting("discoverHour", 5),
      window_days: 60,
      seed_count: newRel.SEED_ARTISTS
    };
  }

  readNewReleases(day) {
    return this.raw.prepare("SELECT * FROM new_releases WHERE day = ? ORDER BY rank").all(day);
  }

  async buildDiscover(day) {
    const lib = this.ctx.library;
    const rows = this.raw.prepare("SELECT artist, ts FROM plays WHERE ts >= ? AND artist != ''").all(Date.now() - 180 * DAY);
    const seeds = newRel.playedArtists(rows, { split: shareLinks.primaryArtist, limit: newRel.SEED_ARTISTS });
    if (!seeds.length) { this.ctx.log("[discover] no play history yet"); return; }
    const owned = lib.albums.map(al => ({ key: newRel.titleKey(al.title), names: [al.nArtist].concat(al.artistNames.map(n => n.n)) }));
    const now = Date.now();
    const found = [];
    const seen = new Set();
    for (const seed of seeds) {
      const want = newRel.normalize(seed.name);
      const ownedKeys = new Set(owned.filter(o => o.names.some(n => n === want || (" " + n + " ").includes(" " + want + " "))).map(o => o.key));
      try {
        const ck = "nr2:" + want;
        let albums = this.ctx.db.cacheGet("discover", ck, 7 * DAY);
        if (!albums) {
          const search = await META.httpJson("https://api.deezer.com/search/artist?limit=" + similar.SEARCH_ROWS + "&q=" + encodeURIComponent(seed.name));
          const exact = similar.readDeezerArtists(search, seed.name).filter(c => c.exact);
          albums = [];
          if (exact.length) {
            await new Promise(r => setTimeout(r, 250));
            const listing = await META.httpJson("https://api.deezer.com/artist/" + encodeURIComponent(exact[0].id) + "/albums?limit=50");
            albums = newRel.readArtistAlbums(listing);
          }
          this.ctx.db.cachePut("discover", ck, albums);
        }
        for (const r of newRel.pickNewReleases(albums, { now, sinceMs: now - 60 * DAY, ownedKeys, wanted: newRel.WANTED_PER_ARTIST })) {
          const k = r.id ? "id:" + r.id : newRel.titleKey(r.title) + "|" + want;
          if (seen.has(k)) continue;
          seen.add(k);
          found.push({ artist: seed.name, album: r.title, album_id: r.id, cover: r.cover, release_date: r.date, ts: r.ts });
        }
      } catch (e) {
        this.ctx.log(`[discover] ${seed.name}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 250));
    }
    found.sort((a, b) => b.ts - a.ts);
    const keep = found.slice(0, 12);
    const ins = this.raw.prepare("INSERT OR REPLACE INTO new_releases(day, rank, artist, album, album_id, cover, release_date, ts) VALUES(?,?,?,?,?,?,?,?)");
    this.raw.transaction(() => {
      this.raw.prepare("DELETE FROM new_releases WHERE day = ?").run(day);
      keep.forEach((r, i) => ins.run(day, i, r.artist, r.album, r.album_id ? String(r.album_id) : null, r.cover || null, r.release_date || null, r.ts || 0));
    })();
    this.ctx.db.cachePut("discover", "built:" + day, { at: Date.now() });
    this.ctx.log(`[discover] ${seeds.length} seeds → ${found.length} releases, kept ${keep.length}`);
  }

  kickDiscover(force = false) {
    const s = this.discoverSettings();
    if (!s.enabled || this.discoverBuilding || !this.ctx.library.count) return false;
    const day = dayKey();
    if (!force) {
      if (this.ctx.db.cacheGet("discover", "built:" + day, DAY)) return false;
      if (new Date().getHours() < s.hour) return false;
    }
    this.discoverBuilding = this.buildDiscover(day)
      .catch(e => this.ctx.log(`[discover] ${e.message}`))
      .finally(() => { this.discoverBuilding = null; });
    return true;
  }

  discoverJson(req) {
    const s = this.discoverSettings();
    let day = dayKey();
    let rows = this.readNewReleases(day);
    if (!rows.length) {
      const last = this.raw.prepare("SELECT day FROM new_releases ORDER BY day DESC LIMIT 1").get();
      if (last) { day = last.day; rows = this.readNewReleases(day); }
    }
    const enabled = this.ctx.shareServices();
    const locale = shareLinks.localeFromAcceptLanguage(req.headers["accept-language"]);
    return {
      enabled: s.enabled, day, window_days: 60, building: !!this.discoverBuilding,
      rules: "musicd-server:1", rules_current: true,
      releases: rows.map(r => {
        const inLib = this.ctx.library.relocate(r.album, r.artist);
        return {
          artist: r.artist, album: r.album, cover: r.cover || null,
          release_date: r.release_date || null, year: newRel.yearOf(r.release_date),
          in_library: !!inLib, offset: inLib ? inLib.id : null,
          library_title: inLib ? inLib.title : null, library_subtitle: inLib ? inLib.artist : null,
          image_key: inLib ? inLib.image_key : null,
          services: inLib ? [] : shareLinks.serviceLinks(r.artist, r.album, { locale, enabled })
        };
      })
    };
  }

  maintenance() {
    const s = this.smartSettings();
    if (s.enabled && new Date().getHours() >= s.hour) this.kickSmartPicks();
    this.kickDiscover();
    // History older than 400 days is pruned; it has done its job by then.
    try { this.raw.prepare("DELETE FROM plays WHERE ts < ?").run(Date.now() - 400 * DAY); } catch (e) { /* busy: next time */ }
  }
}

function al0(list) { return list.map(a => a.id).join(","); }

module.exports = { Features, dayKey };
