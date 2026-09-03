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
const duplicates = require("./lib/duplicates");
const { createCovers } = require("./lib/covers");
const { createLastfm } = require("./lib/lastfm");
const { createInfo } = require("./lib/info");
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

/*
 * Looking online for a cover an album does not have.
 *
 * Off entirely when COVER_LOOKUP=false, whatever the switch in the app says —
 * this is the only thing in the server that reaches the internet while it is
 * simply running, so there has to be a way to say no that a phone cannot
 * undo. Otherwise the switch in the side menu decides, and it is remembered in
 * the database like every other arrangement.
 */
const COVER_LOOKUP = process.env.COVER_LOOKUP !== "false";

/*
 * Looking up what a record IS — the write-up on the album screen and the
 * biography on an artist's.
 *
 * Its own switch rather than the covers one, because they are different
 * promises: a cover is a picture for an album that has none, and this is prose
 * from an encyclopaedia. Somebody may reasonably want one and not the other,
 * and a container that says no to this says no whatever the app asks for.
 */
const INFO_LOOKUP = process.env.INFO_LOOKUP !== "false";

const db = dbLib.open(DATA_DIR);
const settings = settingsLib.open(db);
const COVERS_KEY = "covers.enabled";
const covers = createCovers({
  db, dataDir: DATA_DIR, version: require("./package.json").version,
  /* Two separate answers: what the container allows, and what the switch in
     the side menu says. Both travel in the status — the menu row is hidden by
     the first and dimmed by the second. */
  available: COVER_LOOKUP,
  /* On unless somebody said otherwise. An album with no picture is the thing
     the feature exists for, and a switch nobody knows to look for is a feature
     nobody has. */
  enabled: settings.get(COVERS_KEY) !== "0"
});

/* Once at startup as well as after every scan. A library upgraded from a
   version that had no notion of album versions has never been grouped, and
   SCAN_ON_START can be off — so without this the feature would arrive only
   for people who happen to rescan. */
duplicates.regroup(db);
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

/*
 * Scrobbling to Last.fm.
 *
 * The key and secret are a DEVELOPER registration in the container's
 * environment, not something anybody types into the app — Last.fm has no
 * OAuth 2 and no anonymous mode, so there is no keyless way to do this at all
 * (see lib/lastfm.js). With neither set the feature reports itself unavailable
 * and nothing in the app offers it.
 */
const lastfm = createLastfm({
  db, settings,
  apiKey: process.env.LASTFM_API_KEY || "",
  apiSecret: process.env.LASTFM_API_SECRET || ""
});

/*
 * Wikipedia first, Last.fm second, and NOTHING on a timer.
 *
 * Unlike the cover sweep this never runs by itself: a write-up is fetched the
 * first time somebody opens the screen that shows it, and after that it is
 * read out of the database. A library of four thousand albums costs no
 * requests at all until somebody looks at something.
 */
const info = createInfo({
  db,
  version: require("./package.json").version,
  /* Read-only, and only as the fallback. The key is the one already read for
     scrobbling — nothing new is asked of anybody. */
  lastfm,
  available: INFO_LOOKUP,
  /* Undefined in every real install, which leaves lib/info.js on Wikipedia's
     own address. It exists so an end-to-end check can point the WHOLE path —
     this route, the module, the gate, the User-Agent and the cache — at a
     stand-in over real HTTP, rather than testing a renderer fed by hand. */
  apiRoot: process.env.MUSICD_WIKI_API || undefined
});

const playback = new Playback({
  db, household, baseUrl,
  onLibraryChange: () => picks.invalidate(),
  scrobbler: lastfm
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
    /* Grouping is derived from what the scan just wrote, so it runs on the way
       out of every scan rather than on a timer of its own — a rescan that
       finds a new deluxe edition must not leave it sitting on the home screen
       as a second album until something else happens to trigger a regroup. */
    const folded = duplicates.regroup(db);
    if (folded.collapsed) {
      console.log(`[scan] ${folded.collapsed} album(s) folded into another version`);
    }
    scanState.last = { ...stats, versions: folded.collapsed, at: Date.now() };
    picks.invalidate();
    /* Deliberately not awaited. A hundred missing covers is a hundred seconds
       of politely spaced requests, and the scan is finished — holding it open
       would leave the progress bar up and the rescan button disabled for as
       long as the lookups took. */
    sweepCovers();
  } catch (e) {
    console.error("[scan] failed: " + e.stack);
    scanState.error = e.message;
  } finally {
    scanState.running = false;
  }
  return scanState;
}

/*
 * Fill in the covers that are missing.
 *
 * The row a new cover belongs to changes the moment it arrives, so the home
 * screen is stale from then on — but only in the sense that a picture appeared
 * where a placeholder was, which is worth a repaint on the next visit and not
 * worth interrupting anyone for.
 */
