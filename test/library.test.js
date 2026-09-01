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
const { buildLibrary, wav } = require("./fixtures");

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
  /* Its parent is called "Unknown", which is a folder SAYING there is no
     artist rather than naming one — so nothing is invented from it. */
  assert.strictEqual(row.artist, "");
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

/* ---------------------------------------------------------------- */
/*  Working out the album artist                                     */
/* ---------------------------------------------------------------- */

test("one mistagged track does not rename the album", () => {
  /* A clear majority is the album's artist. Treating any disagreement as a
     compilation turned a twelve-track album with one typo into "Various
     Artists". */
  const rows = (values) => values.map(v => ({ albumartist: v, artist: "" }));
  assert.strictEqual(
    scanner.deriveAlbumArtist(rows(["Bonobo", "Bonobo", "Bonobo", "Bonobo", "Bonbo"]),
                              "/music/Bonobo/Black Sands", ["/music"]),
    "Bonobo");
  assert.strictEqual(
    scanner.deriveAlbumArtist(rows(["A", "B", "C"]), "/music/X/Y", ["/music"]),
    "Various Artists", "a real split is still a compilation");
});

test("with no artist tag at all, the folder above the album is used", () => {
  /* `Artist/Album/` is how most libraries are laid out, and the name is right
     there. No lookup — just the information the layout already carries. */
  const untagged = [{ albumartist: "", artist: "" }, { albumartist: "", artist: "" }];
  assert.strictEqual(scanner.deriveAlbumArtist(untagged, "/music/Khemmis/Deceiver", ["/music"]),
    "Khemmis");
  assert.strictEqual(scanner.deriveAlbumArtist(untagged, "/music/Deceiver", ["/music"]), "",
    "an album sitting straight in the root has no such parent");
  for (const meaningless of ["Unknown", "Various Artists", "Compilations", "MP3", "CD 2"]) {
    assert.strictEqual(
      scanner.deriveAlbumArtist(untagged, `/music/${meaningless}/Deceiver`, ["/music"]), "",
      `"${meaningless}" says there is no artist rather than naming one`);
  }
});

test("a year in the folder name becomes the year, not part of the title", () => {
  assert.deepStrictEqual(scanner.titleFromFolder("/m/Deceiver (2021)"), { title: "Deceiver", year: 2021 });
  assert.deepStrictEqual(scanner.titleFromFolder("/m/Dark Angel (2008)"), { title: "Dark Angel", year: 2008 });
  assert.deepStrictEqual(scanner.titleFromFolder("/m/01 - Kid A"), { title: "Kid A", year: null });
  /* A folder actually called 1999 keeps its name. */
  assert.deepStrictEqual(scanner.titleFromFolder("/m/1999"), { title: "1999", year: null });

  /* The year has to be MARKED as one. A bare space and four digits is part of
     the title far too often to strip. */
  for (const marked of ["Deceiver [2021]", "Deceiver - 2021", "Deceiver_2016"]) {
    assert.strictEqual(scanner.titleFromFolder("/m/" + marked).title, "Deceiver", marked);
  }
  for (const bare of ["Disco 2000", "Blade Runner 2049", "Summer 1993"]) {
    assert.deepStrictEqual(scanner.titleFromFolder("/m/" + bare), { title: bare, year: null },
      bare + " is a title, not an album with a year after it");
  }
});

/* ---------------------------------------------------------------- */
/*  Multi-disc albums                                                */
/* ---------------------------------------------------------------- */

test("a disc folder is read in any case, with or without a space", () => {
  const cases = {
    "Disc 1": 1, "Disc1": 1, "disc 2": 2, "DISC 3": 3, "Disk 1": 1,
    "CD 1": 1, "CD1": 1, "cd2": 2, "CD 1 of 2": 1,
    "Disc-1": 1, "CD_2": 2, "CD.1": 1, "(Disc 2)": 2, "CD1 - Early Sessions": 1
  };
  for (const [name, disc] of Object.entries(cases)) {
    assert.deepStrictEqual(scanner.parseDiscFolder(name), { album: "", disc },
      name + " names a disc and nothing else");
  }
});

test("a folder carrying the album name AND a disc gives up both", () => {
  const cases = {
    "Kid A Disc 1": ["Kid A", 1], "Kid A - Disc 1": ["Kid A", 1],
    "Kid A (Disc 1)": ["Kid A", 1], "Kid A [CD2]": ["Kid A", 2],
    "Kid A CD 2": ["Kid A", 2], "Physical Graffiti CD1": ["Physical Graffiti", 1],
    "THE WALL DISC 2": ["THE WALL", 2], "the wall cd1": ["the wall", 1]
  };
  for (const [name, [album, disc]] of Object.entries(cases)) {
    assert.deepStrictEqual(scanner.parseDiscFolder(name), { album, disc }, name);
  }
});

