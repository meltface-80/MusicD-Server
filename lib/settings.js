/*
 * MusicD Server — the handful of things the user arranged rather than the
 * files.
 *
 * One key/value table, and at the moment one key in it: the order of the home
 * screen's rows. It lives in the DATABASE rather than in the phone's storage
 * because it is a property of the library, not of the phone looking at it —
 * arrange the rows once and every phone in the house agrees, a reinstalled
 * shortcut remembers, and it survives an update for the same reason the play
 * history does.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

/*
 * Every row the home screen can show, in the order it shows them until
 * somebody says otherwise.
 *
 * This list is the authority on which rows EXIST. A saved order is only ever a
 * rearrangement of it: a key that is not here is dropped, and a key here that
 * the saved order does not mention is put back where it started. That is what
 * lets a later version add a row without it vanishing for everybody who had
 * already arranged theirs.
 */
const DEFAULT_ROWS = ["favourites", "library", "random", "added", "played", "unplayed", "picks"];

const ROW_ORDER_KEY = "home.rowOrder";

function open(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  return {
    get: (key) => {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
      return row ? row.value : null;
    },
    set: (key, value) => {
      db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(key, String(value));
    }
  };
}

/*
 * Make a usable order out of whatever was asked for.
 *
 * Never rejects. A row order is a preference, and the worst thing it can do is
 * leave somebody with a home screen missing a row because a name was misspelt
 * or a version moved on — so anything unrecognised is dropped, anything
 * missing is appended in its default position, and duplicates count once.
 */
function normaliseRowOrder(wanted) {
  const known = new Set(DEFAULT_ROWS);
  const seen = new Set();
  const order = [];
  for (const key of Array.isArray(wanted) ? wanted : []) {
    const name = String(key || "");
    if (known.has(name) && !seen.has(name)) { seen.add(name); order.push(name); }
  }
  /* Whatever was not mentioned keeps its default place relative to the rest,
     which is what makes a row added by a later version appear rather than
     disappear. */
  for (const key of DEFAULT_ROWS) if (!seen.has(key)) order.push(key);
  return order;
}

function rowOrder(store) {
  let saved = null;
  try { saved = JSON.parse(store.get(ROW_ORDER_KEY) || "null"); }
  catch {
    /* Somebody edited the database by hand, or a half-written value survived a
       crash. The default order is always a correct answer. */
    saved = null;
  }
  return normaliseRowOrder(saved);
}

function setRowOrder(store, wanted) {
  const order = normaliseRowOrder(wanted);
  store.set(ROW_ORDER_KEY, JSON.stringify(order));
  return order;
}

module.exports = { open, rowOrder, setRowOrder, normaliseRowOrder, DEFAULT_ROWS, ROW_ORDER_KEY };
