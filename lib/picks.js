/*
 * MusicD Server — Smart Picks.
 *
 * Local files only. Nothing here calls out to a metadata service, a chart, or
 * a streaming catalogue: a pick is always an album you already own, chosen
 * because of what you have been playing lately.
 *
 * The shape of it: what you played recently defines a taste profile (artists,
 * genres, decades, each weighted by how recently you played it). Every album
 * in the library that you have NOT played recently is scored against that
 * profile, and the best few — never two by the same artist — are the picks.
 * Each one carries the reason it was chosen, because a recommendation you
 * cannot account for is one you stop trusting.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const { shape, ALBUM_COLS, dayKey } = require("./library");

const DAY = 24 * 60 * 60 * 1000;

/* How far back "recently played" reaches when building the profile, and how
   recently an album must have been played to be excluded from the results.
   The gap between the two is deliberate: an album played 70 days ago still
   shapes your taste profile but is fair game to be offered again. */
const PROFILE_WINDOW_DAYS = 90;
const EXCLUDE_WINDOW_DAYS = 60;
const SEED_LIMIT = 25;
const PICK_COUNT = 12;

function decadeOf(year) { return year ? Math.floor(year / 10) * 10 : null; }

/* A seed's influence decays over the profile window: what you played last
   week says more about what you want next than what you played in March. */
function recencyWeight(playedAt, now) {
  const age = Math.max(0, now - playedAt) / DAY;
  return Math.max(0.15, 1 - age / PROFILE_WINDOW_DAYS);
}

function buildProfile(db, now) {
  const since = now - PROFILE_WINDOW_DAYS * DAY;
  const seeds = db.prepare(
    `SELECT id, title, artist, genre, year, last_played_at
     FROM albums
     WHERE present = 1 AND last_played_at IS NOT NULL AND last_played_at >= ?
     ORDER BY last_played_at DESC LIMIT ?`).all(since, SEED_LIMIT);

  const artists = new Map();     // artist -> { weight, album }
  const genres  = new Map();     // genre  -> { weight, album, artist }
  const decades = new Map();     // decade -> weight

  for (const s of seeds) {
    const w = recencyWeight(s.last_played_at, now);
    if (s.artist) {
      const cur = artists.get(s.artist);
      if (!cur || w > cur.weight) artists.set(s.artist, { weight: w, album: s.title });
      else cur.weight += w * 0.25;      // played several of theirs — stronger signal
    }
    if (s.genre) {
      const cur = genres.get(s.genre);
      if (!cur || w > cur.weight) genres.set(s.genre, { weight: w, album: s.title, artist: s.artist });
    }
    const dec = decadeOf(s.year);
    if (dec) decades.set(dec, Math.max(decades.get(dec) || 0, w));
  }

  return { seeds, artists, genres, decades };
}

/*
 * Score one album against the profile.
 *
 * `matched` is the important part of the return value. An album earns points
 * for being unplayed, but being unplayed is not a REASON to be picked — every
 * album you have not got round to is unplayed. Without this flag the row fills
 * up with whatever happens to be untouched, which is the random row wearing a
 * different name. A pick has to connect to something you actually played.
 */
function scoreAlbum(alb, profile, now) {
  let score = 0;
  let reason = "";
  let matched = false;

  /* Same artist as something you played. The strongest signal there is, and
     the one whose reason reads best: "More from X". */
  const artistHit = alb.artist && profile.artists.get(alb.artist);
  if (artistHit) {
    score += 6 * artistHit.weight;
    reason = `More from ${alb.artist}`;
    matched = true;
  }

  const genreHit = alb.genre && profile.genres.get(alb.genre);
  if (genreHit) {
    score += 3 * genreHit.weight;
    matched = true;
    if (!reason) {
      reason = genreHit.artist
        ? `${alb.genre}, like ${genreHit.artist}`
        : `More ${alb.genre}`;
    }
  }

  const dec = decadeOf(alb.year);
  if (dec && profile.decades.has(dec)) {
    score += 1.2 * profile.decades.get(dec);
    matched = true;
    if (!reason) reason = `From the ${dec}s, like you have been playing`;
  }

  /* Nudge toward the back of the shelf. A pick you have never played is more
     use than one you played last year, and both beat one from last month. */
  if (!alb.last_played_at) {
    score += 2.5;
    if (!reason) reason = "Never played";
    else reason += " — never played";
  } else {
    const months = (now - alb.last_played_at) / (30 * DAY);
    score += Math.min(2, months / 6);
    if (months >= 6 && reason) reason += ` — not played in ${Math.floor(months)} months`;
  }

  return { score, reason, matched };
}

/*
 * Build today's picks.
 *
 * Returns { picks, note }. `note` is set only when there is a reason there are
 * no picks that the user can act on — an empty row with no explanation looks
 * like a bug, and the fix for both real cases (nothing played yet, library too
 * small) is something only they can do.
 */
function build(db, now = Date.now()) {
  const total = db.prepare("SELECT COUNT(*) n FROM albums WHERE present = 1").get().n || 0;
  if (!total) return { picks: [], note: "Scan a music folder and picks will appear here." };

  const profile = buildProfile(db, now);
  if (!profile.seeds.length) {
    return { picks: [], note: "Play a few albums and Smart Picks will follow what you listen to." };
  }

  const excludeSince = now - EXCLUDE_WINDOW_DAYS * DAY;
  const candidates = db.prepare(
    `SELECT ${ALBUM_COLS}, sort_artist, last_played_at AS lp
     FROM albums
     WHERE present = 1
       AND (last_played_at IS NULL OR last_played_at < ?)`).all(excludeSince);

  const scored = [];
  for (const c of candidates) {
    const { score, reason, matched } = scoreAlbum(c, profile, now);
    if (!matched || score <= 0) continue;
    scored.push({ row: c, score, reason });
  }
  scored.sort((a, b) => b.score - a.score || (a.row.sort_artist || "").localeCompare(b.row.sort_artist || ""));

  /* One album per artist. Without this the row fills with a single artist's
     back catalogue the moment you play one of their records, which is the
     opposite of a pick. */
  const picks = [];
  const usedArtists = new Set();
  for (const s of scored) {
    if (picks.length >= PICK_COUNT) break;
    const key = (s.row.artist || "").toLowerCase();
    if (key && usedArtists.has(key)) continue;
    if (key) usedArtists.add(key);
    const out = shape(s.row);
    out.reason = s.reason;
    picks.push(out);
  }

  if (!picks.length) {
    return { picks: [], note: "Nothing new to suggest yet — everything close to what you " +
                              "have been playing, you have played recently." };
  }
  return { picks, note: "" };
}

/*
 * The cached, once-a-day version the home screen reads.
 *
 * Rebuilt on the first request of each local day, and whenever a scan or a
 * play invalidates it — a pick that stays on screen after you have played it
 * is the thing that makes the row look stale.
 */
function createCache(db) {
  let day = "";
  let value = { picks: [], note: "" };
  let dirty = true;

  return {
    get(now = new Date()) {
      const today = dayKey(now);
      if (dirty || today !== day) {
        value = build(db, now.getTime());
        day = today;
        dirty = false;
      }
      return value;
    },
    invalidate() { dirty = true; }
  };
}

module.exports = { build, createCache, buildProfile, PICK_COUNT };
