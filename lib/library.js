/*
 * MusicD Server — reading the library.
 *
 * Every home row, grid and search in the UI is one query in here. They all
 * return the same album shape so the client has a single card renderer.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const path = require("path");
const { encodeId } = require("./ids");
const { playableBySonos } = require("./scanner");

/* Six months, as the "not played in 6 months" row means it: half a year, not
   180 days. Computed from the current LOCAL date so the boundary moves at
   local midnight — which is why the container needs a TZ set. */
function sixMonthsAgo(now = new Date()) {
  const d = new Date(now.getTime());
  d.setMonth(d.getMonth() - 6);
  return d.getTime();
}

function dayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const ALBUM_COLS = `id, title, artist, year, release_date, genre, track_count, duration,
                    added_at, last_played_at, play_count, favourite, (art <> '') AS has_art`;

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    year: row.year || null,
    genre: row.genre || "",
    trackCount: row.track_count,
    duration: row.duration,
    addedAt: row.added_at,
    lastPlayedAt: row.last_played_at || null,
    playCount: row.play_count,
    art: row.has_art ? `/art/${encodeId(row.id)}` : "",
    reason: row.reason || undefined
  };
}

function all(db, sql, params = []) {
  return db.prepare(sql).all(...params).map(shape);
}

/* ------------------------------------------------------------------ */
/*  The home rows                                                      */
/* ------------------------------------------------------------------ */

/* Library: the whole collection, by artist then year. This is the shelf
   order — every album an artist made, in the order they made them. */
function library(db, limit = 60, offset = 0) {
  return all(db, `SELECT ${ALBUM_COLS} FROM albums WHERE present = 1
                  ORDER BY sort_artist, year, sort_title
                  LIMIT ? OFFSET ?`, [limit, offset]);
}

/* Random albums. The seed is per-request on purpose: this row is the one the
   user refreshes to see something else, and a stable order would defeat it. */
function random(db, limit = 30) {
  return all(db, `SELECT ${ALBUM_COLS} FROM albums WHERE present = 1
                  ORDER BY RANDOM() LIMIT ?`, [limit]);
}

function recentlyAdded(db, limit = 30, offset = 0) {
  return all(db, `SELECT ${ALBUM_COLS} FROM albums WHERE present = 1
                  ORDER BY added_at DESC, sort_artist LIMIT ? OFFSET ?`, [limit, offset]);
}

function recentlyPlayed(db, limit = 30, offset = 0) {
  return all(db, `SELECT ${ALBUM_COLS} FROM albums
                  WHERE present = 1 AND last_played_at IS NOT NULL
                  ORDER BY last_played_at DESC LIMIT ? OFFSET ?`, [limit, offset]);
}

/*
 * Not played in 6 months.
 *
 * Two kinds of album qualify, and both are what the row's name promises: one
 * played longer than six months ago, and one that has been in the library for
 * more than six months and has never been played at all. On a fresh install
 * neither can exist, which is why the row is empty until the library has been
 * running that long — exactly as expected.
 *
 * Oldest first: the album you have gone longest without is the one the row
 * exists to put back in front of you.
 */
function notPlayedIn6Months(db, limit = 30, offset = 0) {
  const cutoff = sixMonthsAgo();
  return all(db, `SELECT ${ALBUM_COLS} FROM albums
                  WHERE present = 1
                    AND ((last_played_at IS NOT NULL AND last_played_at < ?)
                      OR (last_played_at IS NULL AND added_at < ?))
                  ORDER BY COALESCE(last_played_at, added_at) ASC
                  LIMIT ? OFFSET ?`, [cutoff, cutoff, limit, offset]);
}

/* ------------------------------------------------------------------ */
/*  Album detail                                                       */
/* ------------------------------------------------------------------ */

function album(db, id) {
  const row = db.prepare(`SELECT ${ALBUM_COLS} FROM albums WHERE id = ?`).get(id);
  if (!row) return null;
  const out = shape(row);
  /* Here and not on the grid card. ISO and possibly partial — the client
     decides how to say it, because the phone knows the reader's locale and
     this process knows the server's. A row of the home screen carries
     twenty-four of these cards and six rows come back at once, so a field
     only the album screen reads does not belong on the card. */
  out.releaseDate = row.release_date || "";
  /* A flag on the way out, a timestamp in the table — see favourites(). */
  out.favourite = row.favourite > 0;
  out.tracks = db.prepare(
    `SELECT id, title, artist, disc, no, duration, mime, bitdepth, samplerate, rel,
            play_count, last_played_at
     FROM tracks WHERE album_id = ? AND present = 1
     ORDER BY disc, no, rel`).all(id).map(t => ({
      id: t.id, title: t.title, artist: t.artist,
      disc: t.disc, no: t.no, duration: t.duration, mime: t.mime,
      bitdepth: t.bitdepth || null, sampleRate: t.samplerate || null,
      playCount: t.play_count, lastPlayedAt: t.last_played_at || null,
      /* Decided HERE, once, and sent to the client. The album screen badges
         files Sonos cannot play and the queue builder drops them; when each
         side worked it out for itself — one from the extension, the other from
         the MIME type — they disagreed about Opus, which maps to audio/ogg but
         is not a container Sonos decodes. The badge said nothing and the track
         then vanished on Play. */
      playable: playableBySonos(path.extname(t.rel || "").toLowerCase())
    }));
  /* Only shown when a folder actually spans discs — a "Disc 1" heading over a
     single-disc album is noise. */
  out.multiDisc = new Set(out.tracks.map(t => t.disc)).size > 1;
  return out;
}

