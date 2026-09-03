/*
 * MusicD Server — the database.
 *
 * One SQLite file holds the library and the listening history. The library
 * half is rebuilt from disk on every scan; the history half is the part that
 * cannot be rebuilt, so nothing in here ever deletes a play row, and an album
 * that disappears and comes back keeps the counts it had.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

/* Album and track identity is the file path, not a rowid. A rescan that finds
   the same folder must land on the same album row, or every stat resets. The
   key is the path relative to the library root so that moving the whole
   collection to a new mount point (a very common thing to do) does not orphan
   the history. */
function albumKey(relDir) { return "a:" + relDir; }
function trackKey(relPath) { return "t:" + relPath; }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS albums (
  id            TEXT PRIMARY KEY,
  dir           TEXT NOT NULL,
  title         TEXT NOT NULL,
  artist        TEXT NOT NULL DEFAULT '',
  sort_title    TEXT NOT NULL DEFAULT '',
  sort_artist   TEXT NOT NULL DEFAULT '',
  year          INTEGER,
  -- The release date as the tags give it, ISO and possibly partial: a full
  -- "2025-09-23", or just "2025" when that is all the file says. The year
  -- column is still what every row is sorted and filtered by; this is only
  -- for saying the date out loud where there is room for it.
  release_date  TEXT NOT NULL DEFAULT '',
  genre         TEXT NOT NULL DEFAULT '',
  track_count   INTEGER NOT NULL DEFAULT 0,
  duration      REAL NOT NULL DEFAULT 0,
  art           TEXT NOT NULL DEFAULT '',
  -- A cover this app went and found for an album that had none, stored under
  -- the data directory. A SEPARATE column from art on purpose: the scan
  -- rewrites art from what is in the folder on every pass, so a fetched cover
  -- kept there would be wiped by the next rescan and fetched all over again.
  -- Nothing in the scan's upserts mentions this one.
  art_fetched   TEXT NOT NULL DEFAULT '',
  -- A name the user typed, for an album whose tags are wrong or missing — the
  -- second thing in here they wrote rather than the files, after favourite.
  -- SEPARATE columns for the same reason art_fetched is separate: the scan
  -- rewrites title and artist from the tags on every pass, so a correction
  -- kept in those would last until the next scan and no longer. Empty means
  -- "what the files say", which is also how a correction is undone.
  --
  -- The sort keys are stored rather than derived because the key drops a
  -- leading article, and that is a rule lib/scanner.js knows and SQL does not.
  -- Nothing in the scan's upserts mentions any of these four.
  title_edit       TEXT NOT NULL DEFAULT '',
  artist_edit      TEXT NOT NULL DEFAULT '',
  sort_title_edit  TEXT NOT NULL DEFAULT '',
  sort_artist_edit TEXT NOT NULL DEFAULT '',
  added_at      INTEGER NOT NULL,
  last_played_at INTEGER,
  play_count    INTEGER NOT NULL DEFAULT 0,
  -- Marked by hand, never by the scanner, and the one column here the user
  -- typed rather than the files. It survives a rescan for the same reason
  -- added_at does: nothing in the scan's upserts mentions it.
  favourite     INTEGER NOT NULL DEFAULT 0,
  -- Empty when this album is the one shown: either the only copy of the
  -- record, or the primary version of several. Otherwise the id of the album
  -- this is a version OF — a deluxe reissue sitting behind its own tab on
  -- the primary's screen. Derived by lib/duplicates.js from the titles and
  -- track names, never typed and never fetched.
  version_of    TEXT NOT NULL DEFAULT '',
  present       INTEGER NOT NULL DEFAULT 1,
  seen_at       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tracks (
  id            TEXT PRIMARY KEY,
  album_id      TEXT NOT NULL,
  path          TEXT NOT NULL,
  rel           TEXT NOT NULL,
  title         TEXT NOT NULL,
  artist        TEXT NOT NULL DEFAULT '',
  -- The album-level tags, kept per track on purpose. Deriving an album's
  -- artist, year and genre needs to see what EVERY file in the folder says,
  -- and an incremental rescan only re-reads the files that changed. Without
  -- these columns the reuse path returns blanks, and one re-tagged track
  -- wipes the album's artist.
  albumartist   TEXT NOT NULL DEFAULT '',
  album_tag     TEXT NOT NULL DEFAULT '',
  genre         TEXT NOT NULL DEFAULT '',
  year          INTEGER,
  -- Which generation of tag-reading produced the columns above. A scan skips
  -- any file whose size and mtime are unchanged, so ADDING a tag column is not
  -- enough to fill it in: the file is never opened again. This is the flag the
  -- scan checks as well as the mtime, so a track read by an older version is
  -- re-read once and the new columns actually get values.
  tags_read     INTEGER NOT NULL DEFAULT 0,
  disc          INTEGER NOT NULL DEFAULT 1,
  no            INTEGER NOT NULL DEFAULT 0,
  duration      REAL NOT NULL DEFAULT 0,
  mime          TEXT NOT NULL DEFAULT '',
  bitdepth      INTEGER,
  samplerate    INTEGER,
  size          INTEGER NOT NULL DEFAULT 0,
  mtime         INTEGER NOT NULL DEFAULT 0,
  added_at      INTEGER NOT NULL,
  last_played_at INTEGER,
  play_count    INTEGER NOT NULL DEFAULT 0,
  present       INTEGER NOT NULL DEFAULT 1
);

-- What was already asked about a missing cover, so it is not asked again on
-- every scan. A hit is remembered because the file is on disk; a miss is
-- remembered so a library of two hundred coverless bootlegs costs a couple of
-- hundred requests once rather than every six hours forever.
CREATE TABLE IF NOT EXISTS cover_lookups (
  album_id TEXT PRIMARY KEY,
  tried_at INTEGER NOT NULL,
  ok       INTEGER NOT NULL DEFAULT 0,
  source   TEXT NOT NULL DEFAULT '',
  note     TEXT NOT NULL DEFAULT ''
);

-- Listens waiting to go to Last.fm. Written before they are sent and deleted
-- only once Last.fm has accepted them, so a router reboot, a restart or an
-- update cannot lose one. Empty for anybody who has not connected an account.
CREATE TABLE IF NOT EXISTS scrobbles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  artist       TEXT NOT NULL,
  track        TEXT NOT NULL,
  album        TEXT NOT NULL DEFAULT '',
  album_artist TEXT NOT NULL DEFAULT '',
  duration     INTEGER NOT NULL DEFAULT 0,
  track_no     INTEGER NOT NULL DEFAULT 0,
  -- Seconds, not milliseconds: this is the UTC time the track STARTED, which
  -- is what Last.fm records and what makes a scrobble land in the right place
  -- in a listening history.
  ts           INTEGER NOT NULL,
  tries        INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT NOT NULL DEFAULT ''
);

