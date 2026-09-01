/*
 * MusicD Server — a simple music server for Sonos.
 *
 * Points at your music folders, shows the albums as they are on disk, and
 * plays them to your Sonos rooms. No metadata service, no album identification,
 * no streaming accounts: the library is your files and the tags you gave them.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const compression = require("compression");

const dbLib = require("./lib/db");
const scanner = require("./lib/scanner");
const library = require("./lib/library");
const picksLib = require("./lib/picks");
const { Household, localAddress } = require("./lib/sonos");
const { Playback } = require("./lib/playback");
const { decodeId } = require("./lib/ids");
const { createUpdater } = require("./lib/updater");
const settingsLib = require("./lib/settings");

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

function list(value) {
  return String(value || "").split(/[,:;]/).map(s => s.trim()).filter(Boolean);
}

const PORT = Number(process.env.PORT || 3400);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MUSIC_DIRS = list(process.env.MUSIC_DIRS || "/music");
const ART_DIR = path.join(DATA_DIR, "cache", "art");
const SCAN_ON_START = process.env.SCAN_ON_START !== "false";
const SCAN_INTERVAL_HOURS = Number(process.env.SCAN_INTERVAL_HOURS || 6);
const PUBLIC_DIR = process.env.MUSICD_PUBLIC_DIR || path.join(__dirname, "public");

fs.mkdirSync(ART_DIR, { recursive: true });

const db = dbLib.open(DATA_DIR);
const settings = settingsLib.open(db);
const picks = picksLib.createCache(db);

const household = new Household({
  hosts: list(process.env.SONOS_HOSTS),
  include: list(process.env.INCLUDE_ZONES),
  exclude: list(process.env.EXCLUDE_ZONES)
});

/* The origin a speaker uses to fetch audio from this server. It is resolved
   once at startup and cached: a Sonos player on the LAN cannot reach
   "localhost", and a request's own Host header is the browser's route here,
   not the speaker's. */
let advertisedOrigin = "";
function baseUrl() {
  if (!advertisedOrigin) {
    advertisedOrigin = `http://${localAddress(process.env.SERVER_IP)}:${PORT}`;
  }
  return advertisedOrigin;
}

const playback = new Playback({
  db, household, baseUrl,
  onLibraryChange: () => picks.invalidate()
});

/* ------------------------------------------------------------------ */
/*  Scanning                                                           */
/* ------------------------------------------------------------------ */

let scanState = { running: false, done: 0, total: 0, dir: "", startedAt: 0, last: null, error: "" };

async function runScan(reason = "manual") {
  if (scanState.running) return scanState;
  scanState = { running: true, done: 0, total: 0, dir: "", startedAt: Date.now(), last: scanState.last, error: "" };
  console.log(`[scan] starting (${reason}) — ${MUSIC_DIRS.join(", ")}`);
  try {
    const stats = await scanner.scan(db, MUSIC_DIRS, {
      artDir: ART_DIR,
      onProgress: p => { scanState.done = p.done; scanState.total = p.total; scanState.dir = p.dir; }
    });
    scanState.last = { ...stats, at: Date.now() };
    picks.invalidate();
  } catch (e) {
    console.error("[scan] failed: " + e.stack);
    scanState.error = e.message;
  } finally {
    scanState.running = false;
  }
  return scanState;
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

const app = express();
app.disable("x-powered-by");
app.use(compression());
app.use(express.json({ limit: "256kb" }));

/* Every API handler is async and every one of them can be told "that room
   just went off the network". Wrapping them keeps that a 4xx/5xx with a
   readable message instead of an unhandled rejection that kills the process. */
function api(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch(e => {
      console.error("[api] " + req.method + " " + req.path + " — " + e.message);
      if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
    });
  };
}

/* ------------------------------------------------------------------ */
/*  Library                                                            */
/* ------------------------------------------------------------------ */

/*
 * Which build this is.
 *
 * The version comes from package.json; the commit and date are baked into the
 * image by the publish workflow. A container that cannot say what it is makes
 * "I updated and nothing changed" impossible to tell apart from "the update
 * did not reach me", which is exactly the case this exists for.
 */
const BUILD = {
  version: require("./package.json").version,
  commit: (process.env.BUILD_COMMIT || "").slice(0, 7),
  date: process.env.BUILD_DATE || "",
  ref: process.env.BUILD_REF || ""
};

