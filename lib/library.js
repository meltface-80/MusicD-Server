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
const { albumNames, albumMbid } = require("./db");
const { playableBySonos, sortKey } = require("./scanner");
const { editionLabel } = require("./match");

/* What an album is CALLED: a correction the user typed, or the tags. One
   definition, in lib/db.js, used by every query in this file — including the
   ones that sort and search, which have to agree with the ones that display or
   an album is filed under a name it does not show. */
const NAME = albumNames();
/* The same thing for the one query that joins, and so has to say which table
   the columns are in. */
const ALBUM = albumNames("a");

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
const ALBUM_COLS = `id, ${NAME.title} AS title, ${NAME.artist} AS artist,
                    year, release_date, genre, track_count, duration,
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
/*  How the library is ordered                                         */
/* ------------------------------------------------------------------ */

/*
 * The orders the Library screen offers, and the ONE place they are defined.
 *
 * `dir` is the direction a sort opens on when it is first chosen, and it is
 * not the same for all of them: an alphabetical list opens A→Z, and everything
 * quantitative opens with the biggest or newest first, because that is what
 * somebody means when they say "sort by year" or "most played". `asc` and
 * `desc` are what those two directions are CALLED for that sort — "Z → A" and
 * "Oldest first" describe the same arrow and a shared label would be wrong for
 * one of them.
 *
 * A sort with no `dir` has no direction at all; Random is the only one, and
 * the client hides the arrow for it.
 */
const SORTS = {
  album: {
    label: "Album name", dir: "asc", asc: "A → Z", desc: "Z → A",
    clause: (d) => `${NAME.sortTitle} ${d}, ${NAME.sortArtist} ${d}`
  },
  artist: {
    label: "Artist", dir: "asc", asc: "A → Z", desc: "Z → A",
    /* The shelf order this screen has always opened in: every album an artist
       made, in the order they made them. */
    clause: (d) => `${NAME.sortArtist} ${d}, year ${d}, ${NAME.sortTitle} ${d}`
  },
  year: {
    label: "Release year", dir: "desc", asc: "Oldest first", desc: "Newest first",
    /* An album with no year is UNKNOWN, not year zero, so it is held at the
       end in BOTH directions — reversing to newest-first must not float every
       untagged record to the top of the wall. The (year IS NULL) term is
       deliberately not reversed with the rest. */
    clause: (d) => `(year IS NULL), year ${d}, ${NAME.sortTitle} ASC`
  },
  added: {
    label: "Recently added", dir: "desc", asc: "Oldest first", desc: "Newest first",
    clause: (d) => `added_at ${d}, ${NAME.sortArtist} ASC`
  },
  plays: {
    label: "Most played", dir: "desc",
    asc: "Least played first", desc: "Most played first",
    clause: (d) => `play_count ${d}, ${NAME.sortArtist} ASC`
  },
  lastplayed: {
    label: "Last played", dir: "desc",
    asc: "Longest ago first", desc: "Most recent first",
    /* Never played is unknown rather than "longest ago", and stays at the end
       whichever way the arrow points — same rule as an album with no year. */
    clause: (d) => `(last_played_at IS NULL), last_played_at ${d}, ${NAME.sortArtist} ASC`
  },
  random: {
    label: "Random",
    /* Seeded, and it has to be: the grid reads a page at a time, and SQLite's
       own RANDOM() draws again on every call — so page two would be a
       different shuffle from page one, showing some albums twice and others
       never. See seeded_rank() in lib/db.js. */
    seeded: true,
    clause: () => `seeded_rank(id, ?)`
  }
};

const DEFAULT_SORT = "artist";
/* 1 to 100000. Zero is avoided because a seed that falls back to a default
   would silently mean "the same shuffle as everybody else". */
const MAX_SEED = 100000;

/*
 * A stored or requested view, made safe.
 *
 * Anything unrecognised falls back rather than throwing: this value comes out
 * of a database row written by an older version and off a query string, and a
 * library screen that 500s because a setting is from last year is a library
 * screen nobody can open.
 */
function normaliseSort(view) {
  const raw = view || {};
  const sort = SORTS[raw.sort] ? raw.sort : DEFAULT_SORT;
  const def = SORTS[sort];
  let dir = "asc";
  if (def.dir) dir = (raw.dir === "asc" || raw.dir === "desc") ? raw.dir : def.dir;
  let seed = Math.trunc(Number(raw.seed));
  if (!Number.isFinite(seed) || seed < 1 || seed > MAX_SEED) seed = 1;
  return { sort, dir, seed };
}

/* What the client needs to draw the sheet: the orders, in the order they are
   offered, each with what its two directions are called. Sent rather than
   repeated in the client, so the two cannot drift. */
function sortOptions() {
  return Object.entries(SORTS).map(([id, def]) => ({
    id, label: def.label,
    directional: !!def.dir,
    asc: def.asc || "", desc: def.desc || ""
  }));
}

/* ------------------------------------------------------------------ */
/*  The home rows                                                      */
/* ------------------------------------------------------------------ */

/* Library: the whole collection, in whichever order was chosen. Artist then
   year is the default — the shelf order, every album an artist made in the
   order they made them — and it is what this screen opened in before there was
   anything to choose. */
function library(db, limit = 60, offset = 0, view = null) {
  const v = normaliseSort(view);
  const def = SORTS[v.sort];
  const params = [];
  const order = def.clause(v.dir === "desc" ? "DESC" : "ASC");
  if (def.seeded) params.push(v.seed);
  return all(db, `SELECT ${ALBUM_COLS} FROM albums WHERE present = 1 AND ${PRIMARY}
                  ORDER BY ${order}
                  LIMIT ? OFFSET ?`, [...params, limit, offset]);
}

/* Random albums. The seed is per-request on purpose: this row is the one the
   user refreshes to see something else, and a stable order would defeat it. */
function random(db, limit = 30) {
  return all(db, `SELECT ${ALBUM_COLS} FROM albums WHERE present = 1 AND ${PRIMARY}
                  ORDER BY RANDOM() LIMIT ?`, [limit]);
}

function recentlyAdded(db, limit = 30, offset = 0) {
  return all(db, `SELECT ${ALBUM_COLS} FROM albums WHERE present = 1 AND ${PRIMARY}
                  ORDER BY added_at DESC, ${NAME.sortArtist} LIMIT ? OFFSET ?`, [limit, offset]);
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

/*
 * The albums that still have no picture at all — the covers screen.
 *
 * NOT the sweep's queue. `pending()` in lib/covers.js answers "what is due a
 * look", which leaves out everything inside its week-long cooldown; the
 * question this one answers is "which of my records have no sleeve", where a
 * miss recorded yesterday is exactly the one somebody has come here to fix by
 * hand.
 *
 * `cover_lookups` belongs to lib/covers.js and is READ here and never written:
 * what the last automatic look made of an album — "no artist to search on" —
 * is the difference between a wall of blank tiles and a list somebody can act
 * on, and it rides in on `reason`, the same field Smart Picks uses to say why
 * a pick is there.
 *
 * The one grid that does not say `PRIMARY`, deliberately. A version behind a
 * tab has its own tile on its own tab, so it is one of the albums missing a
 * cover — it is counted as one by covers.status(), it is swept as one, and
 * leaving it out here would make the count disagree with the screen AND leave
 * the copy unreachable from the only place it can be fixed from.
 */
function withoutCover(db, limit = 200, offset = 0) {
  return all(db, `SELECT ${ALBUM_COLS}, COALESCE(c.note, '') AS reason
                  FROM albums a
                  LEFT JOIN cover_lookups c ON c.album_id = a.id AND c.ok = 0
                  WHERE a.present = 1 AND a.art = '' AND a.art_fetched = ''
                  ORDER BY ${NAME.sortArtist}, ${NAME.sortTitle}
                  LIMIT ? OFFSET ?`, [limit, offset]);
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
  /* tag_title and tag_artist are the RAW columns — what the files say, beside
     what the screen shows. ALBUM_COLS aliases the corrected name over the top
     of `title`, so the two are asked for by different names or the second
     would be the first. */
  const DETAIL = `${ALBUM_COLS}, version_of, title AS tag_title, artist AS tag_artist,
                  mbid_chosen, ${albumMbid()} AS mbid`;
  const row = db.prepare(`SELECT ${DETAIL} FROM albums WHERE id = ?`).get(id);
  if (!row) return null;
  /* A version whose primary has gone missing stands in for itself. Nothing
     writes that state, but a database edited by hand can hold it and an album
     screen that 404s is a worse answer than one that shows the version. */
  const head = row.version_of
    ? db.prepare(`SELECT ${DETAIL} FROM albums WHERE id = ?`).get(row.version_of) || row
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
  /* What the FILES say, for the edit dialog and nothing else: it prefills with
     the name on show and offers the tags back, so a correction is undone in
     the same place it was made. A field only that dialog reads does not belong
     on a card, which is why it is here — the same rule as releaseDate. */
  out.tags = { title: head.tag_title, artist: head.tag_artist };
  out.edited = out.title !== head.tag_title || out.artist !== head.tag_artist;
  /*
   * WHICH RELEASE THIS IS, for the edit dialog and nothing else — the same
   * rule as tags and releaseDate above.
   *
   * Read off the album ON SHOW rather than the primary: a version behind a tab
   * is its own pressing with its own track count, so it is its own release and
   * confirming one must not speak for the other.
   */
  out.identity = {
    mbid: row.mbid || "",
    from: row.mbid_chosen ? "chosen" : (row.mbid ? "tags" : "")
  };

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
     ORDER BY (version_of <> ''), track_count DESC, ${NAME.title}`).all(headId, headId);
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
                          WHERE present = 1 AND ${PRIMARY}
                            AND (${NAME.title} LIKE ? OR ${NAME.artist} LIKE ?)
                          ORDER BY ${NAME.sortArtist}, year LIMIT ?`, [term, term, limit]);

  const artists = db.prepare(
    `SELECT ${NAME.artist} AS name, COUNT(*) AS albums FROM albums
     WHERE present = 1 AND version_of = '' AND ${NAME.artist} <> '' AND ${NAME.artist} LIKE ?
     GROUP BY name ORDER BY name LIMIT ?`).all(term, 20);

  const tracks = db.prepare(
    `SELECT t.id, t.title, t.artist, t.album_id, ${ALBUM.title} AS album,
            (a.art <> '' OR a.art_fetched <> '') AS has_art
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
                          WHERE present = 1 AND ${PRIMARY} AND ${NAME.artist} = ?
                          ORDER BY year, ${NAME.sortTitle}`, [name]);
  /* A guest verse can sit on the deluxe edition alone, so the track's album
     is mapped to whichever version is the one on show before it is matched —
     otherwise the appearance exists in the library and appears nowhere. */
  const appearsOn = all(db, `SELECT ${ALBUM_COLS} FROM albums
                             WHERE present = 1 AND ${PRIMARY} AND ${NAME.artist} <> ?
                               AND id IN (SELECT DISTINCT
                                            CASE WHEN a.version_of <> '' THEN a.version_of ELSE a.id END
                                          FROM tracks t JOIN albums a ON a.id = t.album_id
                                          WHERE t.present = 1 AND t.artist = ?)
                             ORDER BY year, ${NAME.sortTitle}`, [name, name]);
  return { albums, appearsOn };
}

function artists(db) {
  return db.prepare(
    `SELECT ${NAME.artist} AS name, COUNT(*) AS albums, MIN(${NAME.sortArtist}) AS sort
     FROM albums WHERE present = 1 AND version_of = '' AND ${NAME.artist} <> ''
     GROUP BY name ORDER BY sort`).all();
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
                  ORDER BY favourite DESC, ${NAME.sortArtist}, year
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
/*  Correcting a name                                                  */
/* ------------------------------------------------------------------ */

/* One space between words, none at either end. A name that differs from the
   tags only by the whitespace around it is not a correction. */
function tidy(value) { return String(value == null ? "" : value).replace(/\s+/g, " ").trim(); }

/*
 * The album title and artist as the user says they are.
 *
 * Written to the PRIMARY, whichever version was on screen, for the same reason
 * the heart is: the primary's name is the one every row, search and speaker
 * shows, so a correction typed on a deluxe tab would otherwise appear on that
 * tab alone and nowhere the user was looking.
 *
 * A field that comes back EMPTY, or that matches the tags exactly, clears the
 * correction rather than storing one — which is what makes an accidental
 * rename undoable without a second control to undo it, and stops a library
 * carrying thousands of rows that say what the files already say.
 *
 * The tags themselves are never touched. Nothing here writes to the music
 * folder, which is very often read-only and is in any case the user's.
 */
function setNames(db, id, { title, artist } = {}) {
  const row = db.prepare("SELECT id, version_of FROM albums WHERE id = ?").get(id);
  if (!row) return null;
  const target = row.version_of || row.id;
  const tags = db.prepare("SELECT title, artist FROM albums WHERE id = ?").get(target);
  if (!tags) return null;

  /* An empty title would leave the album with no name at all — every row and
     every search result would show a blank card — so a blank one means the
     tags, exactly as a blank artist does. */
  const wantTitle = tidy(title);
  const wantArtist = tidy(artist);
  const titleEdit = (!wantTitle || wantTitle === tags.title) ? "" : wantTitle;
  const artistEdit = (!wantArtist || wantArtist === tags.artist) ? "" : wantArtist;

  db.prepare(
    `UPDATE albums SET title_edit = ?, artist_edit = ?,
            sort_title_edit = ?, sort_artist_edit = ?
     WHERE id = ?`)
    .run(titleEdit, artistEdit,
         titleEdit ? sortKey(titleEdit) : "",
         artistEdit ? sortKey(artistEdit) : "",
         target);

  return {
    id: target,
    title: titleEdit || tags.title,
    artist: artistEdit || tags.artist,
    edited: !!(titleEdit || artistEdit)
  };
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
  withoutCover, setNames,
  SORTS, DEFAULT_SORT, MAX_SEED, normaliseSort, sortOptions,
  album, versionsOf, tracksForAlbum, search, byArtist, artists, stats,
  sixMonthsAgo, dayKey, shape, ALBUM_COLS
};
