"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dbLib = require("../lib/db");
const scanner = require("../lib/scanner");
const library = require("../lib/library");
const duplicates = require("../lib/duplicates");
const match = require("../lib/match");
const { wav } = require("./fixtures");

/* ------------------------------------------------------------------ */
/*  Matching — pure strings, no database                               */
/* ------------------------------------------------------------------ */

test("an edition marker comes off the title, whatever brackets it wears", () => {
  const cases = [
    ["Kid A (Deluxe Edition)", "Kid A", "Deluxe Edition"],
    ["Kid A [Deluxe]", "Kid A", "Deluxe"],
    ["Abbey Road - 2019 Remaster", "Abbey Road", "2019 Remaster"],
    ["Nevermind (20th Anniversary Super Deluxe Edition)", "Nevermind",
     "20th Anniversary Super Deluxe Edition"],
    ["Songs (Bonus Track Version)", "Songs", "Bonus Track Version"],
    ["Pet Sounds (Mono)", "Pet Sounds", "Mono"]
  ];
  for (const [title, base, edition] of cases) {
    const split = match.splitEdition(title);
    assert.strictEqual(split.base, base, title);
    assert.deepStrictEqual(split.editions, [edition], title);
  }
});

/*
 * The direction that matters. Folding two records into one loses an album;
 * failing to fold two copies leaves a duplicate on the shelf. So anything the
 * vocabulary does not recognise is part of the title, and these are the shapes
 * that would be lost if it guessed the other way.
 */
test("a bracket that is not an edition stays part of the title", () => {
  for (const title of [
    "Live at Leeds", "Homework (Instrumental)", "Blue Lines (feat. Someone)",
    "MTV Unplugged (Live)", "The Beatles (White Album)", "OK Computer [OKNOTOK 1997 2017]",
    "Music for Airports (Ambient 1)"
  ]) {
    assert.deepStrictEqual(match.splitEdition(title).editions, [], title);
    assert.strictEqual(match.splitEdition(title).base, title, title);
  }
});

test("a title that is ONLY an edition word keeps its own name", () => {
  /* "Deluxe" is a Better Than Ezra record. Emptying it would fold it into
     every other album whose title normalised to nothing. */
  assert.strictEqual(match.splitEdition("Deluxe").base, "Deluxe");
  assert.deepStrictEqual(match.splitEdition("Deluxe").editions, []);
  assert.strictEqual(match.groupKey("Better Than Ezra", "Deluxe"),
                     match.groupKey("Better Than Ezra", "Deluxe (Remastered)"));
});

test("stylised artist names fold onto one identity", () => {
  assert.strictEqual(match.artistKey("P!nk"), match.artistKey("Pink"));
  assert.strictEqual(match.artistKey("AC/DC"), match.artistKey("ACDC"));
  assert.strictEqual(match.artistKey("Björk"), match.artistKey("Bjork"));
  assert.notStrictEqual(match.artistKey("Weezer"), match.artistKey("Wheezer"));
});

test("a group key needs both an artist and a title worth matching on", () => {
  assert.strictEqual(match.groupKey("", "Kid A"), "");
  assert.strictEqual(match.groupKey("Radiohead", "!!!"), "");
  assert.ok(match.groupKey("Radiohead", "Kid A"));
});

test("track overlap is measured against the shorter list", () => {
  const standard = ["One", "Two", "Three"];
  const deluxe = ["one", "two", "three", "Demo", "Live"];
  /* Against the union this is 0.6 and would sit on the threshold; against the
     shorter list a standard edition wholly inside a deluxe one scores 1. */
  assert.strictEqual(match.tracklistOverlap(standard, deluxe), 1);
  assert.ok(match.sameRecord(standard, deluxe));
  assert.ok(!match.sameRecord(standard, ["Alpha", "Beta", "Gamma"]));
});

