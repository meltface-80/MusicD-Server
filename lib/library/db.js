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
-- What you corrected by hand. The music folders are read-only, so a fixed
-- title, artist, year or a found cover lives here, keyed by the album's
-- identity from its tags, and is laid over the scanned album on every load.
-- NULL means "as scanned".
CREATE TABLE IF NOT EXISTS album_edits (
  key         TEXT PRIMARY KEY,
  title       TEXT,
  artist      TEXT,
  year        INTEGER,
  art         BLOB,
  art_hash    TEXT,
  art_source  TEXT,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cache (
  ns     TEXT NOT NULL,
  key    TEXT NOT NULL,
  value  TEXT NOT NULL,
  ts     INTEGER NOT NULL,
  PRIMARY KEY (ns, key)
);
`;

// Bumped whenever SCHEMA changes in a way CREATE TABLE IF NOT EXISTS can't fix.
const SCHEMA_VERSION = 1;

// The columns each table must have, read from SCHEMA itself.
function expectedColumns() {
  const mem = new Database(":memory:");
  mem.exec(SCHEMA);
  const out = {};
  for (const { name } of mem.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    out[name] = mem.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name);
  }
  mem.close();
  return out;
}

// A database this build can't use: one written by another program (an older
// project that used the same volume name) whose tables lack columns ours
// need. Never our own file: a database from a NEWER version of this server
// (someone rolled the image back) is kept and used as it is.
function incompatible(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
  if (!tables.length) return false;                    // brand new file
  if (db.pragma("user_version", { simple: true }) >= SCHEMA_VERSION) return false;
  const want = expectedColumns();
  for (const [table, cols] of Object.entries(want)) {
    if (!tables.includes(table)) continue;
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    if (cols.some(c => !have.has(c))) return true;
  }
  return false;
}

// What is worth keeping from a database that has to be replaced: the things
// you did, not the things a scan can find again. Copied column by column
// where the old table has them.
const KEEP = ["album_edits", "plays", "settings"];
function carryOver(db, oldFile, log) {
  try {
    db.prepare("ATTACH DATABASE ? AS old").run(oldFile);
    const oldTables = new Set(db.prepare("SELECT name FROM old.sqlite_master WHERE type = 'table'").all().map(r => r.name));
    for (const t of KEEP) {
      if (!oldTables.has(t)) continue;
      const mine = db.prepare(`PRAGMA main.table_info(${t})`).all().map(c => c.name);
      const theirs = new Set(db.prepare(`PRAGMA old.table_info(${t})`).all().map(c => c.name));
      const cols = mine.filter(c => theirs.has(c));
      if (!cols.length) continue;
      const list = cols.join(", ");
      const n = db.prepare(`INSERT OR IGNORE INTO main.${t}(${list}) SELECT ${list} FROM old.${t}`).run().changes;
      if (n) log(`[musicd] kept ${n} ${t.replace("_", " ")} row(s) from the old database`);
    }
  } catch (e) {
    log(`[musicd] couldn't carry anything over from ${oldFile}: ${e.message}`);
  } finally {
    try { db.exec("DETACH DATABASE old"); } catch (e) { /* not attached */ }
  }
}

// ---- album edits, kept twice -------------------------------------------
// Hand edits are the one thing a rescan can't recreate, so besides the
// database they are written to album-edits.json in the same data folder
// after every change, and read back if the database ever starts without them.
const EDITS_FILE = "album-edits.json";

function exportEdits(db, dataDir) {
  const rows = db.prepare("SELECT * FROM album_edits").all().map(r => Object.assign({}, r, { art: r.art ? Buffer.from(r.art).toString("base64") : null }));
  const file = path.join(dataDir, EDITS_FILE);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, saved_at: Date.now(), edits: rows }));
  fs.renameSync(tmp, file);
}

function importEdits(db, dataDir, log) {
  const file = path.join(dataDir, EDITS_FILE);
  if (!fs.existsSync(file)) return 0;
  if (db.prepare("SELECT COUNT(*) AS n FROM album_edits").get().n) return 0;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { log(`[musicd] ${file} is unreadable: ${e.message}`); return 0; }
  const put = db.prepare(`INSERT OR IGNORE INTO album_edits(key, title, artist, year, art, art_hash, art_source, updated_at)
                          VALUES(@key, @title, @artist, @year, @art, @art_hash, @art_source, @updated_at)`);
  let n = 0;
  db.transaction(() => {
    for (const r of (doc && doc.edits) || []) {
      if (!r || !r.key) continue;
      n += put.run({
        key: r.key, title: r.title || null, artist: r.artist || null, year: r.year || null,
        art: r.art ? Buffer.from(r.art, "base64") : null, art_hash: r.art_hash || null,
        art_source: r.art_source || null, updated_at: r.updated_at || Date.now()
      }).changes;
    }
  })();
  if (n) log(`[musicd] restored ${n} album edit(s) from ${file}`);
  return n;
}

// Is the data folder a Docker volume (or bind mount)? If it isn't, it lives
// in the container and is thrown away with it — every edit and play with it.
// An anonymous volume (what Docker makes when the run command has no -v for
// /app/data) counts as not kept: the next container gets a new, empty one.
function onOwnMount(dir) {
  try {
    const real = fs.realpathSync(dir);
    const line = fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n")
      .find(l => (l.split(" ")[4] || "") === real);
    if (!line) return false;
    return !/\/volumes\/[0-9a-f]{64}\/_data$/.test(line.split(" ")[3] || "");
  } catch (e) { return null; }                       // not Linux: unknown
}

function open(dataDir, { log = console.log } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "musicd.db");
  const existed = fs.existsSync(file);
  let db = new Database(file);
  let aside = null;
  if (incompatible(db)) {
    db.close();
    aside = path.join(dataDir, `musicd.old-${Date.now()}.db`);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, aside + suffix);
    }
    log(`[musicd] ${file} was made by something else (another program or an older version); moved it to ${aside} and starting a fresh library`);
    db = new Database(file);
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  if (db.pragma("user_version", { simple: true }) < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
  if (aside) carryOver(db, aside, log);
  importEdits(db, dataDir, log);
  // Edits made before the backup file existed get one now.
  try {
    if (db.prepare("SELECT COUNT(*) AS n FROM album_edits").get().n && !fs.existsSync(path.join(dataDir, EDITS_FILE))) exportEdits(db, dataDir);
  } catch (e) { /* backup is best effort */ }

  const persistent = process.env.DOCKER === "1" ? onOwnMount(dataDir) : null;
  if (persistent === false) {
    log(`[musicd] WARNING: ${dataDir} is not a named Docker volume — the library, your album edits and play history ` +
        `are lost whenever this container is replaced. Add  -v musicd-server-data:${dataDir}  to the docker run command.`);
  }
  if (!existed) log(`[musicd] new database at ${file}`);

  const getSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
  const putSetting = db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const getCache = db.prepare("SELECT value, ts FROM cache WHERE ns = ? AND key = ?");
  const putCache = db.prepare("INSERT INTO cache(ns, key, value, ts) VALUES(?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, ts = excluded.ts");

  return {
    raw: db,
    dataDir,
    persistent,
    fresh: !existed || !!aside,
    backupEdits() {
      try { exportEdits(db, dataDir); } catch (e) { log(`[musicd] couldn't write ${EDITS_FILE}: ${e.message}`); }
    },
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

module.exports = { open, SCHEMA_VERSION };