-- What Wikipedia (or Last.fm) says about a record or the person who made it,
-- fetched the first time somebody opens the screen that shows it and never
-- again. There is no TTL on a hit ON PURPOSE: an encyclopaedia article about a
-- 1988 album is not going to become a different article, and re-asking for it
-- would spend somebody else's bandwidth to receive the same paragraph.
--
-- A MISS is the one thing here that expires. Without that, an album Wikipedia
-- gains an article for next year would be marked unknown for ever; with it,
-- the question is asked again a week later and at most once a week after that.
--
-- The url and the licence are stored beside the text rather than derived at
-- display time because they are the TERMS the text arrived under — Wikipedia
-- and Last.fm both give their prose away on condition it is credited and
-- linked, and a credit worked out later from a title is a credit that can be
-- wrong. What was fetched and what it must say travel together.
CREATE TABLE IF NOT EXISTS info (
  -- 'album' or 'artist'. An album is keyed by the PRIMARY album's id, the
  -- same row the heart and the typed name go to; an artist by the folded
  -- artist key, so AC/DC and ACDC ask once between them.
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT '',
  -- What the source calls it, which is not always what the library calls it:
  -- "Hex (Bark Psychosis album)" is the page, "Hex" is the record.
  title      TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT '',
  licence    TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL DEFAULT '',
  -- Critical reception, albums only. Empty where the article has no such
  -- section, which is most of them.
  review     TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (kind, key)
);

CREATE TABLE IF NOT EXISTS plays (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind     TEXT NOT NULL,
  ref      TEXT NOT NULL,
  album_id TEXT NOT NULL DEFAULT '',
  ts       INTEGER NOT NULL
);

`;

/*
 * Indexes, created AFTER the migration rather than with the tables.
 *
 * CREATE TABLE IF NOT EXISTS leaves an existing table exactly as it was, so on
 * a database made by an earlier version a column only appears when migrate()
 * adds it. An index over that column therefore cannot live in SCHEMA: it would
 * run first, against a table that does not have the column yet, and every open
 * of every existing library would throw.
 */
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tracks_album   ON tracks(album_id, disc, no);
CREATE INDEX IF NOT EXISTS idx_albums_added   ON albums(present, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_albums_played  ON albums(present, last_played_at DESC);
CREATE INDEX IF NOT EXISTS idx_albums_artist  ON albums(present, sort_artist);
CREATE INDEX IF NOT EXISTS idx_albums_fave    ON albums(present, favourite);
CREATE INDEX IF NOT EXISTS idx_albums_version ON albums(version_of);
CREATE INDEX IF NOT EXISTS idx_plays_ts       ON plays(ts DESC);
CREATE INDEX IF NOT EXISTS idx_scrobbles_ts   ON scrobbles(tries, ts);
`;

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "musicd.db"));
  /* WAL so a scan writing rows does not block the web app reading them —
     browsing during the first scan is the normal case, not an edge case. */
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  db.exec(INDEXES);
  return db;
}

/*
 * Columns added after the first release.
 *
 * SQLite has no "ADD COLUMN IF NOT EXISTS", and CREATE TABLE IF NOT EXISTS
 * leaves an existing table exactly as it was — so a database made by an
 * earlier version keeps the old shape until something adds to it. Adding a
 * column is cheap and never rewrites rows, which is why this is worth doing in
 * place rather than asking anyone to start their history again.
 */