/* ------------------------------------------------------------------ */
/*  Folding — against a real scanned library                           */
/* ------------------------------------------------------------------ */

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-dupe-"));
  return {
    music: path.join(root, "music"),
    data: path.join(root, "data"),
    art: path.join(root, "data", "cache", "art"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

/* One folder of real WAVs with real tags — the scanner has to read them for
   the grouping to see anything, so a stub would prove nothing. */
function putAlbum(root, dir, { album, artist, year, tracks }) {
  const full = path.join(root, dir);
  fs.mkdirSync(full, { recursive: true });
  tracks.forEach((title, i) => {
    fs.writeFileSync(path.join(full, `${String(i + 1).padStart(2, "0")} ${title}.wav`),
      wav({ seconds: 1, title, artist, album, albumArtist: artist, year, track: i + 1 }));
  });
}

const STANDARD = ["Alison", "Machine Gun", "40 Days"];
const DELUXE = [...STANDARD, "Missing You", "Country Rain"];

async function twoVersions(extra) {
  const ws = workspace();
  putAlbum(ws.music, "Slowdive/Souvlaki",
    { album: "Souvlaki", artist: "Slowdive", year: 1993, tracks: STANDARD });
  putAlbum(ws.music, "Slowdive/Souvlaki (Deluxe Edition)",
    { album: "Souvlaki (Deluxe Edition)", artist: "Slowdive", year: 2005, tracks: DELUXE });
  if (extra) extra(ws);
  const db = dbLib.open(ws.data);
  await scanner.scan(db, [ws.music], { artDir: ws.art });
  duplicates.regroup(db);
  return { ws, db };
}

const idOf = (db, title) =>
  db.prepare("SELECT id FROM albums WHERE title = ?").get(title).id;

test("a deluxe edition becomes a version of the album, not a second album", async () => {
  const { ws, db } = await twoVersions();
  const titles = library.library(db, 50).map(a => a.title);
  assert.deepStrictEqual(titles, ["Souvlaki"], "only the primary is on the shelf");

  const versions = db.prepare(
    "SELECT title, version_of FROM albums ORDER BY title").all();
  assert.strictEqual(versions.find(v => v.title === "Souvlaki").version_of, "");
  assert.strictEqual(versions.find(v => v.title === "Souvlaki (Deluxe Edition)").version_of,
                     idOf(db, "Souvlaki"));
  ws.cleanup();
});

test("the primary is the one without the edition marker, even when it is smaller", async () => {
  const { ws, db } = await twoVersions();
  const shelf = library.library(db, 50)[0];
  /* The deluxe has five tracks to the standard's three, so any "fullest copy
     wins" rule would pick it. The user's rule is the plain title. */
  assert.strictEqual(shelf.title, "Souvlaki");
  assert.strictEqual(shelf.trackCount, 3);
  ws.cleanup();
});

test("the album screen carries a tab for each version, primary first", async () => {
  const { ws, db } = await twoVersions();
  const album = library.album(db, idOf(db, "Souvlaki"));
  assert.strictEqual(album.versions.length, 2);
  assert.deepStrictEqual(album.versions.map(v => v.label), ["Standard", "Deluxe Edition"]);
  assert.strictEqual(album.versions[0].primary, true);
  assert.strictEqual(album.selected, album.id);
  assert.deepStrictEqual(album.tracks.map(t => t.title), STANDARD);
  ws.cleanup();
});

test("asking for a version returns the same album with that version's tracks", async () => {
  const { ws, db } = await twoVersions();
  const deluxeId = idOf(db, "Souvlaki (Deluxe Edition)");
  const album = library.album(db, deluxeId);
  /* The record's identity comes from the primary — same id, same title, same
     heart — so the screen is the album whichever tab opened it. */
  assert.strictEqual(album.id, idOf(db, "Souvlaki"));
  assert.strictEqual(album.title, "Souvlaki");
  assert.strictEqual(album.selected, deluxeId);
  assert.deepStrictEqual(album.tracks.map(t => t.title), DELUXE);
  assert.strictEqual(album.trackCount, 5);
  ws.cleanup();
});

test("an album with one copy has no version tabs at all", async () => {
  const ws = workspace();
  putAlbum(ws.music, "Slowdive/Souvlaki",
    { album: "Souvlaki", artist: "Slowdive", year: 1993, tracks: STANDARD });
  const db = dbLib.open(ws.data);
  await scanner.scan(db, [ws.music], { artDir: ws.art });
  duplicates.regroup(db);
  const album = library.album(db, idOf(db, "Souvlaki"));
  assert.strictEqual(album.versions, undefined, "one version is not a version");
  ws.cleanup();
});

/*
 * The failure the track-title check exists to prevent.
 *
 * Weezer made four albums called "Weezer". Grouping on artist and title alone
 * turns them into one album and loses three, which is far worse than leaving a
 * duplicate on the shelf.
 */
test("two different albums with the same name stay two albums", async () => {
  const ws = workspace();
  putAlbum(ws.music, "Weezer/Weezer (Blue Album)",
    { album: "Weezer", artist: "Weezer", year: 1994,
      tracks: ["My Name Is Jonas", "Buddy Holly", "Undone"] });
  putAlbum(ws.music, "Weezer/Weezer (Green Album)",
    { album: "Weezer", artist: "Weezer", year: 2001,
      tracks: ["Don't Let Go", "Photograph", "Hash Pipe"] });
  const db = dbLib.open(ws.data);
  await scanner.scan(db, [ws.music], { artDir: ws.art });
  duplicates.regroup(db);
  assert.strictEqual(library.library(db, 50).length, 2, "both albums are still there");
  ws.cleanup();
});

test("history follows the album when a version is folded in", async () => {
  const { ws, db } = await twoVersions();
  const primary = idOf(db, "Souvlaki");
  const deluxe = idOf(db, "Souvlaki (Deluxe Edition)");

  /* Played BEFORE the fold — which is what happens on an upgrade: the plays
     are already on the row that is about to become a version. */
  db.prepare("UPDATE albums SET version_of = '', play_count = 3, last_played_at = 5000 WHERE id = ?")
    .run(deluxe);
  db.prepare("INSERT INTO plays (kind, ref, album_id, ts) VALUES ('album', ?, ?, 5000)")
    .run(deluxe, deluxe);

  duplicates.regroup(db);

  const head = db.prepare("SELECT play_count, last_played_at FROM albums WHERE id = ?").get(primary);
  assert.strictEqual(head.play_count, 3);
  assert.strictEqual(head.last_played_at, 5000);
  const donor = db.prepare("SELECT play_count, last_played_at FROM albums WHERE id = ?").get(deluxe);
  assert.strictEqual(donor.play_count, 0, "the counters MOVED rather than being copied");
  assert.strictEqual(donor.last_played_at, null);
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) n FROM plays WHERE album_id = ?").get(primary).n, 1);
  ws.cleanup();
});

/*
 * The bug this shape of code always has: regroup runs on every scan, so
 * anything it COPIES is counted again every six hours forever. The counters
 * are moved and the donor zeroed precisely so that running it twice changes
 * nothing.
 */
test("regrouping twice does not count the same plays twice", async () => {
  const { ws, db } = await twoVersions();
  const primary = idOf(db, "Souvlaki");
  const deluxe = idOf(db, "Souvlaki (Deluxe Edition)");
  db.prepare("UPDATE albums SET version_of = '', play_count = 4, last_played_at = 9000 WHERE id = ?")
    .run(deluxe);

  duplicates.regroup(db);
  duplicates.regroup(db);
  duplicates.regroup(db);

  assert.strictEqual(
    db.prepare("SELECT play_count FROM albums WHERE id = ?").get(primary).play_count, 4);
  ws.cleanup();
});

test("a play of a version is a play of the album", async () => {
  const { ws, db } = await twoVersions();
  const primary = idOf(db, "Souvlaki");
  const deluxe = idOf(db, "Souvlaki (Deluxe Edition)");
  const bonus = db.prepare(
    "SELECT id FROM tracks WHERE album_id = ? AND title = 'Missing You'").get(deluxe);

  dbLib.recordTrackPlay(db, bonus.id, deluxe, 12345);
  dbLib.recordAlbumPlay(db, deluxe, 12345);

  const head = db.prepare("SELECT play_count, last_played_at FROM albums WHERE id = ?").get(primary);
  assert.strictEqual(head.play_count, 1, "the album was played, not a second album");
  assert.strictEqual(head.last_played_at, 12345);
  assert.deepStrictEqual(library.recentlyPlayed(db, 10).map(a => a.title), ["Souvlaki"]);
  /* The track keeps its own count — it is a real track that was really played. */
  assert.strictEqual(
    db.prepare("SELECT play_count FROM tracks WHERE id = ?").get(bonus.id).play_count, 1);
  ws.cleanup();
});

test("a heart tapped on a version tab lands on the album", async () => {
  const { ws, db } = await twoVersions();
  const deluxe = idOf(db, "Souvlaki (Deluxe Edition)");
  const result = library.setFavourite(db, deluxe, true);
  assert.strictEqual(result.id, idOf(db, "Souvlaki"));
  assert.deepStrictEqual(library.favourites(db, 10).map(a => a.title), ["Souvlaki"]);
  assert.strictEqual(library.favouriteCount(db), 1);
  ws.cleanup();
});

test("a version is not a second album anywhere a count is shown", async () => {
  const { ws, db } = await twoVersions();
  const stats = library.stats(db);
  assert.strictEqual(stats.albums, 1);
  assert.strictEqual(stats.tracks, STANDARD.length, "the version's files are not counted twice");
  assert.deepStrictEqual(library.search(db, "Souvlaki").albums.map(a => a.title), ["Souvlaki"]);
  assert.deepStrictEqual(library.byArtist(db, "Slowdive").albums.map(a => a.title), ["Souvlaki"]);
  assert.deepStrictEqual(library.artists(db).map(a => a.albums), [1]);
  ws.cleanup();
});

test("a version that goes missing hands its history back", async () => {
  const { ws, db } = await twoVersions();
  const primary = idOf(db, "Souvlaki");
  const deluxe = idOf(db, "Souvlaki (Deluxe Edition)");
  dbLib.recordAlbumPlay(db, deluxe, 7000);

  /* The standard edition's folder is taken off the disk. What is left is the
     deluxe, which becomes the album — and the plays credited to the standard
     edition are the same plays. */
  fs.rmSync(path.join(ws.music, "Slowdive/Souvlaki"), { recursive: true, force: true });
  await scanner.scan(db, [ws.music], { artDir: ws.art });
  duplicates.regroup(db);

  const now = db.prepare("SELECT version_of, play_count FROM albums WHERE id = ?").get(deluxe);
  assert.strictEqual(now.version_of, "", "the surviving copy is the album");
  assert.strictEqual(now.play_count, 1, "the history came with it");
  assert.strictEqual(
    db.prepare("SELECT play_count FROM albums WHERE id = ?").get(primary).play_count, 0);
  assert.deepStrictEqual(library.library(db, 50).map(a => a.title), ["Souvlaki (Deluxe Edition)"]);
  ws.cleanup();
});

/*
 * A retag can move an album OUT of a group. The pass decides every primary
 * before it writes anything precisely so that an album about to become a
 * primary in its own right is not mistaken for a stray copy of the group it
 * used to belong to and emptied on the way past.
 */
test("an album retagged out of a group keeps its own history", async () => {
  const { ws, db } = await twoVersions();
  const deluxe = idOf(db, "Souvlaki (Deluxe Edition)");
  dbLib.recordAlbumPlay(db, deluxe, 8000);      // credited to the primary

  /* It is now a different record that merely used to be grouped. */
  db.prepare("UPDATE albums SET title = 'Pygmalion', sort_title = 'pygmalion', play_count = 2, last_played_at = 8000 WHERE id = ?")
    .run(deluxe);
  duplicates.regroup(db);

  const row = db.prepare("SELECT version_of, play_count FROM albums WHERE id = ?").get(deluxe);
  assert.strictEqual(row.version_of, "", "it stands on its own now");
  assert.strictEqual(row.play_count, 2, "and its plays were not taken by its old group");
  ws.cleanup();
});
