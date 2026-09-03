"use strict";

/*
 * Random Album Radio — the picker.
 *
 * Everything here is local: the radio chooses a row out of the library and
 * asks nothing of anybody. What is worth testing is what it REFUSES to pick,
 * because a radio that offers the record already playing, or a copy of it
 * under another name, or an album on a NAS that is not mounted, is a radio
 * that stops the music one way or another.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dbLib = require("../lib/db");
const settingsLib = require("../lib/settings");
const { createRadio, MAX_QUEUE } = require("../lib/radio");

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-radio-"));
  return { data: path.join(root, "data"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/* A library made by hand rather than scanned: this module only ever reads the
   albums table, and building the rows directly is what lets a test say
   "twenty jazz albums" without twenty folders of silence on disk. */
function rig(albums) {
  const ws = workspace();
  const db = dbLib.open(ws.data);
  const settings = settingsLib.open(db);
  const insert = db.prepare(
    `INSERT INTO albums (id, dir, title, artist, genre, track_count, added_at,
                         present, version_of)
     VALUES (@id, '', @title, @artist, @genre, @tracks, 0, @present, @versionOf)`);
  for (const a of albums) {
    insert.run({
      id: a.id, title: a.title, artist: a.artist || "Someone",
      genre: a.genre || "", tracks: a.tracks === undefined ? 10 : a.tracks,
      present: a.present === undefined ? 1 : a.present,
      versionOf: a.versionOf || ""
    });
  }
  return { ws, db, settings, radio: createRadio({ db, settings }) };
}

const SHELF = [
  { id: "a:1", title: "Spirit of Eden",  artist: "Talk Talk",      genre: "Art Rock" },
  { id: "a:2", title: "Laughing Stock",  artist: "Talk Talk",      genre: "Art Rock" },
  { id: "a:3", title: "Hex",             artist: "Bark Psychosis", genre: "art rock" },
  { id: "a:4", title: "Souvlaki",        artist: "Slowdive",       genre: "Shoegaze" },
  { id: "a:5", title: "Blue Train",      artist: "John Coltrane",  genre: "Jazz" }
];

/* ------------------------------------------------------------------ */
/*  The switches                                                       */
/* ------------------------------------------------------------------ */

test("the radio is off until somebody turns it on", () => {
  const r = rig(SHELF);
  try {
    /* A queue that grows on its own is a surprise, and a feature that
       surprises somebody who never asked for it is a bug however well it
       works. */
    assert.strictEqual(r.radio.status().enabled, false);
    assert.strictEqual(r.radio.wanted(), false, "and the poll loop does not even ask");
  } finally { r.ws.cleanup(); }
});

test("matching the genre is on once the radio is, and both are remembered", () => {
  const r = rig(SHELF);
  try {
    assert.strictEqual(r.radio.status().matchGenre, true, "what most people mean by radio");
    r.radio.setEnabled(true);
    r.radio.setMatchGenre(false);

    /* A second server on the same database — a restart — finds them as left. */
    const again = createRadio({ db: r.db, settings: r.settings });
    assert.deepStrictEqual(again.status(), { enabled: true, matchGenre: false });
  } finally { r.ws.cleanup(); }
});

