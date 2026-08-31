"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dbLib = require("../lib/db");
const scanner = require("../lib/scanner");
const library = require("../lib/library");
const picks = require("../lib/picks");
const { buildLibrary } = require("./fixtures");

const DAY = 86400000;

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-test-"));
  return {
    music: path.join(root, "music"),
    data: path.join(root, "data"),
    art: path.join(root, "data", "cache", "art"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

async function scannedLibrary() {
  const ws = workspace();
  buildLibrary(ws.music);
  const db = dbLib.open(ws.data);
  await scanner.scan(db, [ws.music], { artDir: ws.art });
  return { ws, db };
}

test("an album is a folder, and a folder without audio is not an album", async () => {
  const { ws, db } = await scannedLibrary();
  const titles = db.prepare("SELECT title FROM albums ORDER BY title").all().map(r => r.title);
  assert.deepStrictEqual(titles, [
    "Field Recordings", "Hex", "Late Night Tales", "Laughing Stock", "Souvlaki", "Spirit of Eden"
  ]);
  assert.ok(!titles.includes("Artwork Scans"), "a folder of images is not an album");
  ws.cleanup();
});

test("untagged folders fall back to the folder name, index stripped", async () => {
  const { ws, db } = await scannedLibrary();
  const row = db.prepare("SELECT title, artist FROM albums WHERE title = 'Field Recordings'").get();
  assert.ok(row, "the untagged folder still became an album");
  assert.strictEqual(row.artist, "", "no artist was invented for it");
  ws.cleanup();
});

test("a folder whose tracks disagree about the artist is a compilation", async () => {
  const { ws, db } = await scannedLibrary();
  const row = db.prepare("SELECT artist FROM albums WHERE title = 'Late Night Tales'").get();
  assert.strictEqual(row.artist, "Various Artists");
  ws.cleanup();
});

test("cover.png in the folder becomes the album art", async () => {
  const { ws, db } = await scannedLibrary();
  const withArt = db.prepare("SELECT title, art FROM albums WHERE art <> '' ORDER BY title").all();
  assert.deepStrictEqual(withArt.map(r => r.title),
    ["Late Night Tales", "Laughing Stock", "Souvlaki", "Spirit of Eden"]);
  for (const row of withArt) assert.ok(fs.existsSync(row.art), row.art + " exists on disk");
  ws.cleanup();
});

test("a rescan re-parses nothing that has not changed", async () => {
  const { ws, db } = await scannedLibrary();
  const second = await scanner.scan(db, [ws.music], { artDir: ws.art });
  assert.strictEqual(second.parsed, 0, "no file was re-read");
  assert.strictEqual(second.reused, 21);
  ws.cleanup();
});

test("a rescan keeps added_at, play counts and last played", async () => {
  const { ws, db } = await scannedLibrary();
  const album = db.prepare("SELECT id, added_at FROM albums WHERE title = 'Souvlaki'").get();
  dbLib.recordAlbumPlay(db, album.id, Date.now() - DAY);
  db.prepare("UPDATE albums SET added_at = ? WHERE id = ?").run(1000, album.id);

  await scanner.scan(db, [ws.music], { artDir: ws.art });

  const after = db.prepare("SELECT added_at, play_count, last_played_at FROM albums WHERE id = ?").get(album.id);
  assert.strictEqual(after.added_at, 1000, "the date it was added did not move");
  assert.strictEqual(after.play_count, 1);
  assert.ok(after.last_played_at, "last played survived the rescan");
  ws.cleanup();
});

test("a library that disappears is marked absent, not deleted", async () => {
  const { ws, db } = await scannedLibrary();
  const album = db.prepare("SELECT id FROM albums WHERE title = 'Hex'").get();
  dbLib.recordAlbumPlay(db, album.id);

  fs.rmSync(path.join(ws.music, "Bark Psychosis"), { recursive: true, force: true });
  await scanner.scan(db, [ws.music], { artDir: ws.art });

  const gone = db.prepare("SELECT present, play_count FROM albums WHERE id = ?").get(album.id);
  assert.strictEqual(gone.present, 0, "marked absent");
  assert.strictEqual(gone.play_count, 1, "its history is still there");
  assert.strictEqual(library.library(db, 100).find(a => a.title === "Hex"), undefined,
    "and it is out of the browse rows");
  ws.cleanup();
});

test("recently added is newest first; recently played is most recent first", async () => {
  const { ws, db } = await scannedLibrary();
  const ids = db.prepare("SELECT id, title FROM albums ORDER BY title").all();
  ids.forEach((row, i) => db.prepare("UPDATE albums SET added_at = ? WHERE id = ?").run(1000 + i, row.id));

  const added = library.recentlyAdded(db, 10);
  assert.strictEqual(added[0].title, "Spirit of Eden", "the last one added is first");

  dbLib.recordAlbumPlay(db, ids[0].id, Date.now() - 2 * DAY);
  dbLib.recordAlbumPlay(db, ids[1].id, Date.now() - DAY);
  const played = library.recentlyPlayed(db, 10);
  assert.strictEqual(played.length, 2, "only albums that have been played");
  assert.strictEqual(played[0].title, ids[1].title, "most recent first");
  ws.cleanup();
});

test("not played in 6 months is empty on a fresh library", async () => {
  const { ws, db } = await scannedLibrary();
  assert.deepStrictEqual(library.notPlayedIn6Months(db, 50), [],
    "nothing can be six months old on a library scanned a moment ago");
  ws.cleanup();
});

test("not played in 6 months catches both long-ago plays and long-unplayed albums", async () => {
  const { ws, db } = await scannedLibrary();
  const old = Date.now() - 200 * DAY;
  const hex = db.prepare("SELECT id FROM albums WHERE title = 'Hex'").get().id;
  const stock = db.prepare("SELECT id FROM albums WHERE title = 'Laughing Stock'").get().id;

  db.prepare("UPDATE albums SET added_at = ? WHERE id = ?").run(old, hex);
  db.prepare("UPDATE albums SET added_at = ?, last_played_at = ? WHERE id = ?").run(old, old + DAY, stock);
  /* Added long ago but played last week: this one must NOT appear. */
  const souv = db.prepare("SELECT id FROM albums WHERE title = 'Souvlaki'").get().id;
  db.prepare("UPDATE albums SET added_at = ?, last_played_at = ? WHERE id = ?")
    .run(old, Date.now() - 7 * DAY, souv);

  const rows = library.notPlayedIn6Months(db, 50).map(a => a.title);
  assert.ok(rows.includes("Hex"), "never played and long in the library");
  assert.ok(rows.includes("Laughing Stock"), "played, but long ago");
  assert.ok(!rows.includes("Souvlaki"), "played last week, so not in this row");
  assert.strictEqual(rows[0], "Hex",
    "the longest gap comes first — never played since it arrived beats played a day later");
  ws.cleanup();
});

test("six months means six calendar months, not 180 days", () => {
  const june30 = new Date(2026, 5, 30, 12, 0, 0);
  const cutoff = new Date(library.sixMonthsAgo(june30));
  assert.strictEqual(cutoff.getFullYear(), 2025);
  assert.strictEqual(cutoff.getMonth(), 11, "December");
});

test("search finds albums, artists and tracks, and ignores a one-letter query", async () => {
  const { ws, db } = await scannedLibrary();
  /* A single letter matches most of a library and is never what was meant. */
  const empty = library.search(db, "a");
  assert.deepStrictEqual([empty.albums.length, empty.artists.length, empty.tracks.length], [0, 0, 0]);
  assert.deepStrictEqual(library.search(db, "  ").albums, [], "whitespace is not a query");

  const hits = library.search(db, "Talk");
  assert.deepStrictEqual(hits.albums.map(a => a.title).sort(), ["Laughing Stock", "Spirit of Eden"]);
  assert.deepStrictEqual(hits.artists.map(a => a.name), ["Talk Talk"]);

  const track = library.search(db, "Alison");
  assert.strictEqual(track.tracks[0].title, "Alison");
  assert.strictEqual(track.tracks[0].album, "Souvlaki");
  ws.cleanup();
});

test("an album carries its tracks in disc and track order", async () => {
  const { ws, db } = await scannedLibrary();
  const id = db.prepare("SELECT id FROM albums WHERE title = 'Spirit of Eden'").get().id;
  const album = library.album(db, id);
  assert.strictEqual(album.tracks.length, 6);
  assert.deepStrictEqual(album.tracks.map(t => t.no), [1, 2, 3, 4, 5, 6]);
  assert.strictEqual(album.tracks[0].title, "The Rainbow");
  assert.strictEqual(album.multiDisc, false);
  ws.cleanup();
});

/* ---------------------------------------------------------------- */
/*  Smart Picks                                                      */
/* ---------------------------------------------------------------- */

test("Smart Picks says what to do instead of showing an empty row", async () => {
  const { ws, db } = await scannedLibrary();
  const out = picks.build(db);
  assert.deepStrictEqual(out.picks, []);
  assert.match(out.note, /Play a few albums/);
  ws.cleanup();
});

test("Smart Picks follows what was played, and every pick says why", async () => {
  const { ws, db } = await scannedLibrary();
  const spirit = db.prepare("SELECT id FROM albums WHERE title = 'Spirit of Eden'").get().id;
  dbLib.recordAlbumPlay(db, spirit, Date.now() - 3 * DAY);

  const out = picks.build(db);
  assert.ok(out.picks.length, "playing an album produced picks");
  for (const pick of out.picks) {
    assert.ok(pick.reason, `${pick.title} explains itself`);
    assert.notStrictEqual(pick.id, spirit, "the seed is not offered back");
  }
  const stock = out.picks.find(p => p.title === "Laughing Stock");
  assert.ok(stock, "the other Talk Talk album is picked");
  assert.match(stock.reason, /More from Talk Talk/);
  ws.cleanup();
});

test("Smart Picks never offers an album with no connection to what was played", async () => {
  const { ws, db } = await scannedLibrary();
  dbLib.recordAlbumPlay(db,
    db.prepare("SELECT id FROM albums WHERE title = 'Spirit of Eden'").get().id, Date.now() - DAY);

  const titles = picks.build(db).picks.map(p => p.title);
  assert.ok(!titles.includes("Field Recordings"),
    "an untagged album shares no artist, genre or decade — being unplayed is not a reason");
  ws.cleanup();
});

test("Smart Picks offers one album per artist", async () => {
  const { ws, db } = await scannedLibrary();
  /* Two more Talk Talk folders would otherwise fill the row on their own. */
  const talk = db.prepare("SELECT id FROM albums WHERE artist = 'Talk Talk'").all();
  assert.ok(talk.length >= 2);
  dbLib.recordAlbumPlay(db, talk[0].id, Date.now() - DAY);

  const artists = picks.build(db).picks.map(p => p.artist);
  assert.strictEqual(new Set(artists).size, artists.length, "no artist appears twice");
  ws.cleanup();
});

test("Smart Picks does not offer back something played last week", async () => {
  const { ws, db } = await scannedLibrary();
  const spirit = db.prepare("SELECT id FROM albums WHERE title = 'Spirit of Eden'").get().id;
  const stock  = db.prepare("SELECT id FROM albums WHERE title = 'Laughing Stock'").get().id;
  dbLib.recordAlbumPlay(db, spirit, Date.now() - 30 * DAY);
  dbLib.recordAlbumPlay(db, stock,  Date.now() - 2 * DAY);

  const titles = picks.build(db).picks.map(p => p.title);
  assert.ok(!titles.includes("Laughing Stock"), "played two days ago, so not a pick");
  ws.cleanup();
});

test("play counts are kept for albums and tracks separately", async () => {
  const { ws, db } = await scannedLibrary();
  const album = db.prepare("SELECT id FROM albums WHERE title = 'Souvlaki'").get().id;
  const tracks = db.prepare("SELECT id FROM tracks WHERE album_id = ?").all(album);

  dbLib.recordTrackPlay(db, tracks[0].id, album);
  dbLib.recordTrackPlay(db, tracks[0].id, album);
  dbLib.recordTrackPlay(db, tracks[1].id, album);
  dbLib.recordAlbumPlay(db, album);

  assert.strictEqual(db.prepare("SELECT play_count FROM tracks WHERE id = ?").get(tracks[0].id).play_count, 2);
  assert.strictEqual(db.prepare("SELECT play_count FROM tracks WHERE id = ?").get(tracks[1].id).play_count, 1);
  assert.strictEqual(db.prepare("SELECT play_count FROM albums WHERE id = ?").get(album).play_count, 1);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM plays").get().n, 4, "the history keeps every play");
  ws.cleanup();
});
