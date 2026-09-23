"use strict";
/*
 * Nothing you did is lost, and nothing is read again from scratch, when the
 * container is replaced or updated: moved mounts are recognised, a drive that
 * isn't mounted keeps its albums, and album edits come back even if the
 * database itself has to start over.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { haveFfmpeg, makeLibrary } = require("./fixtures");
const DB = require("../lib/library/db");
const { Library } = require("../lib/library");
const { Scanner } = require("../lib/library/scanner");

const skip = !haveFfmpeg() && "ffmpeg is not installed";
const quiet = () => {};

function open(data, root) {
  const db = DB.open(data, { log: quiet });
  const library = new Library(db, { musicRoot: root, log: quiet });
  const scanner = new Scanner({ db, root, log: quiet });
  return { db, library, scanner };
}
const byTitle = (lib, t) => lib.albums.find(a => a.scanned.title === t);

test("a moved music mount keeps every album, id and edit, and reads no file again", { skip }, async () => {
  const lib = makeLibrary();
  let s = open(lib.data, lib.music);
  await s.scanner.scan();
  s.library.reload();
  const before = s.library.albums.map(a => [a.scanned.title, a.id]).sort();
  s.library.saveEdit(byTitle(s.library, "Album One").id, { title: "Album One (fixed)", year: 1999 });
  s.db.close();

  // /music  →  /music/4tb, as when a second drive is added.
  const root = path.join(lib.root, "mroot");
  fs.mkdirSync(root);
  fs.renameSync(lib.music, path.join(root, "4tb"));
  s = open(lib.data, root);
  s.library.reload();
  assert.equal(s.library.count, 3, "albums are there before any scan");
  const r = await s.scanner.scan();
  s.library.reload();
  assert.equal(s.scanner.state.parsed, 0, "no file read again");
  assert.equal(r.relocated, 7);
  assert.equal(r.removed, 0);
  assert.deepEqual(s.library.albums.map(a => [a.scanned.title, a.id]).sort(), before);
  const one = byTitle(s.library, "Album One");
  assert.equal(one.title, "Album One (fixed)");
  assert.equal(one.year, 1999);
  assert.ok(s.library.tracks(one.id).every(t => t.path.startsWith(path.join(root, "4tb"))));
  s.db.close();
});

test("a drive that isn't mounted keeps its albums until it's back", { skip }, async () => {
  const lib = makeLibrary();
  const root = path.join(lib.root, "mroot");
  fs.mkdirSync(path.join(root, "2tb"), { recursive: true });
  fs.renameSync(lib.music, path.join(root, "4tb"));
  fs.renameSync(path.join(root, "4tb", "Artist B"), path.join(root, "2tb", "Artist B"));
  let s = open(lib.data, root);
  await s.scanner.scan();

  // The 2tb drive isn't there: Docker still shows its mount point, empty.
  const stash = path.join(lib.root, "stash");
  fs.renameSync(path.join(root, "2tb"), stash);
  fs.mkdirSync(path.join(root, "2tb"));
  let r = await s.scanner.scan();
  s.library.reload();
  assert.equal(r.removed, 0);
  assert.equal(r.kept_offline, 2);
  assert.ok(byTitle(s.library, "Hi Res"), "Hi Res is still in the library");

  // Nothing at all mounted: everything kept.
  const stash4 = path.join(lib.root, "stash4");
  fs.renameSync(path.join(root, "4tb"), stash4);
  fs.mkdirSync(path.join(root, "4tb"));
  r = await s.scanner.scan();
  assert.equal(r.removed, 0);
  assert.equal(s.db.raw.prepare("SELECT COUNT(*) n FROM tracks").get().n, 7);

  // Back again: nothing to read.
  fs.rmdirSync(path.join(root, "2tb")); fs.renameSync(stash, path.join(root, "2tb"));
  fs.rmdirSync(path.join(root, "4tb")); fs.renameSync(stash4, path.join(root, "4tb"));
  const parsedBefore = 0;
  r = await s.scanner.scan();
  assert.equal(r.status, "unchanged");
  assert.equal(s.scanner.state.parsed, parsedBefore);

  // A folder really deleted (not an empty mount point) is removed.
  fs.rmSync(path.join(root, "2tb", "Artist B"), { recursive: true });
  fs.writeFileSync(path.join(root, "2tb", "readme.txt"), "not music");
  r = await s.scanner.scan();
  assert.equal(r.removed, 2);
  s.db.close();
});

test("album edits come back when the database has to start over", { skip }, async () => {
  const lib = makeLibrary();
  let s = open(lib.data, lib.music);
  await s.scanner.scan();
  s.library.reload();
  s.library.saveEdit(byTitle(s.library, "Hi Res").id, { artist: "Artist B (fixed)", art: { buf: Buffer.from("x"), source: "Deezer" } });
  s.db.close();
  assert.ok(fs.existsSync(path.join(lib.data, "album-edits.json")));

  for (const f of fs.readdirSync(lib.data)) if (f.startsWith("musicd.db")) fs.rmSync(path.join(lib.data, f));
  s = open(lib.data, lib.music);
  await s.scanner.scan();
  s.library.reload();
  const hr = byTitle(s.library, "Hi Res");
  assert.equal(hr.artist, "Artist B (fixed)");
  assert.equal(hr.customArt, true);
  assert.equal(String(s.library.editedArt(hr.id)), "x");
  s.db.close();
});

test("a database that has to be replaced hands over edits, plays and settings", () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "musicd-db-"));
  const old = new Database(path.join(dir, "musicd.db"));
  old.exec(`CREATE TABLE tracks (id INTEGER PRIMARY KEY, path TEXT);
            CREATE TABLE album_edits (key TEXT PRIMARY KEY, title TEXT, artist TEXT, year INTEGER, art BLOB, art_hash TEXT, art_source TEXT, updated_at INTEGER NOT NULL);
            INSERT INTO album_edits(key, title, updated_at) VALUES('a\u0001b', 'Fixed', 1);
            CREATE TABLE plays (id INTEGER PRIMARY KEY, album_id INTEGER, title TEXT, ts INTEGER NOT NULL);
            INSERT INTO plays(album_id, title, ts) VALUES(4, 'x', 5);
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO settings VALUES('fanartKey', '"k"');`);
  old.close();
  const db = DB.open(dir, { log: quiet });
  assert.equal(db.raw.prepare("SELECT title FROM album_edits").get().title, "Fixed");
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM plays").get().n, 1);
  assert.equal(db.setting("fanartKey"), "k");
  db.close();
});

test("a database from a newer version is used, never moved aside", () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "musicd-db-"));
  let db = DB.open(dir, { log: quiet });
  db.setSetting("k", 1);
  db.raw.pragma(`user_version = ${DB.SCHEMA_VERSION + 5}`);
  db.close();
  db = DB.open(dir, { log: quiet });
  assert.equal(db.setting("k"), 1);
  db.close();
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes("old")), []);
});

test("an album is found by its edited names, its scanned names, and a title of punctuation", () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "musicd-db-"));
  const db = DB.open(dir, { log: quiet });
  const ins = db.raw.prepare("INSERT INTO albums(key, title, artist, added_at, updated_at) VALUES(?, ?, ?, 1, 1)");
  ins.run("sigur ros\u0001", "( )", "Sigur Rós");
  ins.run("sigur ros\u0001takk", "Takk...", "Sigur Rós");
  ins.run("x\u0001old", "Old Name", "X");
  const library = new Library(db, { log: quiet });
  library.reload();
  assert.equal(library.relocate("( )", "Sigur Rós").title, "( )");
  const x = library.albums.find(a => a.title === "Old Name");
  library.saveEdit(x.id, { title: "New Name", artist: "Y", year: 2001 });
  assert.equal(library.relocate("New Name", "Y").id, x.id);
  assert.equal(library.relocate("Old Name", "X").id, x.id);
  assert.equal(library.relocate("Old Name", "X").year, 2001);
  db.close();
});