function tracksForAlbum(db, id) {
  return db.prepare(
    `SELECT * FROM tracks WHERE album_id = ? AND present = 1 ORDER BY disc, no, rel`).all(id);
}

/* ------------------------------------------------------------------ */
/*  Search                                                             */
/* ------------------------------------------------------------------ */

/*
 * One box, three kinds of answer: albums, artists, tracks. LIKE with a leading
 * wildcard cannot use an index, which would matter on a library ten times the
 * size of a large one — at album scale it is a few milliseconds and it keeps
 * the schema free of an FTS table that would need its own rebuild step.
 */
function search(db, q, limit = 40) {
  const query = String(q || "").trim();
  /* Measured on the QUERY, not on the wildcard-wrapped term — "%a%" is three
     characters long and would sail past a length check on the latter, which is
     how a single letter came to match most of the library. */
  if (query.length < 2) return { albums: [], artists: [], tracks: [] };
  const term = `%${query}%`;

  const albums = all(db, `SELECT ${ALBUM_COLS} FROM albums
                          WHERE present = 1 AND (title LIKE ? OR artist LIKE ?)
                          ORDER BY sort_artist, year LIMIT ?`, [term, term, limit]);

  const artists = db.prepare(
    `SELECT artist AS name, COUNT(*) AS albums FROM albums
     WHERE present = 1 AND artist <> '' AND artist LIKE ?
     GROUP BY artist ORDER BY artist LIMIT ?`).all(term, 20);

  const tracks = db.prepare(
    `SELECT t.id, t.title, t.artist, t.album_id, a.title AS album, (a.art <> '') AS has_art
     FROM tracks t JOIN albums a ON a.id = t.album_id
     WHERE t.present = 1 AND t.title LIKE ?
     ORDER BY t.title LIMIT ?`).all(term, limit).map(t => ({
      id: t.id, title: t.title, artist: t.artist, albumId: t.album_id, album: t.album,
      art: t.has_art ? `/art/${encodeId(t.album_id)}` : ""
    }));

  return { albums, artists, tracks };
}

/*
 * An artist's albums, in two lists.
 *
 * The first is the records they made: the album artist is them. The second is
 * everywhere else they turn up — a compilation, a soundtrack, a guest verse —
 * found by looking at the TRACK artists rather than the album's, and with the
 * first list taken back out so nothing is offered twice.
 */
function byArtist(db, name) {
  const albums = all(db, `SELECT ${ALBUM_COLS} FROM albums
                          WHERE present = 1 AND artist = ?
                          ORDER BY year, sort_title`, [name]);
  const appearsOn = all(db, `SELECT ${ALBUM_COLS} FROM albums
                             WHERE present = 1 AND artist <> ?
                               AND id IN (SELECT DISTINCT album_id FROM tracks
                                          WHERE present = 1 AND artist = ?)
                             ORDER BY year, sort_title`, [name, name]);
  return { albums, appearsOn };
}

function artists(db) {
  return db.prepare(
    `SELECT artist AS name, COUNT(*) AS albums, MIN(sort_artist) AS sort
     FROM albums WHERE present = 1 AND artist <> ''
     GROUP BY artist ORDER BY sort`).all();
}

/* ------------------------------------------------------------------ */
/*  Favourites                                                         */
/* ------------------------------------------------------------------ */

/* Newest first — the one a person marked most recently is the one they were
   just thinking about. `favourite` holds the moment it was marked rather than
   a flag, which is what makes that ordering possible; anything non-zero is
   marked, so every query still reads as a boolean. */
function favourites(db, limit = 24, offset = 0) {
  return all(db, `SELECT ${ALBUM_COLS} FROM albums
                  WHERE present = 1 AND favourite > 0
                  ORDER BY favourite DESC, sort_artist, year
                  LIMIT ? OFFSET ?`, [limit, offset]);
}

function setFavourite(db, id, on, now = Date.now()) {
  const row = db.prepare("SELECT id FROM albums WHERE id = ?").get(id);
  if (!row) return null;
  db.prepare("UPDATE albums SET favourite = ? WHERE id = ?").run(on ? now : 0, id);
  return { id, favourite: !!on };
}

function favouriteCount(db) {
  return db.prepare("SELECT COUNT(*) n FROM albums WHERE present = 1 AND favourite > 0").get().n;
}

/* ------------------------------------------------------------------ */
/*  Counts for the status line                                         */
/* ------------------------------------------------------------------ */

function stats(db) {
  const a = db.prepare("SELECT COUNT(*) n, SUM(duration) d FROM albums WHERE present = 1").get();
  const t = db.prepare("SELECT COUNT(*) n FROM tracks WHERE present = 1").get();
  const p = db.prepare("SELECT COUNT(*) n FROM plays").get();
  return { albums: a.n || 0, tracks: t.n || 0, duration: a.d || 0, plays: p.n || 0 };
}

module.exports = {
  favourites, setFavourite, favouriteCount,
  library, random, recentlyAdded, recentlyPlayed, notPlayedIn6Months,
  album, tracksForAlbum, search, byArtist, artists, stats,
  sixMonthsAgo, dayKey, shape, ALBUM_COLS
};
