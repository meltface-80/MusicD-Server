"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const DB = require("../lib/library/db");
const { Library } = require("../lib/library");

const quiet = () => {};

test("a database left in the volume by another program is moved aside, not crashed on", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-db-"));
  const old = new Database(path.join(dir, "musicd.db"));
  old.exec("CREATE TABLE tracks (id INTEGER PRIMARY KEY, path TEXT, title TEXT); INSERT INTO tracks(path, title) VALUES('x', 'y');");
  old.exec("CREATE TABLE albums (id INTEGER PRIMARY KEY, title TEXT);");
  old.close();

  const db = DB.open(dir, { log: quiet });
  assert.doesNotThrow(() => new Library(db, { musicRoot: dir, log: quiet }));
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM tracks").get().n, 0);
  assert.equal(db.raw.pragma("user_version", { simple: true }), DB.SCHEMA_VERSION);
  db.close();
  assert.ok(fs.readdirSync(dir).some(f => /^musicd\.old-\d+\.db$/.test(f)));
});

test("our own database is kept across restarts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-db-"));
  let db = DB.open(dir, { log: quiet });
  db.setSetting("k", 42);
  db.close();
  db = DB.open(dir, { log: quiet });
  assert.equal(db.setting("k"), 42);
  db.close();
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes("old")), []);
});
