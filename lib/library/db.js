"use strict";
/*
 * db.js — the server's one SQLite file.
 *
 * Everything the server learns lives here: the library as scanned from disk,
 * play history, settings, and the caches for things fetched from outside
 * (write-ups, reviews, waveforms). It sits in the data volume, so a rebuilt
 * container carries all of it over.
 */
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS albums (
  id            INTEGER PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  artist        TEXT NOT NULL,
  sort_title    TEXT NOT NULL DEFAULT '',
  sort_artist   TEXT NOT NULL DEFAULT '',
  year          INTEGER,
  label         TEXT,
  genres        TEXT NOT NULL DEFAULT '[]',
  dir           TEXT NOT NULL DEFAULT '',
  art_path      TEXT,
  art_embedded  TEXT,
  art_hash      TEXT,
  track_count   INTEGER NOT NULL DEFAULT 0,
  duration      REAL NOT NULL DEFAULT 0,
  max_rate      INTEGER,
  max_bits      INTEGER,
  lossless      INTEGER NOT NULL DEFAULT 1,
  container     TEXT,
  compilation   INTEGER NOT NULL DEFAULT 0,
  added_at      INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tracks (
  id            INTEGER PRIMARY KEY,
  album_id      INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  path          TEXT NOT NULL UNIQUE,
  mtime         INTEGER NOT NULL,
  size          INTEGER NOT NULL,
  title         TEXT NOT NULL,
  artist        TEXT NOT NULL DEFAULT '',
  album_artist  TEXT NOT NULL DEFAULT '',
  album         TEXT NOT NULL DEFAULT '',
  track_no      INTEGER,
  disc_no       INTEGER,
  duration      REAL NOT NULL DEFAULT 0,
  codec         TEXT,
  container     TEXT,
  sample_rate   INTEGER,
  bits          INTEGER,
  channels      INTEGER,
  lossless      INTEGER NOT NULL DEFAULT 0,
  year          INTEGER,
  label         TEXT,
  genres        TEXT NOT NULL DEFAULT '[]',
  has_picture   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tracks_album ON tracks(album_id);
CREATE TABLE IF NOT EXISTS plays (
  id        INTEGER PRIMARY KEY,
  album_id  INTEGER,
  track_id  INTEGER,
  title     TEXT,
  artist    TEXT,
  album     TEXT,
  zone      TEXT,
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plays_album ON plays(album_id);
CREATE INDEX IF NOT EXISTS plays_ts ON plays(ts);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cache (
  ns     TEXT NOT NULL,
  key    TEXT NOT NULL,
  value  TEXT NOT NULL,
  ts     INTEGER NOT NULL,
  PRIMARY KEY (ns, key)
);
`;

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "musicd.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);

  const getSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
  const putSetting = db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const getCache = db.prepare("SELECT value, ts FROM cache WHERE ns = ? AND key = ?");
  const putCache = db.prepare("INSERT INTO cache(ns, key, value, ts) VALUES(?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, ts = excluded.ts");

  return {
    raw: db,
    setting(key, fallback) {
      const r = getSetting.get(key);
      if (!r) return fallback;
      try { return JSON.parse(r.value); } catch (e) { return fallback; }
    },
    setSetting(key, value) { putSetting.run(key, JSON.stringify(value)); },
    cacheGet(ns, key, maxAgeMs) {
      const r = getCache.get(ns, key);
      if (!r) return undefined;
      if (maxAgeMs && Date.now() - r.ts > maxAgeMs) return undefined;
      try { return JSON.parse(r.value); } catch (e) { return undefined; }
    },
    cachePut(ns, key, value) { putCache.run(ns, key, JSON.stringify(value), Date.now()); },
    close() { db.close(); }
  };
}

module.exports = { open };
