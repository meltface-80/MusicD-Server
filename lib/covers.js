/*
 * MusicD Server — finding a cover for an album that has none.
 *
 * The library is still the files. This does not identify albums, it does not
 * rewrite a tag, and it never touches the music mount: an album whose folder
 * holds no cover and whose files carry no embedded picture gets ONE image
 * downloaded into this app's own data directory, and the row remembers where
 * it came from. Everything else about the album is what the tags said.
 *
 * NO KEYS, AND NOTHING THAT NEEDS AN ACCOUNT. Two open services do the whole
 * job:
 *
 *   MusicBrainz      — an open music database. No key. Its terms ask for at
 *                      most one request a second and a User-Agent that says
 *                      who is calling, both of which are honoured below and
 *                      neither of which is optional.
 *   Cover Art Archive — the cover images for those releases, run with the
 *                      Internet Archive. No key, and the "front" endpoints
 *                      redirect straight to the image.
 *
 * HOW LITTLE IT ASKS. One search per album, and a second one only when the
 * first found nothing. A miss is remembered for a week so a library with two
 * hundred coverless bootlegs does not re-ask about them every six hours. A hit
 * is remembered forever, because the file is on disk.
 *
 * WHAT IT MATCHES ON. The album title and the artist first — the strongest
 * thing the tags give. When that finds nothing, the TRACK NAMES: two of them,
 * searched as recordings by the same artist, and the release group both agree
 * on is the record. That second path is what rescues an album whose folder is
 * named right and whose album tag is blank or wrong.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { normalise, artistKey, splitEdition } = require("./match");
const { albumNames } = require("./db");

/* The name the LIBRARY shows — see lib/db.js. An album whose artist tag is
   missing is exactly the album a user corrects by hand, and asking the Cover
   Art Archive about the blank the files carry rather than the name they typed
   would waste the one request this app is allowed to make for it. */
const NAME = albumNames("a");

const MB_ROOT = "https://musicbrainz.org/ws/2";
const CAA_ROOT = "https://coverartarchive.org";

/* MusicBrainz asks for one request per second per application. This is the one
   gate every caller queues on: comparing timestamps let two callers awaiting
   at the same moment both read the same "last" value and both go, which is
   exactly the rate limit being broken by the code meant to honour it. */
const MB_GAP_MS = 1100;

const REQUEST_TIMEOUT_MS = 20000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/* A lookup that found nothing is retried after a week. Long enough that a
   coverless library costs a handful of requests rather than hundreds; short
   enough that an album MusicBrainz gained last month is found this month. */
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/* Being told to slow down is the one answer that must change behaviour rather
   than just be logged. A 503 from MusicBrainz means the whole sweep waits. */
const BACKOFF_MS = 60000;

const IMAGE_EXT = {
  "image/jpeg": ".jpg", "image/png": ".png",
  "image/webp": ".webp", "image/gif": ".gif"
};

/*
 * Who is calling.
 *
 * MusicBrainz blocks a client that does not identify itself, and the string
 * has to carry an application, a version and a way to get in touch. The
 * project's own URL is the contact — this is a program people run at home, and
 * putting an installation's own address in here would be publishing it.
 */
function userAgent(version) {
  return `MusicD-Server/${version || "0"} ( https://github.com/meltface-80/MusicD-Server )`;
}

/* Lucene escaping. An album called "Where Are We Now?" is a syntax error
   otherwise, and one called "AC/DC Live" is a field query for nothing. */