test("a word that merely starts with disc or cd is not a disc folder", () => {
  /* The word has to be followed by a number, with only a separator between. */
  for (const name of ["Discovery", "Disco 2000", "Kid A", "1999", "CD Baby",
                      "Discipline", "Deceiver (2021)"]) {
    assert.strictEqual(scanner.parseDiscFolder(name), null, name);
  }
});

test("discs inside an album folder become one album", async () => {
  const ws = workspace();
  for (const [dir, tracks] of Object.entries({
    "Pink Floyd/The Wall/Disc 1": ["In the Flesh", "The Thin Ice"],
    "Pink Floyd/The Wall/Disc 2": ["Hey You", "Nobody Home"]
  })) {
    const full = path.join(ws.music, dir);
    fs.mkdirSync(full, { recursive: true });
    tracks.forEach((title, i) => fs.writeFileSync(
      path.join(full, `0${i + 1} ${title}.wav`),
      wav({ title, artist: "Pink Floyd", albumArtist: "Pink Floyd", track: i + 1 })));
  }
  const db = dbLib.open(ws.data);
  await scanner.scan(db, [ws.music], { artDir: ws.art });

  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM albums WHERE present = 1").get().n, 1,
    "one album, not two");
  const album = library.album(db, db.prepare("SELECT id FROM albums").get().id);
  assert.strictEqual(album.title, "The Wall");
  assert.strictEqual(album.artist, "Pink Floyd");
  assert.strictEqual(album.tracks.length, 4);
  assert.strictEqual(album.multiDisc, true);
  assert.deepStrictEqual(album.tracks.map(t => t.disc), [1, 1, 2, 2],
    "the FOLDER decides the disc — a rip where every file is tagged disc 1 is common");
  ws.cleanup();
});

test("sibling folders sharing an album name become one album", async () => {
  const ws = workspace();
  for (const [dir, title] of Object.entries({
    "Genesis/Seconds Out Disc1": "Squonk",
    "Genesis/Seconds Out Disc 2": "Cinema Show",
    "Genesis/Seconds Out (CD 3)": "Afterglow"
  })) {
    const full = path.join(ws.music, dir);
    fs.mkdirSync(full, { recursive: true });
    fs.writeFileSync(path.join(full, "01 " + title + ".wav"),
      wav({ title, artist: "Genesis", albumArtist: "Genesis", track: 1 }));
  }
  const db = dbLib.open(ws.data);
  await scanner.scan(db, [ws.music], { artDir: ws.art });

  const albums = db.prepare("SELECT title FROM albums WHERE present = 1").all();
  assert.deepStrictEqual(albums.map(a => a.title), ["Seconds Out"]);
  const album = library.album(db, db.prepare("SELECT id FROM albums").get().id);
  assert.deepStrictEqual(album.tracks.map(t => t.disc), [1, 2, 3]);
  ws.cleanup();
});

test("a folded album takes the cover from wherever one is actually named", async () => {
  /* The cover sits one level up from the disc folders in most rips, and the
     album folder is not one the walk ever listed — so it has to be read on
     purpose. A cover inside a disc folder still counts when there is none
     above it. */
  const ws = workspace();
  const png = fs.readFileSync(path.join(__dirname, "..", "public", "icons", "icon-192.png"));

  const disc = rel => {
    const full = path.join(ws.music, rel);
    fs.mkdirSync(full, { recursive: true });
    fs.writeFileSync(path.join(full, "01 Track.wav"), wav({ title: "Track", artist: "A" }));
  };
  disc("A/Above/CD1");
  disc("A/Above/CD2");
  fs.writeFileSync(path.join(ws.music, "A/Above/cover.png"), png);

  disc("A/Inside/CD1");
  disc("A/Inside/CD2");
  fs.writeFileSync(path.join(ws.music, "A/Inside/CD2/folder.png"), png);

  const db = dbLib.open(ws.data);
  await scanner.scan(db, [ws.music], { artDir: ws.art });

  const art = t => db.prepare("SELECT art FROM albums WHERE title = ?").get(t).art;
  assert.strictEqual(art("Above"), path.join(ws.music, "A/Above/cover.png"),
    "the cover above the disc folders");
  assert.strictEqual(art("Inside"), path.join(ws.music, "A/Inside/CD2/folder.png"),
    "and one inside a disc folder when there is none above");
  ws.cleanup();
});

