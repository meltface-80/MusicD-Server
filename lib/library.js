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
const { editionLabel } = require("./match");

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

/* has_art is either kind of cover — the one in the folder, or the one this
   app went and found for an album that had none (lib/covers.js). Every screen
   asks the same question, "is there a picture for this", and /art serves
   whichever exists. */
const ALBUM_COLS = `id, title, artist, year, release_date, genre, track_count, duration,
                    added_at, last_played_at, play_count, favourite,
                    (art <> '' OR art_fetched <> '') AS has_art`;

/*
 * Every row, grid and search shows albums, not copies of albums.
 *
 * A deluxe reissue is a version of the record rather than a second record, so
 * it is reachable from the primary's screen (see album() below) and nowhere
 * else. `version_of` is empty on exactly one album per group — see
 * lib/duplicates.js — which makes "the albums" one term rather than a join.
 */
const PRIMARY = "version_of = ''";

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
  return all(db, `SELECT ${ALBUM_COLS} FROM albums WHERE present = 1 AND ${PRIMARY}
                  ORDER BY sort_artist, year, sort_title
                  LIMIT ? OFFSET ?`, [limit, offset]);
}

/* Random albums. The seed is per-request on purpose: this row is the one the
   user refreshes to see something else, and a stable order would defeat it. */
function random(db, limit = 30) {
  return all(db, `SELECT ${ALBUM_COLS} FROM albums WHERE present = 1 AND ${PRIMARY}
                  ORDER BY RANDOM() LIMIT ?`, [limit]);
}

function recentlyAdded(db, limit = 30, offset = 0) {
  return all(db, `SELECT ${ALBUM_COLS} FROM albums WHERE present = 1 AND ${PRIMARY}
                  ORDER BY added_at DESC, sort_artist LIMIT ? OFFSET ?`, [limit, offset]);
}

function recentlyPlayed(db, limit = 30, offset = 0) {
  return all(db, `SELECT ${ALBUM_COLS} FROM albums
                  WHERE present = 1 AND ${PRIMARY} AND last_played_at IS NOT NULL
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
                  WHERE present = 1 AND ${PRIMARY}
                    AND ((last_played_at IS NOT NULL AND last_played_at < ?)
                      OR (last_played_at IS NULL AND added_at < ?))
                  ORDER BY COALESCE(last_played_at, added_at) ASC
                  LIMIT ? OFFSET ?`, [cutoff, cutoff, limit, offset]);
}

/* ------------------------------------------------------------------ */
/*  Album detail                                                       */
/* ------------------------------------------------------------------ */

/*
 * The album screen, which is a GROUP rather than a row.
 *
 * Ask for any version and you get the same album back: the record's identity —
 * title, artist, heart, history — comes from the primary, the track list and
 * the cover come from the version asked for, and `selected` says which one
 * that was so the client can light the right tab. That is what makes tapping
 * a search result for a bonus track open the album with the deluxe tab
 * already showing, instead of a screen that disagrees with the home row it
 * came from.
 */
