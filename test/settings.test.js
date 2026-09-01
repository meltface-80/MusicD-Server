"use strict";

/*
 * The row order is the only thing here the user arranges rather than plays,
 * and it is read on every home screen. What matters is that it can never leave
 * somebody with a row missing: it is a preference, so a value that makes no
 * sense is repaired rather than refused.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dbLib = require("../lib/db");
const settingsLib = require("../lib/settings");

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-set-"));
  return { data: path.join(root, "data"),
           cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("the default order is every row the home screen can show", () => {
  assert.deepStrictEqual(settingsLib.DEFAULT_ROWS,
    ["favourites", "library", "random", "added", "played", "unplayed", "picks"]);
});

test("an arrangement is honoured", () => {
  const { normaliseRowOrder } = settingsLib;
  assert.deepStrictEqual(
    normaliseRowOrder(["picks", "favourites", "library", "random", "added", "played", "unplayed"]),
    ["picks", "favourites", "library", "random", "added", "played", "unplayed"]);
});

test("a partial arrangement keeps what it names and puts the rest back", () => {
  /* THE ONE THAT MATTERS FOR THE NEXT VERSION. A saved order written before a
     row existed does not mention it — and the row must appear, not vanish. */
  const { normaliseRowOrder, DEFAULT_ROWS } = settingsLib;
  const out = normaliseRowOrder(["picks", "library"]);
  assert.deepStrictEqual(out.slice(0, 2), ["picks", "library"], "what was asked for leads");
  assert.deepStrictEqual([...out].sort(), [...DEFAULT_ROWS].sort(), "and nothing is lost");
  assert.deepStrictEqual(out.slice(2), ["favourites", "random", "added", "played", "unplayed"],
    "the rest keep their order relative to each other");
});

test("nonsense is repaired rather than refused", () => {
  const { normaliseRowOrder, DEFAULT_ROWS } = settingsLib;
  for (const bad of [null, undefined, "picks", 7, {}, [], [null, 1, {}]]) {
    assert.deepStrictEqual(normaliseRowOrder(bad), DEFAULT_ROWS,
      JSON.stringify(bad) + " falls back to the default");
  }
  assert.deepStrictEqual(normaliseRowOrder(["nope", "picks", "gone"])[0], "picks",
    "a row that does not exist is dropped");
  const twice = normaliseRowOrder(["picks", "picks", "library"]);
  assert.strictEqual(twice.filter(k => k === "picks").length, 1, "and a repeat counts once");
  assert.strictEqual(twice.length, DEFAULT_ROWS.length);
});

test("the order is written to the database and read back", () => {
  const ws = workspace();
  const db = dbLib.open(ws.data);
  const store = settingsLib.open(db);

  assert.deepStrictEqual(settingsLib.rowOrder(store), settingsLib.DEFAULT_ROWS,
    "nothing saved means the default");
  settingsLib.setRowOrder(store, ["picks", "added"]);
  assert.deepStrictEqual(settingsLib.rowOrder(store).slice(0, 2), ["picks", "added"]);
  db.close();

  /* It lives in the library's own database, so it is the same on every phone
     and it comes back after a restart — the whole reason it is not in the
     browser's storage. */
  const again = dbLib.open(ws.data);
  assert.deepStrictEqual(settingsLib.rowOrder(settingsLib.open(again)).slice(0, 2),
    ["picks", "added"]);
  again.close();
  ws.cleanup();
});

test("a value corrupted outside the app does not break the home screen", () => {
  /* Hand-edited, or half-written when the power went. The default order is
     always a correct answer, and a home screen is not the place to report a
     parse error. */
  const ws = workspace();
  const db = dbLib.open(ws.data);
  const store = settingsLib.open(db);
  store.set(settingsLib.ROW_ORDER_KEY, "{not json");
  assert.deepStrictEqual(settingsLib.rowOrder(store), settingsLib.DEFAULT_ROWS);
  db.close();
  ws.cleanup();
});

test("the settings table appears on a database that never had one", () => {
  /* Opened by every version from here on, including one whose database was
     made before this table existed. */
  const ws = workspace();
  const first = dbLib.open(ws.data);
  first.exec("DROP TABLE IF EXISTS settings");
  first.close();

  const second = dbLib.open(ws.data);
  const store = settingsLib.open(second);
  settingsLib.setRowOrder(store, ["picks"]);
  assert.strictEqual(settingsLib.rowOrder(store)[0], "picks");
  second.close();
  ws.cleanup();
});