app.get("/api/status", api((req, res) => {
  /* Deliberately NOT awaited. Discovery against a network with no players
     takes seconds, and this endpoint is what the container's health check and
     the client's 30-second poll both hit — blocking on it reported the whole
     server unhealthy whenever Sonos was unreachable, while the web app was
     working perfectly. Kick the refresh off, answer from what is known. */
  household.refresh({ maxAgeMs: 15000 }).catch(() => {
    /* The reason is already kept on household.lastError and reported below. */
  });
  res.json({
    version: BUILD.version,
    build: BUILD,
    musicDirs: MUSIC_DIRS,
    stats: library.stats(db),
    scan: {
      running: scanState.running, done: scanState.done, total: scanState.total,
      last: scanState.last, error: scanState.error
    },
    sonos: {
      rooms: household.rooms().length,
      error: household.lastError,
      origin: baseUrl()
    },
    time: { now: Date.now(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  });
}));

/* ------------------------------------------------------------------ */
/*  Updating                                                           */
/* ------------------------------------------------------------------ */

/*
 * The app can install its own updates.
 *
 * The passive check stays in the BROWSER, where it has always been: nothing
 * here reaches the internet while the server is simply running. These three
 * endpoints only do anything when somebody asks, and the apply one re-reads
 * the release from GitHub itself rather than trusting anything the request
 * carried — see lib/updater.js, which is where the reasoning lives.
 */
const updater = createUpdater({ dir: __dirname, version: BUILD.version });

app.get("/api/update", api((req, res) => res.json(updater.status())));

app.post("/api/update/check", api(async (req, res) => res.json(await updater.check())));

app.post("/api/update/apply", api((req, res) => {
  if (updater.busy()) return res.json(updater.status());
  /* Started, then answered — apply() marks itself busy before its first await,
     so the reply already says what is happening. It is NOT awaited: an update
     takes tens of seconds and ends by killing this process, so a request held
     open until it finished would be cut off mid-flight every time and the
     browser could not tell that from a failure. It polls /api/update instead. */
  const started = updater.apply();
  res.json(updater.status());
  started.catch(e => console.error("[update] " + e.message));
}));

/*
 * The whole home screen in one request.
 *
 * Five rows plus Smart Picks, in the order they appear. One round trip rather
 * than six is what makes the screen paint at once on a phone.
 */
/* Row sizes. Math.min alone lets a negative through, and SQLite reads a
   negative LIMIT as no limit at all — so ?limit=-1 was a way to ask the server
   to serialise the entire library, six times over in the case of /api/home. */
function bounded(value, fallback, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/* Favourites sit above everything else when there are any, and are ABSENT
   rather than empty when there are none — a row headed "Favourites" over the
   words "nothing here yet" is an instruction to go and use a feature, which is
   not what a home screen is for. Every other row describes the library and is
   worth a place even while empty. */
/*
 * What each row is called and how it is filled. One table, so the home screen,
 * the full-grid screen and the side menu cannot disagree about what a row is —
 * and so the order they appear in is a list of keys rather than a shape
 * repeated in three places.
 */
const ROW_DEFS = {
  favourites: { title: "Favourites",
                albums: (n, o) => library.favourites(db, n, o) },
  library:    { title: "Library",
                albums: (n, o) => library.library(db, n, o) },
  random:     { title: "Random albums",
                albums: (n)    => library.random(db, n) },
  added:      { title: "Recently added",
                albums: (n, o) => library.recentlyAdded(db, n, o) },
  played:     { title: "Recently played",
                albums: (n, o) => library.recentlyPlayed(db, n, o) },
  unplayed:   { title: "Not played in 6 months",
                albums: (n, o) => library.notPlayedIn6Months(db, n, o),
                empty: "Nothing yet — this row fills once albums have gone six months unplayed." },
  picks:      { title: "Smart Picks",
                albums: ()     => picks.get().picks,
                empty: () => picks.get().note }
};

/* Favourites is the one row that is ABSENT rather than empty when it has
   nothing in it — a heading over "nothing here yet" is an instruction to go
   and use a feature, which is not what a home screen is for. Every other row
   describes the library and is worth a place even while empty. */
function homeRows(n) {
  return settingsLib.rowOrder(settings).map((key) => {
    const def = ROW_DEFS[key];
    const albums = def.albums(n, 0);
    if (key === "favourites" && !albums.length) return null;
    const empty = typeof def.empty === "function" ? def.empty() : def.empty;
    return { key, title: def.title, albums, ...(empty ? { empty } : {}) };
  }).filter(Boolean);
}

app.get("/api/home", api((req, res) => {
  const n = bounded(req.query.limit, 24, 60);
  res.json({ rows: homeRows(n), stats: library.stats(db) });
}));

/*
 * The order of the home screen's rows, arranged from the side menu.
 *
 * Read and written whole rather than as moves: a phone that has been asleep
 * sends the arrangement it can see, and the last one to finish dragging wins.
 * Anything unrecognised is dropped and anything missing is put back — see
 * lib/settings.js — so a bad list cannot leave somebody with a home screen
 * missing a row.
 */
app.get("/api/rows", api((req, res) => res.json({
  order: settingsLib.rowOrder(settings),
  titles: Object.fromEntries(Object.entries(ROW_DEFS).map(([k, d]) => [k, d.title]))
})));

app.post("/api/rows", api((req, res) => {
  const order = settingsLib.setRowOrder(settings, (req.body || {}).order);
  res.json({ order });
}));

const ROWS = Object.fromEntries(
  Object.entries(ROW_DEFS).map(([key, def]) => [key, def.albums]));

app.get("/api/albums", api((req, res) => {
  const row = String(req.query.row || "library");
  const fn = ROWS[row];
  if (!fn) return res.status(400).json({ error: "Unknown row: " + row });
  const limit = bounded(req.query.limit, 200, 500);
  const offset = Math.max(0, Math.trunc(Number(req.query.offset)) || 0);
  res.json({ row, albums: fn(limit, offset) });
}));

app.get("/api/album/:id", api((req, res) => {
  const id = decodeId(req.params.id);
  const album = id ? library.album(db, id) : null;
  if (!album) return res.status(404).json({ error: "No such album." });
  res.json(album);
}));

app.get("/api/search", api((req, res) => res.json(library.search(db, req.query.q))));
app.get("/api/artists", api((req, res) => res.json({ artists: library.artists(db) })));
/*
 * Marking an album a favourite.
 *
 * The only thing in the library the user types rather than the files, so it is
 * the only thing a rescan could destroy and does not — nothing in the scan's
 * upserts mentions the column, the same way added_at is left alone.
 */
app.post("/api/favourite", api((req, res) => {
  const { album, favourite } = req.body || {};
  const id = decodeId(album);
  if (!id) return res.status(400).json({ error: "Which album?" });
  const result = library.setFavourite(db, id, !!favourite);
  if (!result) return res.status(404).json({ error: "No such album." });
  res.json({ ...result, count: library.favouriteCount(db) });
}));

app.get("/api/artist/:name", api((req, res) => {
  /* Express has already decoded the route parameter. Decoding it a second time
     turns an artist with a percent sign in their name — "50% Off", or a folder
     name that literally contains "%20" — into a URIError and a 500, which put
     that artist's page permanently out of reach. */
  const name = req.params.name;
  res.json({ artist: name, ...library.byArtist(db, name) });
}));
app.get("/api/picks", api((req, res) => res.json(picks.get())));

app.post("/api/rescan", api(async (req, res) => {
  if (scanState.running) return res.json({ running: true, already: true });
  runScan("requested");                      // deliberately not awaited
  res.json({ running: true });
}));

/* ------------------------------------------------------------------ */
/*  Sonos                                                              */
/* ------------------------------------------------------------------ */

app.get("/api/zones", api(async (req, res) => {
  await household.refresh({ force: req.query.refresh === "1" });
  const rooms = household.rooms().map(z => {
    const members = household.membersOf(z.uuid);
    return {
      uuid: z.uuid, name: z.name,
      coordinator: z.coordinator,
      isCoordinator: z.coordinator === z.uuid,
      grouped: members.length > 1,
      members: members.map(m => m.name)
    };
  });
  res.json({ rooms, error: household.lastError });
}));

app.get("/api/now", api(async (req, res) => {
  const zone = String(req.query.zone || "");
  if (!zone) return res.status(400).json({ error: "No room given." });
  res.json(await playback.nowPlaying(zone) || { error: "That room is not on the network right now." });
}));

app.get("/api/queue", api(async (req, res) => {
  const zone = String(req.query.zone || "");
  if (!zone) return res.status(400).json({ error: "No room given." });
  res.json(await playback.queue(zone));
}));

app.post("/api/play", api(async (req, res) => {
  const { zone, albumId, trackIds, startIndex = 0, mode = "play" } = req.body || {};
  if (!zone) return res.status(400).json({ error: "Choose a room first." });

  let result;
  if (Array.isArray(trackIds) && trackIds.length) {
    result = await playback.playTracks(zone, trackIds, { replace: mode !== "queue" });
  } else if (albumId) {
    result = mode === "queue"
      ? await playback.queueAlbum(zone, albumId)
      : await playback.playAlbum(zone, albumId, Number(startIndex) || 0);
  } else {
    return res.status(400).json({ error: "Nothing to play." });
  }
  res.json(result);
}));

app.post("/api/transport", api(async (req, res) => {
  const { zone, action, value } = req.body || {};
  if (!zone || !action) return res.status(400).json({ error: "A room and an action are required." });
  await playback.command(zone, action, value);
  res.json({ ok: true });
}));

app.post("/api/volume", api(async (req, res) => {
  const { zone, level, mute } = req.body || {};
  if (!zone) return res.status(400).json({ error: "No room given." });
  if (mute !== undefined) return res.json(await playback.mute(zone, !!mute));
  res.json(await playback.volume(zone, level === undefined ? undefined : Number(level)));
}));

app.post("/api/group", api(async (req, res) => {
  const { zone, action, coordinator } = req.body || {};
  await household.refresh({ force: true });
  const player = household.get(zone);
  if (!player) return res.status(404).json({ error: "That room is not on the network right now." });
  if (action === "leave") await player.becomeStandalone();
  else if (action === "join" && coordinator) await player.joinGroup(coordinator);
  else return res.status(400).json({ error: "Unknown grouping action." });
  await household.refresh({ force: true });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/*  Media                                                              */
/* ------------------------------------------------------------------ */

/*
 * Audio, streamed to whoever asks — which in normal use is a speaker, not a
 * browser. Range support is not optional here: Sonos opens a ranged request
 * for every track, and a server that answers 200 with the whole file makes
 * seeking impossible and gapless playback unreliable.
 */
app.get("/stream/:token", (req, res) => {
  const id = decodeId(String(req.params.token).replace(/\.[a-z0-9]+$/i, ""));
  const track = id && db.prepare("SELECT * FROM tracks WHERE id = ?").get(id);
  if (!track) return res.status(404).end();

  let stat;
  try { stat = fs.statSync(track.path); }
  catch { return res.status(410).end(); }     // the file moved since the scan

  res.setHeader("Content-Type", track.mime || "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-cache");

  const range = req.headers.range;
  if (!range) {
    res.setHeader("Content-Length", stat.size);
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(track.path).on("error", () => res.destroy()).pipe(res);
  }

  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) {
    res.setHeader("Content-Range", `bytes */${stat.size}`);
    return res.status(416).end();
  }
  let start = m[1] === "" ? null : Number(m[1]);
  let end = m[2] === "" ? null : Number(m[2]);
  if (start === null) {                        // a suffix range: the last N bytes
    start = Math.max(0, stat.size - (end || 0));
    end = stat.size - 1;
  }
  if (end === null || end >= stat.size) end = stat.size - 1;
  if (start > end || start >= stat.size) {
    res.setHeader("Content-Range", `bytes */${stat.size}`);
    return res.status(416).end();
  }

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  res.setHeader("Content-Length", end - start + 1);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(track.path, { start, end }).on("error", () => res.destroy()).pipe(res);
});

const ART_MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

app.get("/art/:token", (req, res) => {
  const id = decodeId(req.params.token);
  const row = id && db.prepare("SELECT art FROM albums WHERE id = ?").get(id);
  if (!row || !row.art) return res.status(404).end();
  const ext = path.extname(row.art).toLowerCase();
  res.setHeader("Content-Type", ART_MIME[ext] || "image/jpeg");
  /* Cover art for a given album id never changes without a rescan, and the
     rescan rewrites the file in place — a day is a fair trade for a grid that
     does not refetch a hundred images on every visit. */
  res.setHeader("Cache-Control", "public, max-age=86400");
  fs.createReadStream(row.art)
    .on("error", () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); })
    .pipe(res);
});

/*
 * The app shell is never cached without revalidating.
 *
 * This used to be a flat `maxAge: "1h"`, which meant that for an hour after an
 * update the browser kept serving the OLD index.html, app.js and style.css
 * without ever asking the server — so a container that had genuinely been
 * updated showed the previous interface, and the only symptom was "I updated
 * and nothing changed". On a home-screen shortcut it is worse, because the
 * shortcut holds its own cache.
 *
 * `no-cache` does not mean "do not store": it means "ask before reusing".
 * express.static still sends an ETag, so an unchanged file costs a 304 with no
 * body — nothing on a LAN, and correctness in exchange.
 *
 * Icons keep a long life. They are the one thing here that does not change
 * between versions, and they are fetched on every cold start.
 */
const SHELL = /\.(html|js|css)$/i;

/*
 * index.html is built here rather than served as a static file, so that it can
 * carry the version in two places.
 *
 * The asset URLs get ?v=<version>, which makes app.js and style.css a
 * different URL on every release — a browser holding an old copy of either
 * cannot serve it against the new address, whatever its cache headers said at
 * the time it was stored.
 *
 * A <meta> records which version this document IS. The client compares it with
 * what /api/status reports and says so when they disagree, because that is the
 * one state nothing else can detect: a shell cached before the caching rules
 * were fixed will not revalidate until its old max-age runs out, and until
 * then a correctly updated server serves an interface from a previous release
 * with nothing to indicate it.
 */
function renderShell() {
  /* Read every time rather than memoised. The file cannot change under a
     running container in normal use, but holding it in memory means that when
     it DOES — a bind mount, a developer editing it — the server keeps serving
     the old page with nothing to explain why, and this project has spent
     enough rounds on exactly that shape of problem. A 15KB read from the OS
     page cache is not worth the trap. */
  const version = encodeURIComponent(BUILD.version);
  return fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8")
    .replace(/(src|href)="\/(app|sharecard)\.js"/g, `$1="/$2.js?v=${version}"`)
    .replace(/href="\/style\.css"/g, `href="/style.css?v=${version}"`)
    .replace("<head>", `<head>\n  <meta name="musicd-build" content="${BUILD.version}">`);
}

function sendShell(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(renderShell());
}

app.get("/", sendShell);

/*
 * The service worker, with the version written into it.
 *
 * A browser only looks for a NEW worker when the bytes of this file change, so
 * the version is what makes an update visible to it at all. It must never be
 * cached, or the check that finds updates is itself answered from a stale copy.
 */
app.get("/sw.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  /* Scope is the whole site; the header is required to allow that from any
     path, and costs nothing when the file already sits at the root. */
  res.setHeader("Service-Worker-Allowed", "/");
  res.send(fs.readFileSync(path.join(PUBLIC_DIR, "sw.js"), "utf8")
             .replace("__BUILD_VERSION__", BUILD.version));
});

app.use(express.static(PUBLIC_DIR, {
  /* index:false — "/" is the rendered shell above, not the file on disk. */
  index: false,
  etag: true,
  setHeaders(res, filePath) {
    res.setHeader("Cache-Control", SHELL.test(filePath) ? "no-cache" : "public, max-age=604800");
  }
}));

/* An unknown /api path is a mistake in a caller, and answering it with the web
   app means the caller gets HTML, a 200, and a JSON parse error somewhere far
   from the cause. Everything else falls through to the app, which is what makes
   a deep link work. */
app.use("/api", (req, res) => res.status(404).json({ error: "No such endpoint: " + req.path }));
/* The deep-link fallback is the same document, built the same way. */
app.get("*", sendShell);

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

function start() {
  const server = app.listen(PORT, () => {
    console.log(`MusicD Server v${BUILD.version}` +
                (BUILD.commit ? ` (${BUILD.commit}${BUILD.date ? ", built " + BUILD.date : ""})` : ""));
    console.log(`  library : ${MUSIC_DIRS.join(", ")}`);
    console.log(`  data    : ${DATA_DIR}`);
    console.log(`  web     : http://${localAddress(process.env.SERVER_IP)}:${PORT}/`);
    console.log(`  time    : ${new Date().toString()}`);

    household.refresh({ force: true })
      .then(() => {
        const rooms = household.rooms();
        console.log(rooms.length
          ? `  sonos   : ${rooms.map(r => r.name).join(", ")}`
          : `  sonos   : no players found — ${household.lastError}`);
      })
      .catch(e => console.error("  sonos   : discovery failed — " + e.message));

    if (SCAN_ON_START) runScan("startup");
    if (SCAN_INTERVAL_HOURS > 0) {
      setInterval(() => runScan("scheduled"), SCAN_INTERVAL_HOURS * 3600 * 1000).unref();
    }
    playback.start();
  });

  function shutdown(signal) {
    console.log(`\n${signal} — shutting down.`);
    playback.stop();
    server.close(() => { try { db.close(); } catch { /* already closed */ } process.exit(0); });
    /* A speaker holding a stream open would otherwise keep the process alive
       past the point where the supervisor stops waiting politely. */
    setTimeout(() => process.exit(0), 4000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return server;
}

/* Started only when this file IS the program. Required as a module — which is
   how the API tests drive it — it hands back the app without binding a port,
   starting a scan, or beginning to poll speakers. */
if (require.main === module) start();

module.exports = { app, db, start, runScan, playback, household, baseUrl };