function quote(s) {
  return String(s || "").replace(/([+\-!(){}[\]^"~*?:\\/])/g, "\\$1");
}

/*
 * `available` and `enabled` are two different answers and both have to travel.
 *
 * `available` is the CONTAINER's answer — COVER_LOOKUP — and nothing a phone
 * does can change it. `enabled` is the switch in the side menu. The client
 * hides the row entirely on the first and dims it on the second, so a status
 * that reports only one of them leaves the row hidden for ever: which is
 * exactly what shipped in 0.4.9, because `available` was added to the
 * /api/covers replies and not to the status object the menu actually reads.
 */
function createCovers({ db, dataDir, version, available = true, enabled = true,
                        fetchImpl = null, gapMs = MB_GAP_MS }) {
  const dir = path.join(dataDir, "cache", "art", "fetched");
  const http = fetchImpl || ((...args) => fetch(...args));
  const UA = userAgent(version);

  const state = {
    available: !!available,
    enabled: !!available && !!enabled,
    running: false,
    done: 0, total: 0, found: 0,
    startedAt: 0, finishedAt: 0,
    last: "", error: ""
  };

  /* ---------------------------------------------------------------- */
  /*  The rate gate                                                    */
  /* ---------------------------------------------------------------- */

  let chain = Promise.resolve();
  let lastCall = 0;
  let holdUntil = 0;

  function wait() {
    const mine = chain.then(async () => {
      const until = Math.max(lastCall + gapMs, holdUntil);
      const gap = until - Date.now();
      if (gap > 0) await new Promise(r => setTimeout(r, gap));
      lastCall = Date.now();
    });
    /* One caller's rejection must not poison the queue for everyone behind
       it — the chain is a turn-taking order, not a dependency. */
    chain = mine.catch(() => {});
    return mine;
  }

  async function get(url, headers) {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await http(url, {
        headers: { "User-Agent": UA, ...headers },
        redirect: "follow",
        signal: control.signal
      });
    } finally { clearTimeout(timer); }
  }

  async function askMusicBrainz(url) {
    await wait();
    const res = await get(url, { Accept: "application/json" });
    if (res.status === 503 || res.status === 429) {
      /* Told to slow down. The whole gate waits, not just this call — asking
         again immediately is what turns a throttle into a block. */
      holdUntil = Date.now() + BACKOFF_MS;
      throw new Error("MusicBrainz asked for a slower pace");
    }
    if (!res.ok) throw new Error("MusicBrainz answered " + res.status);
    return res.json();
  }

  /* ---------------------------------------------------------------- */
  /*  Deciding a hit is really this album                              */
  /* ---------------------------------------------------------------- */

  /* Stylisation-folded, and containment counts: MusicBrainz credits
     "Slowdive feat. Someone" where the tags say "Slowdive". */
  function artistAgrees(credit, artist) {
    const theirs = artistKey(credit), ours = artistKey(artist);
    if (!theirs || !ours) return false;
    return theirs === ours || theirs.includes(ours) || ours.includes(theirs);
  }

  function creditOf(entity) {
    return (entity["artist-credit"] || [])
      .map(c => (c && (c.name || (c.artist && c.artist.name))) || "").join(" ");
  }

  /*
   * The album title and the artist. The strongest thing the tags give, and
   * one request.
   *
   * Matched on the title with its edition marker taken off, because that is
   * how the library itself groups versions — the deluxe edition of a record
   * and the record are one release group at MusicBrainz too.
   */
  async function byTitle(title, artist) {
    const base = splitEdition(title).base;
    const query = `releasegroup:"${quote(base)}" AND artist:"${quote(artist)}"`;
    const body = await askMusicBrainz(
      `${MB_ROOT}/release-group/?query=${encodeURIComponent(query)}&fmt=json&limit=5`);
    const want = normalise(base);
    for (const group of body["release-groups"] || []) {
      if (!group || !group.id) continue;
      if (Number(group.score) < 85) continue;
      if (normalise(group.title || "") !== want) continue;
      if (!artistAgrees(creditOf(group), artist)) continue;
      return { kind: "release-group", id: group.id, why: "album name" };
    }
    return null;
  }

  /*
   * The track names, when the album name found nothing.
   *
   * Two tracks searched as recordings by the same artist; the release group
   * they BOTH point at is the record. One track can be on a dozen
   * compilations, so a single hit proves nothing — the agreement is the whole
   * of the evidence, which is why this needs two requests and not one.
   */
  async function byTracks(tracks, artist) {
    const chosen = tracks.filter(t => normalise(t).length >= 3).slice(0, 2);
    if (chosen.length < 2) return null;

    const seen = [];
    for (const track of chosen) {
      const query = `recording:"${quote(track)}" AND artist:"${quote(artist)}"`;
      const body = await askMusicBrainz(
        `${MB_ROOT}/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=10`);
      const groups = new Set();
      for (const rec of body.recordings || []) {
        if (!rec || Number(rec.score) < 85) continue;
        if (!artistAgrees(creditOf(rec), artist)) continue;
        for (const release of rec.releases || []) {
          const group = release && release["release-group"];
          if (group && group.id) groups.add(group.id);
        }
      }
      seen.push(groups);
    }

    for (const id of seen[0]) {
      if (seen.every(set => set.has(id))) {
        return { kind: "release-group", id, why: "track names" };
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /*  The image                                                        */
  /* ---------------------------------------------------------------- */

  /* The "front" endpoints redirect to the image itself, or answer 404 when the
     release has no art — so the URL is the answer and the 404 is the "no". */
  function coverUrl(hit, size) {
    return `${CAA_ROOT}/${hit.kind}/${encodeURIComponent(hit.id)}/front${size}`;
  }

  async function download(url) {
    const res = await get(url, { Accept: "image/*" });
    if (!res.ok) throw new Error("Cover Art Archive answered " + res.status);
    const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) throw new Error("that was not an image: " + (type || "unknown"));
    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length) throw new Error("the image was empty");
    if (body.length > MAX_IMAGE_BYTES) throw new Error("the image is larger than any cover needs to be");
    return { body, type };
  }

  /* 1200px first because the album screen shows a cover at up to 280 CSS
     pixels on a 3x display; 500 is the fallback for a release whose only
     upload is small, and the bare endpoint for one with no thumbnails at all. */
  const SIZES = ["-1200", "-500", ""];

  async function fetchCover(hit) {
    let last = null;
    for (const size of SIZES) {
      try { return await download(coverUrl(hit, size)); }
      catch (e) {
        last = e;
        /* A 404 means this release has no art at any size, so trying the other
           two sizes is three requests for one answer. Anything else might be
           this size alone. */
        if (/answered 404/.test(e.message)) break;
      }
    }
    throw last || new Error("no image");
  }

  /* ---------------------------------------------------------------- */
  /*  Storing it                                                       */
  /* ---------------------------------------------------------------- */

  /* Named for the album id, so a re-fetch replaces the file rather than
     leaving the old one behind, and so nothing has to be cleaned up when an
     album goes away. */
  function fileFor(albumId, type) {
    const name = crypto.createHash("sha1").update(albumId).digest("hex");
    return path.join(dir, name + (IMAGE_EXT[type] || ".jpg"));
  }

  function store(albumId, image, hit) {
    fs.mkdirSync(dir, { recursive: true });
    const file = fileFor(albumId, image.type);
    /* A cover fetched before as a PNG and now as a JPEG would otherwise leave
       the old file in the cache forever, referenced by nothing. */
    const stem = crypto.createHash("sha1").update(albumId).digest("hex");
    for (const ext of new Set(Object.values(IMAGE_EXT))) {
      const old = path.join(dir, stem + ext);
      if (old !== file) { try { fs.unlinkSync(old); } catch { /* it was never there */ } }
    }
    fs.writeFileSync(file, image.body);
    db.prepare("UPDATE albums SET art_fetched = ? WHERE id = ?").run(file, albumId);
    remember(albumId, 1, `${hit.kind}:${hit.id}`, hit.why);
    return file;
  }

  function remember(albumId, ok, source, note) {
    db.prepare(`INSERT INTO cover_lookups (album_id, tried_at, ok, source, note)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(album_id) DO UPDATE SET
                  tried_at = excluded.tried_at, ok = excluded.ok,
                  source = excluded.source, note = excluded.note`)
      .run(albumId, Date.now(), ok, source || "", String(note || "").slice(0, 200));
  }

  /* ---------------------------------------------------------------- */
  /*  One album                                                        */
  /* ---------------------------------------------------------------- */

  /*
   * Look for one album's cover. Returns the file it stored, or null.
   *
   * Throws only on being told to slow down, which the sweep has to hear —
   * everything else is "not found for this album" and is recorded as a miss so
   * the next sweep skips it for a week.
   */
  async function findFor(album) {
    const title = String(album.title || "").trim();
    const artist = String(album.artist || "").trim();
    /* An album with no artist is a folder of files that agreed about nothing.
       There is no query to make that would not match half a catalogue. */
    if (!title || !artist || artist === "Various Artists") {
      remember(album.id, 0, "", "nothing specific enough to search on");
      return null;
    }

    const tracks = db.prepare(
      `SELECT title FROM tracks WHERE album_id = ? AND present = 1
       ORDER BY disc, no, rel LIMIT 4`).all(album.id).map(t => t.title);

    let hit = null;
    hit = await byTitle(title, artist);
    if (!hit) hit = await byTracks(tracks, artist);
    if (!hit) { remember(album.id, 0, "", "no release matched"); return null; }

    try {
      return store(album.id, await fetchCover(hit), hit);
    } catch (e) {
      remember(album.id, 0, `${hit.kind}:${hit.id}`, e.message);
      return null;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  The sweep                                                        */
  /* ---------------------------------------------------------------- */

  /* Every album with no cover of its own that has not been looked for
     recently. A version behind a tab counts: its own tab shows its own cover,
     and an empty tile there looks as broken as one on the home screen. */
  function pending() {
    return db.prepare(
      `SELECT a.id, ${NAME.title} AS title, ${NAME.artist} AS artist FROM albums a
       LEFT JOIN cover_lookups c ON c.album_id = a.id
       WHERE a.present = 1 AND a.art = '' AND a.art_fetched = ''
         AND (c.album_id IS NULL OR (c.ok = 0 AND c.tried_at < ?))
       ORDER BY a.added_at DESC`).all(Date.now() - MISS_TTL_MS);
  }

  /*
   * Walk the coverless albums, one at a time.
   *
   * Sequential because the rate gate makes it sequential anyway, and because
   * the alternative — a dozen in flight all waiting on the same gate — is the
   * same speed with a dozen sockets open. Only one sweep runs at once.
   */
  async function sweep({ onFound = () => {} } = {}) {
    if (state.running || !state.available || !state.enabled) return state;
    const albums = pending();
    Object.assign(state, {
      running: true, done: 0, total: albums.length, found: 0,
      startedAt: Date.now(), finishedAt: 0, error: ""
    });
    if (albums.length) console.log(`[covers] looking for ${albums.length} missing cover(s)`);
    try {
      for (const album of albums) {
        if (!state.enabled) break;               // switched off mid-sweep
        try {
          const file = await findFor(album);
          if (file) { state.found++; onFound(album, file); }
        } catch (e) {
          /* Being asked to slow down is the only error that stops the sweep:
             the gate is already holding, and grinding through two hundred more
             albums against a hold is how a polite client becomes a blocked
             one. Anything else was recorded against the album. */
          state.error = e.message;
          console.warn("[covers] stopping: " + e.message);
          break;
        }
        state.done++;
      }
      state.last = state.total
        ? `${state.found} of ${state.total} found`
        : "nothing missing a cover";
      if (state.total) console.log(`[covers] ${state.last}`);
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
    return state;
  }

  function status() {
    const counts = db.prepare(
      `SELECT COUNT(*) AS missing FROM albums
       WHERE present = 1 AND art = '' AND art_fetched = ''`).get();
    const found = db.prepare(
      "SELECT COUNT(*) AS n FROM albums WHERE art_fetched <> ''").get().n;
    return {
      available: state.available,
      enabled: state.enabled,
      running: state.running,
      done: state.done, total: state.total, found: state.found,
      missing: counts.missing, fetched: found,
      last: state.last, error: state.error
    };
  }

  /* A container that said no cannot be talked round from a phone. */
  function setEnabled(on) {
    state.enabled = state.available && !!on;
    return state.enabled;
  }

  return { sweep, findFor, status, setEnabled, pending, userAgent: () => UA };
}

module.exports = { createCovers, userAgent, MISS_TTL_MS, MB_GAP_MS };