/*
 * The generation of tag-reading the scanner performs.
 *
 * Bump this whenever the scan starts reading something new out of a file. Every
 * track recorded under an older generation is re-read once, which is the only
 * way a new column ever gets a value — a file whose size and mtime have not
 * changed is otherwise never opened again.
 *
 *   1 — album, album artist, genre and year kept per track
 *   2 — the full release date, where the file gives one
 */
const TAG_SCHEMA = 2;

function migrate(db) {
  const add = (table, additions) => {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    for (const [name, type] of additions) {
      if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  };
  add("tracks", [
    ["albumartist", "TEXT NOT NULL DEFAULT ''"],
    ["album_tag", "TEXT NOT NULL DEFAULT ''"],
    ["genre", "TEXT NOT NULL DEFAULT ''"],
    ["year", "INTEGER"],
    ["release_date", "TEXT NOT NULL DEFAULT ''"],
    ["tags_read", "INTEGER NOT NULL DEFAULT 0"]
  ]);
  add("albums", [
    ["release_date", "TEXT NOT NULL DEFAULT ''"],
    ["favourite", "INTEGER NOT NULL DEFAULT 0"],
    ["version_of", "TEXT NOT NULL DEFAULT ''"],
    ["art_fetched", "TEXT NOT NULL DEFAULT ''"],
    ["title_edit", "TEXT NOT NULL DEFAULT ''"],
    ["artist_edit", "TEXT NOT NULL DEFAULT ''"],
    ["sort_title_edit", "TEXT NOT NULL DEFAULT ''"],
    ["sort_artist_edit", "TEXT NOT NULL DEFAULT ''"]
  ]);
}

/* ------------------------------------------------------------------ */
/*  The name an album is shown under                                   */
/* ------------------------------------------------------------------ */

/*
 * ONE PLACE DECIDES WHAT AN ALBUM IS CALLED.
 *
 * A correction the user typed wins over the tags, and an empty correction
 * means there is not one. That is two words of SQL, which is exactly why it
 * must not be written out at each of the eight queries that ask: 0.4.9 swapped
 * art for has_art in the transport's album query, updated one reader of three,
 * and Now playing, the Queue and the mini bar lost their artwork for two
 * releases. Where several call sites ask the same question, they ask it
 * through one thing.
 *
 * `alias` qualifies the columns for a query that names the table — pass "a"
 * for `FROM albums a`, and nothing at all when there is only one table in
 * scope.
 *
 * DELIBERATELY NOT USED BY lib/duplicates.js. Grouping copies of one record is
 * a match on what is on disk, and letting a typed name feed it would let a
 * rename silently fold two albums into one and MOVE the counters of the album
 * it demoted — which is not undone by typing the name back.
 */
function albumNames(alias = "") {
  const q = alias ? alias + "." : "";
  const pick = (edit, tag) => `COALESCE(NULLIF(${q}${edit}, ''), ${q}${tag})`;
  return {
    title: pick("title_edit", "title"),
    artist: pick("artist_edit", "artist"),
    sortTitle: pick("sort_title_edit", "sort_title"),
    sortArtist: pick("sort_artist_edit", "sort_artist")
  };
}

/* ------------------------------------------------------------------ */
/*  Play recording                                                     */
/* ------------------------------------------------------------------ */

/*
 * Which album a play belongs to.
 *
 * A record that is on disk twice is one album with one history — see
 * lib/duplicates.js — so a play of the deluxe edition is a play of the album,
 * and it is credited to the primary. Doing it HERE means every caller agrees
 * without having to know that versions exist.
 */
function headAlbum(db, albumId) {
  if (!albumId) return albumId;
  const row = db.prepare("SELECT version_of FROM albums WHERE id = ?").get(albumId);
  return (row && row.version_of) || albumId;
}

/* A play is recorded in two places at once: a row in `plays` (the history,
   which is what "recently played" reads) and a counter on the album or track
   (which is what the carousels and the six-month rule read). Doing it in one
   transaction is what keeps the two from drifting apart. */
function recordTrackPlay(db, trackId, albumId, ts = Date.now()) {
  const album = headAlbum(db, albumId);
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO plays (kind, ref, album_id, ts) VALUES ('track', ?, ?, ?)")
      .run(trackId, album, ts);
    db.prepare("UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE id = ?")
      .run(ts, trackId);
  });
  tx();
}

function recordAlbumPlay(db, albumId, ts = Date.now()) {
  const album = headAlbum(db, albumId);
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO plays (kind, ref, album_id, ts) VALUES ('album', ?, ?, ?)")
      .run(album, album, ts);
    db.prepare("UPDATE albums SET play_count = play_count + 1, last_played_at = ? WHERE id = ?")
      .run(ts, album);
  });
  tx();
}

module.exports = {
  open, albumKey, trackKey, headAlbum, albumNames,
  recordTrackPlay, recordAlbumPlay, TAG_SCHEMA
};