function album(db, id) {
  const row = db.prepare(`SELECT ${ALBUM_COLS}, version_of FROM albums WHERE id = ?`).get(id);
  if (!row) return null;
  /* A version whose primary has gone missing stands in for itself. Nothing
     writes that state, but a database edited by hand can hold it and an album
     screen that 404s is a worse answer than one that shows the version. */
  const head = row.version_of
    ? db.prepare(`SELECT ${ALBUM_COLS}, version_of FROM albums WHERE id = ?`).get(row.version_of) || row
    : row;

  const out = shape(head);
  /* Here and not on the grid card. ISO and possibly partial — the client
     decides how to say it, because the phone knows the reader's locale and
     this process knows the server's. A row of the home screen carries
     twenty-four of these cards and six rows come back at once, so a field
     only the album screen reads does not belong on the card. */
  out.releaseDate = head.release_date || "";
  /* A flag on the way out, a timestamp in the table — see favourites(). */
  out.favourite = head.favourite > 0;

  /* The version on show. Its cover and its track list, but the primary's
     cover when this one has none — a version with no art of its own is far
     more common than two versions with different art. */
  out.selected = row.id;
  out.trackCount = row.track_count;
  out.duration = row.duration;
  if (row.has_art) out.art = `/art/${encodeId(row.id)}`;

  out.tracks = db.prepare(
    `SELECT id, title, artist, disc, no, duration, mime, bitdepth, samplerate, rel,
            play_count, last_played_at
     FROM tracks WHERE album_id = ? AND present = 1
     ORDER BY disc, no, rel`).all(row.id).map(t => ({
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

  const versions = versionsOf(db, head.id);
  /* Absent unless there is a choice to make. One version is not a version. */
  if (versions.length > 1) out.versions = versions;
  return out;
}

/*
 * Every copy of one record, primary first.
 *
 * The label is the edition marker off the title — "Deluxe Edition" — and the
 * plain copy is called "Standard", a word that only ever appears beside at
 * least one edition tab so it reads as the contrast it is. Two versions whose
 * titles produce the same label are told apart by their track counts, because
 * a row of identical tabs is a row of no information.
 */
function versionsOf(db, headId) {
  const rows = db.prepare(
    `SELECT ${ALBUM_COLS}, version_of FROM albums
     WHERE present = 1 AND (id = ? OR version_of = ?)
     ORDER BY (version_of <> ''), track_count DESC, title`).all(headId, headId);
  const labels = rows.map(r => editionLabel(r.title));
  const seen = new Map();
  for (const label of labels) seen.set(label, (seen.get(label) || 0) + 1);
  return rows.map((r, i) => ({
    id: r.id,
    title: r.title,
    label: seen.get(labels[i]) > 1
      ? `${labels[i]} · ${r.track_count} track${r.track_count === 1 ? "" : "s"}`
      : labels[i],
    primary: !r.version_of,
    trackCount: r.track_count,
    duration: r.duration,
    year: r.year || null,
    art: r.has_art ? `/art/${encodeId(r.id)}` : ""
  }));
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
                          WHERE present = 1 AND ${PRIMARY} AND (title LIKE ? OR artist LIKE ?)
                          ORDER BY sort_artist, year LIMIT ?`, [term, term, limit]);

  const artists = db.prepare(
    `SELECT artist AS name, COUNT(*) AS albums FROM albums
     WHERE present = 1 AND version_of = '' AND artist <> '' AND artist LIKE ?
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
                          WHERE present = 1 AND ${PRIMARY} AND artist = ?
                          ORDER BY year, sort_title`, [name]);
  /* A guest verse can sit on the deluxe edition alone, so the track's album
     is mapped to whichever version is the one on show before it is matched —
     otherwise the appearance exists in the library and appears nowhere. */
  const appearsOn = all(db, `SELECT ${ALBUM_COLS} FROM albums
                             WHERE present = 1 AND ${PRIMARY} AND artist <> ?
                               AND id IN (SELECT DISTINCT
                                            CASE WHEN a.version_of <> '' THEN a.version_of ELSE a.id END
                                          FROM tracks t JOIN albums a ON a.id = t.album_id
                                          WHERE t.present = 1 AND t.artist = ?)
                             ORDER BY year, sort_title`, [name, name]);
  return { albums, appearsOn };
}

function artists(db) {
  return db.prepare(
    `SELECT artist AS name, COUNT(*) AS albums, MIN(sort_artist) AS sort
     FROM albums WHERE present = 1 AND version_of = '' AND artist <> ''
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
                  WHERE present = 1 AND ${PRIMARY} AND favourite > 0
                  ORDER BY favourite DESC, sort_artist, year
                  LIMIT ? OFFSET ?`, [limit, offset]);
}

/* Marked on the PRIMARY, whichever version was on screen. The Favourites row
   only shows primaries, so a heart filled on a deluxe tab would otherwise
   light up and then be nowhere to be found. */
function setFavourite(db, id, on, now = Date.now()) {
  const row = db.prepare("SELECT id, version_of FROM albums WHERE id = ?").get(id);
  if (!row) return null;
  const target = row.version_of || row.id;
  db.prepare("UPDATE albums SET favourite = ? WHERE id = ?").run(on ? now : 0, target);
  return { id: target, favourite: !!on };
}

function favouriteCount(db) {
  return db.prepare(
    "SELECT COUNT(*) n FROM albums WHERE present = 1 AND version_of = '' AND favourite > 0").get().n;
}

/* ------------------------------------------------------------------ */
/*  Counts for the status line                                         */
/* ------------------------------------------------------------------ */

function stats(db) {
  /* What the library HAS, counted the way the screens show it: a record that
     is on disk twice is one album, one runtime and one track list. */
  const a = db.prepare(
    "SELECT COUNT(*) n, SUM(duration) d FROM albums WHERE present = 1 AND version_of = ''").get();
  const t = db.prepare(
    `SELECT COUNT(*) n FROM tracks t JOIN albums al ON al.id = t.album_id
     WHERE t.present = 1 AND al.present = 1 AND al.version_of = ''`).get();
  const p = db.prepare("SELECT COUNT(*) n FROM plays").get();
  return { albums: a.n || 0, tracks: t.n || 0, duration: a.d || 0, plays: p.n || 0 };
}

module.exports = {
  favourites, setFavourite, favouriteCount,
  library, random, recentlyAdded, recentlyPlayed, notPlayedIn6Months,
  album, versionsOf, tracksForAlbum, search, byArtist, artists, stats,
  sixMonthsAgo, dayKey, shape, ALBUM_COLS
};