function sweepCovers() {
  return covers.sweep({ onFound: () => picks.invalidate() })
    .catch(e => console.error("[covers] " + e.message));
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
    covers: covers.status(),
    info: info.status(),
    lastfm: lastfm.status(),
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

/*
 * Correcting an album's title or artist.
 *
 * The one place the library is told it is wrong. It writes to its own pair of
 * columns, which no part of the scan mentions, so a rescan cannot undo it —
 * and it never touches the files: the music folder is very often mounted
 * read-only, and it is the user's.
 *
 * NOT an identification, and nothing here goes looking. It records what the
 * person who owns the records says they are called.
 */
app.post("/api/album/name", api((req, res) => {
  const { album, title, artist } = req.body || {};
  /* Tested for BEFORE it is decoded. base64url has no invalid-input signal for
     a word like "undefined" — it decodes to bytes and comes back a non-empty
     string — so a request that names no album at all would otherwise reach the
     lookup and be reported as an album that does not exist. */
  const id = album ? decodeId(album) : null;
  if (!id) return res.status(400).json({ error: "Which album?" });
  const result = library.setNames(db, id, { title, artist });
  if (!result) return res.status(404).json({ error: "No such album." });
  /* The write-up was found by searching for the OLD name. A correction makes
     it the answer to a question nobody is asking any more, so it goes and the
     next open of the screen asks again with what the user actually typed. */
  info.forget("album", result.id);
  /* Smart Picks are matched by artist and built once a day from a cached
     answer — one holding the name that was just corrected. */
  picks.invalidate();
  res.json(result);
}));

/*
 * What Wikipedia says about this record, and about the person who made it.
 *
 * SEPARATE FROM /api/album ON PURPOSE. The album screen paints from the tags
 * the moment it opens; this is a request that may go to the internet, and
 * folding it into the screen's own call would hold the track list behind a
 * lookup. Two calls means the album is there instantly and the write-up
 * arrives underneath it, or does not.
 *
 * A 200 with a null body is the honest answer for "asked, and there is no
 * confident match" — an error would tell the client to retry something that
 * has already been settled and written down.
 */
app.get("/api/album/:id/info", api(async (req, res) => {
  const id = decodeId(req.params.id);
  if (!id) return res.status(400).json({ error: "Which album?" });
  res.json({ info: await info.album(id) });
}));

app.get("/api/artist/:name/info", api(async (req, res) => {
  /* Express has already decoded this — see the note on /api/artist below. */
  res.json({ info: await info.artist(req.params.name) });
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

/*
 * Covers found online, for albums that have none.
 *
 * A status and a switch, and no picker: the whole point is that it is not a
 * manual fetch. An album with a picture in its folder is never touched, so
 * there is nothing here to choose between.
 */
app.get("/api/covers", api((req, res) => res.json(covers.status())));

app.post("/api/covers", api((req, res) => {
  if (!COVER_LOOKUP) {
    return res.status(409).json({ error: "Cover lookup is switched off for this server." });
  }
  const body = req.body || {};
  if (body.enabled !== undefined) {
    covers.setEnabled(!!body.enabled);
    settings.set(COVERS_KEY, body.enabled ? "1" : "0");
  }
  /* Asking to look now is the same sweep the scan runs, so a switch turned
     back on does not have to wait six hours to mean anything. */
  if (body.sweep !== false && covers.status().enabled) sweepCovers();
  res.json(covers.status());
}));

app.post("/api/rescan", api(async (req, res) => {
  if (scanState.running) return res.json({ running: true, already: true });
  runScan("requested");                      // deliberately not awaited
  res.json({ running: true });
}));

/* ------------------------------------------------------------------ */
/*  Last.fm                                                            */
/* ------------------------------------------------------------------ */

/*
 * Connecting an account, in the two steps Last.fm's flow has.
 *
 * The password is never seen here: /start asks Last.fm for a token and hands
 * back the approval page on last.fm's own domain, and /finish exchanges the
 * approved token for a session key. That key is not a password and cannot be
 * used to read anything about the account.
 */
app.get("/api/lastfm", api((req, res) => res.json(lastfm.status())));

app.post("/api/lastfm/start", api(async (req, res) => res.json(await lastfm.start())));

app.post("/api/lastfm/finish", api(async (req, res) => {
  const result = await lastfm.finish((req.body || {}).token);
  /* Anything that was listened to before the account was connected is still
     in the queue and is still a listen. */
  lastfm.flush().catch(e => console.error("[lastfm] " + e.message));
  res.json({ ...result, ...lastfm.status() });
}));

app.post("/api/lastfm/disconnect", api((req, res) => {
  lastfm.disconnect();
  res.json(lastfm.status());
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
  const row = id && db.prepare("SELECT art, art_fetched FROM albums WHERE id = ?").get(id);
  /* The folder's own cover first, always. A picture sitting next to the files
     is what the owner chose; a fetched one is what this app could find when
     there was nothing to choose. */
  const file = row && (row.art || row.art_fetched);
  if (!file) return res.status(404).end();
  const ext = path.extname(file).toLowerCase();
  res.setHeader("Content-Type", ART_MIME[ext] || "image/jpeg");
  /* Cover art for a given album id never changes without a rescan, and the
     rescan rewrites the file in place — a day is a fair trade for a grid that
     does not refetch a hundred images on every visit. */
  res.setHeader("Cache-Control", "public, max-age=86400");
  fs.createReadStream(file)
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
    /* A scan sweeps for covers on its way out. Without one there is nothing to
       start it, and a container told not to scan on boot would never look for
       a missing cover again — the delay is only so the first request after a
       restart is not queued behind a lookup. */
    else setTimeout(sweepCovers, 5000).unref();
    /* Anything that could not be sent when it happened — the router was down,
       Last.fm was having a moment — goes out on its own quarter hour rather
       than waiting for the next track to finish. The queue is in the database,
       so this also picks up whatever a restart interrupted. */
    if (lastfm.status().configured) {
      const drain = () => lastfm.flush().catch(e => console.error("[lastfm] " + e.message));
      setTimeout(drain, 10000).unref();
      setInterval(drain, 15 * 60 * 1000).unref();
    }

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