test("folding discs together keeps the history they had apart", async () => {
  /* Before folding, each disc was an album with its own counts. Changing the
     album's identity must not strand real listening. */
  const ws = workspace();
  for (const [dir, title] of Object.entries({
    "Yes/Yessongs/CD1": "Opening",
    "Yes/Yessongs/CD2": "Roundabout"
  })) {
    const full = path.join(ws.music, dir);
    fs.mkdirSync(full, { recursive: true });
    fs.writeFileSync(path.join(full, "01 " + title + ".wav"), wav({ title, artist: "Yes" }));
  }
  const db = dbLib.open(ws.data);

  /* Stand in for what the old scanner left behind: one album per disc. */
  const DAY = 86400000, now = Date.now();
  for (const [rel, added, plays, last] of [
    ["a:Yes/Yessongs/CD1", now - 400 * DAY, 3, now - 10 * DAY],
    ["a:Yes/Yessongs/CD2", now - 300 * DAY, 2, now - 5 * DAY]
  ]) {
    db.prepare(`INSERT INTO albums (id, dir, title, artist, added_at, play_count, last_played_at)
                VALUES (?, '', 'Yessongs', 'Yes', ?, ?, ?)`).run(rel, added, plays, last);
    db.prepare("INSERT INTO plays (kind, ref, album_id, ts) VALUES ('album', ?, ?, ?)")
      .run(rel, rel, last);
  }

  await scanner.scan(db, [ws.music], { artDir: ws.art });

  const album = db.prepare("SELECT * FROM albums WHERE present = 1").get();
  assert.strictEqual(album.play_count, 5, "the counts are summed");
  assert.strictEqual(album.added_at, now - 400 * DAY, "the earliest arrival is kept");
  assert.strictEqual(album.last_played_at, now - 5 * DAY, "and the most recent play");
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) n FROM plays WHERE album_id = ?").get(album.id).n, 2,
    "the play history now points at the album that exists");
  ws.cleanup();
});

test("folding is idempotent — a second scan does not count the same plays twice", async () => {
  /* The pieces' counters are added onto the album they became. Left where they
     were, the next scan would add them again, and the album would double its
     play count every time the library was rescanned. */
  const ws = workspace();
  for (const [dir, title] of Object.entries({
    "Yes/Yessongs/CD1": "Opening",
    "Yes/Yessongs/CD2": "Roundabout"
  })) {
    const full = path.join(ws.music, dir);
    fs.mkdirSync(full, { recursive: true });
    fs.writeFileSync(path.join(full, "01 " + title + ".wav"), wav({ title, artist: "Yes" }));
  }
  const db = dbLib.open(ws.data);

  const DAY = 86400000, now = Date.now();
  for (const [rel, added, plays, last] of [
    ["a:Yes/Yessongs/CD1", now - 400 * DAY, 3, now - 10 * DAY],
    ["a:Yes/Yessongs/CD2", now - 300 * DAY, 2, now - 5 * DAY]
  ]) {
    db.prepare(`INSERT INTO albums (id, dir, title, artist, added_at, play_count, last_played_at)
                VALUES (?, '', 'Yessongs', 'Yes', ?, ?, ?)`).run(rel, added, plays, last);
    db.prepare("INSERT INTO plays (kind, ref, album_id, ts) VALUES ('album', ?, ?, ?)")
      .run(rel, rel, last);
  }

  await scanner.scan(db, [ws.music], { artDir: ws.art });
  await scanner.scan(db, [ws.music], { artDir: ws.art });
  await scanner.scan(db, [ws.music], { artDir: ws.art });

  const album = db.prepare("SELECT * FROM albums WHERE present = 1").get();
  assert.strictEqual(album.play_count, 5, "still the five plays that happened");
  assert.strictEqual(album.added_at, now - 400 * DAY, "and still the earliest arrival");
  assert.strictEqual(album.last_played_at, now - 5 * DAY, "and still the most recent play");

  /* Every album play now names the album it belongs to, not a disc folder that
     is no longer an album — "recently played" reads `ref`. */
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) n FROM plays WHERE kind = 'album' AND ref = ?").get(album.id).n, 2,
    "the history rows name the album that exists");
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) n FROM plays WHERE kind = 'album' AND ref LIKE '%/CD_'").get().n, 0,
    "and none of them still name a disc");
  ws.cleanup();
});