test("the genre option survives the radio being turned off and on", () => {
  /* Turning the radio off hides the option; it must not also forget it, or
     coming back finds a setting nobody changed at a value nobody chose. */
  const r = rig(SHELF);
  try {
    r.radio.setEnabled(true);
    r.radio.setMatchGenre(false);
    r.radio.setEnabled(false);
    r.radio.setEnabled(true);
    assert.strictEqual(r.radio.status().matchGenre, false);
  } finally { r.ws.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  Picking                                                            */
/* ------------------------------------------------------------------ */

test("totally random means exactly that", () => {
  const r = rig(SHELF);
  try {
    /* With no genre asked for, every album in the library is reachable. Run it
       enough times that a picker stuck on one row cannot pass. */
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(r.radio.pick({}).id);
    assert.deepStrictEqual([...seen].sort(), ["a:1", "a:2", "a:3", "a:4", "a:5"]);
  } finally { r.ws.cleanup(); }
});

test("matching the genre keeps to it, whatever case the tag is in", () => {
  const r = rig(SHELF);
  try {
    /* "Art Rock" and "art rock" are one genre. "Art Rock" and "Rock" are two —
       matching those loosely would be a guess about what a genre MEANS, and
       this project does not guess. */
    for (let i = 0; i < 60; i++) {
      const pick = r.radio.pick({ genre: "Art Rock", exclude: ["a:1"] });
      assert.ok(["a:2", "a:3"].includes(pick.id), "picked " + pick.id + " for Art Rock");
    }
  } finally { r.ws.cleanup(); }
});

test("the album playing is never the album offered next", () => {
  const r = rig(SHELF);
  try {
    for (let i = 0; i < 100; i++) {
      assert.notStrictEqual(r.radio.pick({ exclude: ["a:4"] }).id, "a:4");
    }
  } finally { r.ws.cleanup(); }
});

test("everything already queued is excluded, not just what is playing", () => {
  /* An evening that keeps offering the record from two albums ago is a
     shuffle, not a radio. */
  const r = rig(SHELF);
  try {
    const pick = r.radio.pick({ exclude: ["a:1", "a:2", "a:3", "a:4"] });
    assert.strictEqual(pick.id, "a:5");
  } finally { r.ws.cleanup(); }
});

test("the only album left in a genre falls through to the whole library", () => {
  /*
   * The one jazz record in the house, with the genre option on. Keeping to the
   * genre would mean nothing to play, and silence is a worse answer to "keep
   * playing" than a record from somewhere else.
   */
  const r = rig(SHELF);
  try {
    const pick = r.radio.pick({ genre: "Jazz", exclude: ["a:5"] });
    assert.ok(pick, "something was found");
    assert.notStrictEqual(pick.genre, "Jazz");
  } finally { r.ws.cleanup(); }
});

test("an album with no genre tag is not stopped by the genre option", () => {
  const r = rig(SHELF);
  try {
    /* Nothing to match on, so the option has nothing to say and the radio
       carries on rather than going quiet. */
    const pick = r.radio.pick({ genre: "", exclude: ["a:1"] });
    assert.ok(pick && pick.id !== "a:1");
  } finally { r.ws.cleanup(); }
});

test("a version, an absent album and an empty folder are never picked", () => {
  const r = rig([
    { id: "a:keep", title: "The One", genre: "Rock" },
    /* The deluxe reissue of something already on the shelf: the same record,
       so offering it would play the same music twice under two names. */
    { id: "a:dupe", title: "The One (Deluxe Edition)", versionOf: "a:keep" },
    /* A NAS that was not mounted at the last scan. Queueing it would add a
       dozen tracks the speaker cannot fetch. */
    { id: "a:gone", title: "Missing", present: 0 },
    { id: "a:none", title: "Empty", tracks: 0 }
  ]);
  try {
    for (let i = 0; i < 100; i++) {
      assert.strictEqual(r.radio.pick({}).id, "a:keep");
    }
  } finally { r.ws.cleanup(); }
});

test("a library with nothing else in it offers nothing rather than a repeat", () => {
  const r = rig([{ id: "a:only", title: "The Only One" }]);
  try {
    assert.strictEqual(r.radio.pick({ exclude: ["a:only"] }), null);
  } finally { r.ws.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  When to add one                                                    */
/* ------------------------------------------------------------------ */

test("another album is due only once the last one has been reached", () => {
  const r = rig(SHELF);
  try {
    const A = "a:1", B = "a:2";
    /* Still tracks of another album to come: nothing to do. */
    assert.strictEqual(r.radio.atLastAlbum([{ albumId: B }, { albumId: B }], A), false);
    /* Everything left is the album playing — this is the last one. */
    assert.strictEqual(r.radio.atLastAlbum([{ albumId: A }, { albumId: A }], A), true);
    /* Nothing left at all. */
    assert.strictEqual(r.radio.atLastAlbum([], A), true);
    /* Something queued from the Sonos app. It is music still to come, and the
       radio has no business interrupting it. */
    assert.strictEqual(r.radio.atLastAlbum([{ albumId: null }], A), false);
  } finally { r.ws.cleanup(); }
});

test("a queue that is already enormous is left alone", () => {
  /* The backstop, not a limit anybody should meet: one album is added per
     album played, so this can only trigger if something else has been filling
     the queue — and there is no undo for a speaker with ten thousand tracks
     on it. */
  assert.ok(MAX_QUEUE >= 200 && MAX_QUEUE <= 2000, "a sane ceiling: " + MAX_QUEUE);
});
