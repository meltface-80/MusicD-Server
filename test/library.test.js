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

test("a discography folder names the artist, it is not the artist", () => {
  /*
   * "R.E.M. - Discography/Accelerate/" is a very common way to keep a
   * collection, and it filed every album under an artist called
   * "REM - Discography" — a name that matches nothing at MusicBrainz, nothing
   * at the iTunes store and nothing in a Wikipedia search, so every album
   * under it lost its cover AND its write-up at once. That is the "bad
   * metadata, then falls back to folder names" report.
   */
  const untagged = [{ albumartist: "", artist: "" }, { albumartist: "", artist: "" }];
  const artist = (dir) => scanner.deriveAlbumArtist(untagged, dir, ["/music"]);

  assert.strictEqual(artist("/music/REM - Discography/Accelerate"), "REM");
  assert.strictEqual(artist("/music/Peter Gabriel - Studio Discography/Scratch My Back"),
    "Peter Gabriel");
  assert.strictEqual(artist("/music/Judas Priest Complete Discography/Painkiller"),
    "Judas Priest");
  assert.strictEqual(artist("/music/Slowdive - The Albums/Souvlaki"), "Slowdive");
  /* Nothing but a container: the artist is a level further up. */
  assert.strictEqual(artist("/music/Talk Talk/Discography/Spirit of Eden"), "Talk Talk");

  /* A word that is not in the vocabulary means "this is part of the name", so
     an ordinary folder is left exactly as it is — including one whose name
     merely mentions a container word. */
  assert.strictEqual(artist("/music/Khemmis/Deceiver"), "Khemmis");
  assert.strictEqual(artist("/music/Collection of Colonies of Bees/Set"),
    "Collection of Colonies of Bees");
  /* A tail of fillers alone is not a container. */
  assert.strictEqual(artist("/music/Godspeed You! Black Emperor - The Studio/Lift"),
    "Godspeed You! Black Emperor - The Studio");
});

test("a folder that repeats the artist is not an album called that", () => {
  /* "Peter Gabriel - Scratch My Back 2010" is an album called Scratch My Back.
     The prefix is a filing habit, and left in it is searched for verbatim —
     which finds nothing, at every source this app has. */
  const untagged = [{ album: "" }, { album: "" }];
  const title = (dir, who) => scanner.deriveAlbumTitle(untagged, dir, who);

  assert.strictEqual(title("/m/Peter Gabriel - Scratch My Back", "Peter Gabriel"),
    "Scratch My Back");
  assert.strictEqual(title("/m/REM_Accelerate", "REM"), "Accelerate");
  /* Only when the artist is named in full and something is left after it. */
  assert.strictEqual(title("/m/Peter Gabriel", "Peter Gabriel"), "Peter Gabriel",
    "a record really called that keeps its name");
  assert.strictEqual(title("/m/Peter Gabriel III", "Peter Gabriel"), "Peter Gabriel III",
    "no separator, so nothing was repeated");
  assert.strictEqual(title("/m/Scratch My Back", "Peter Gabriel"), "Scratch My Back");

  /* A TAG is left exactly as it is. A folder inside an artist's directory
     saying the artist's name is a convention; a tag saying it is evidence. */
  assert.strictEqual(
    scanner.deriveAlbumTitle([{ album: "Peter Gabriel - Car" }, { album: "Peter Gabriel - Car" }],
      "/m/whatever", "Peter Gabriel"),
    "Peter Gabriel - Car");
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

/* ------------------------------------------------------------------ */
/*  Favourites                                                         */
/* ------------------------------------------------------------------ */

test("an album can be marked a favourite, and unmarked", async () => {
  const { ws, db } = await scannedLibrary();
  const album = db.prepare("SELECT id FROM albums ORDER BY title LIMIT 1").get().id;

  assert.strictEqual(library.favourites(db).length, 0, "nothing is one to begin with");
  assert.deepStrictEqual(library.setFavourite(db, album, true), { id: album, favourite: true });
  assert.deepStrictEqual(library.favourites(db).map(a => a.id), [album]);
  assert.strictEqual(library.favouriteCount(db), 1);

  library.setFavourite(db, album, false);
  assert.strictEqual(library.favourites(db).length, 0);
  assert.strictEqual(library.favouriteCount(db), 0);
  ws.cleanup();
});

test("marking an album that is not there says so rather than inventing one", () => {
  const ws = workspace();
  const db = dbLib.open(ws.data);
  assert.strictEqual(library.setFavourite(db, "a:No/Such", true), null);
  ws.cleanup();
});

test("favourites come back most recently marked first", async () => {
  /* The one just marked is the one being thought about. The column holds WHEN
     it was marked rather than a flag, which is what makes that possible. */
  const { ws, db } = await scannedLibrary();
  const ids = db.prepare("SELECT id FROM albums ORDER BY title LIMIT 3").all().map(r => r.id);
  library.setFavourite(db, ids[0], true, 1000);
  library.setFavourite(db, ids[1], true, 3000);
  library.setFavourite(db, ids[2], true, 2000);
  assert.deepStrictEqual(library.favourites(db).map(a => a.id), [ids[1], ids[2], ids[0]]);
  ws.cleanup();
});

test("a rescan never disturbs a favourite", async () => {
  /* The only thing in the library a person typed rather than the files, so it
     is the only thing a rescan could destroy — the same reason added_at is
     left alone by the upserts. */
  const { ws, db } = await scannedLibrary();
  const album = db.prepare("SELECT id FROM albums ORDER BY title LIMIT 1").get().id;
  library.setFavourite(db, album, true, 4242);

  await scanner.scan(db, [ws.music], { artDir: ws.art });
  assert.strictEqual(
    db.prepare("SELECT favourite FROM albums WHERE id = ?").get(album).favourite, 4242,
    "the mark, and the moment it was made, both survive");
  ws.cleanup();
});

test("an album says whether it is a favourite; a grid card does not carry it", async () => {
  const { ws, db } = await scannedLibrary();
  const id = db.prepare("SELECT id FROM albums ORDER BY title LIMIT 1").get().id;

  assert.strictEqual(library.album(db, id).favourite, false);
  library.setFavourite(db, id, true);
  assert.strictEqual(library.album(db, id).favourite, true, "a flag on the way out");
  /* The home screen carries six rows of cards; a field only the album screen
     reads does not belong on one. */
  assert.ok(!("favourite" in library.library(db, 5)[0]), "the card stays lean");
  ws.cleanup();
});

/* ------------------------------------------------------------------ */
/*  An artist's two lists                                              */
/* ------------------------------------------------------------------ */

test("an artist's records and the ones they appear on are separate lists", async () => {
  const ws = workspace();
  const mk = (dir, albumArtist, tracks) => {
    const full = path.join(ws.music, dir);
    fs.mkdirSync(full, { recursive: true });
    tracks.forEach(([title, artist], i) =>
      fs.writeFileSync(path.join(full, `0${i + 1} ${title}.wav`),
        wav({ title, artist, albumArtist, album: path.basename(dir), year: 1980 + i })));
  };
  mk("Bowie/Low", "David Bowie", [["Speed of Life", "David Bowie"]]);
  mk("Bowie/Heroes", "David Bowie", [["Beauty and the Beast", "David Bowie"]]);
  /* A compilation: the album is Various Artists, one track is his. */
  mk("Various/Nineteen Seventy Seven", "Various Artists",
     [["Sound and Vision", "David Bowie"], ["Peaches", "The Stranglers"]]);

  const db = dbLib.open(ws.data);
  await scanner.scan(db, [ws.music], { artDir: ws.art });
  const { albums, appearsOn } = library.byArtist(db, "David Bowie");

  assert.deepStrictEqual(albums.map(a => a.title).sort(), ["Heroes", "Low"],
    "the records they made");
  assert.deepStrictEqual(appearsOn.map(a => a.title), ["Nineteen Seventy Seven"],
    "and the one they turn up on");
  /* Nothing is offered twice: an album already in the first list is taken out
     of the second even though his name is on its tracks. */
  const both = albums.filter(a => appearsOn.some(b => b.id === a.id));
  assert.deepStrictEqual(both, []);

  /* Somebody with nothing of their own still has their appearances. */
  const stranglers = library.byArtist(db, "The Stranglers");
  assert.deepStrictEqual(stranglers.albums, []);
  assert.deepStrictEqual(stranglers.appearsOn.map(a => a.title), ["Nineteen Seventy Seven"]);
  ws.cleanup();
});

/* ------------------------------------------------------------------ */
/*  Release dates                                                      */
/* ------------------------------------------------------------------ */

test("a release date is kept only as precisely as the tag gives it", () => {
  const { isoDate } = scanner;
  assert.strictEqual(isoDate("2025-09-23"), "2025-09-23");
  assert.strictEqual(isoDate("2025-9-3"), "2025-09-03", "single digits are padded");
  assert.strictEqual(isoDate("2025/09/23"), "2025-09-23", "slashes are a date too");
  assert.strictEqual(isoDate("2025-09"), "2025-09", "a month with no day stays a month");
  assert.strictEqual(isoDate("2025"), "2025", "and a year stays a year");
  assert.strictEqual(isoDate(2025), "2025", "a number is a year");
});

test("a date that is not one is no date, rather than a guess", () => {
  const { isoDate } = scanner;
  /* Tags are typed by hand as often as written by a ripper. */
  for (const bad of ["", null, undefined, "unknown", "199", "20255", "n/a", "Sept 2025"]) {
    assert.strictEqual(isoDate(bad), "", JSON.stringify(bad) + " is not a date");
  }
  /* A day or month out of range is dropped back to what IS known, never
     rolled over into the next month. A day of 00 means "no day" to some
     taggers and would otherwise become the last of the month before. */
  assert.strictEqual(isoDate("2025-09-00"), "2025-09");
  assert.strictEqual(isoDate("2025-09-31"), "2025-09", "September has 30 days");
  assert.strictEqual(isoDate("2024-02-29"), "2024-02-29", "but a leap day is real");
  assert.strictEqual(isoDate("2025-02-29"), "2025-02", "and is not in 2025");
  assert.strictEqual(isoDate("2025-13-01"), "2025", "there is no thirteenth month");
});

test("the album's date is the one all its files agree on", () => {
  const { deriveReleaseDate } = scanner;
  const rows = (...dates) => dates.map(releaseDate => ({ releaseDate }));
  assert.strictEqual(
    deriveReleaseDate(rows("2025-09-23", "2025-09-23", "2025-09-23"), 2025), "2025-09-23");
  /* A compilation whose tracks each carry their own original release date has
     no one date, and the year is all it gets. */
  assert.strictEqual(deriveReleaseDate(rows("1966-03-01", "1966-08-19"), 1966), "");
  /* A file that says nothing is not a file that disagrees. One untagged track
     in an otherwise consistent rip is ordinary, and it should not cost the
     album a date every other file on it states. */
  assert.strictEqual(deriveReleaseDate(rows("2025-09-23", "", ""), 2025), "2025-09-23");
  assert.strictEqual(deriveReleaseDate(rows(), 2025), "", "no dates, no date");
  /* The year is worked out from the tags AND the folder name, so a date that
     contradicts it is not the album's date. */
  assert.strictEqual(deriveReleaseDate(rows("2019-04-01", "2019-04-01"), 2021), "");
});

test("a scan records the release date, and a rescan still has it", async () => {
  const ws = workspace();
  const dir = path.join(ws.music, "Daphni", "Butterfly");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "01 Butterfly.wav"),
    wav({ title: "Butterfly", artist: "Daphni", album: "Butterfly", date: "2026-04-17" }));

  const db = dbLib.open(ws.data);
  await scanner.scan(db, [ws.music], { artDir: ws.art });
  const first = db.prepare("SELECT year, release_date FROM albums WHERE title = 'Butterfly'").get();
  assert.strictEqual(first.release_date, "2026-04-17");
  assert.strictEqual(first.year, 2026, "the year still comes out of it");

  /* The second pass reuses the row rather than re-reading the file, and the
     reused row has to carry the date with it — the exact shape of the bug
     that blanked album artists in 0.3.2. */
  await scanner.scan(db, [ws.music], { artDir: ws.art });
  const second = db.prepare("SELECT release_date FROM albums WHERE title = 'Butterfly'").get();
  assert.strictEqual(second.release_date, "2026-04-17", "a rescan does not lose it");
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

/* ------------------------------------------------------------------ */
/*  Correcting an album's name                                         */
/* ------------------------------------------------------------------ */

/*
 * The one thing in the library the user says rather than the files, after the
 * heart. Everything here is about the two ways it can quietly stop working: a
 * rescan putting the tags back, and one of the many queries that read a name
 * being left behind on the raw column.
 */

test("a corrected name is what every row, sort and search reads", async () => {
  const { ws, db } = await scannedLibrary();
  const before = library.library(db, 100).find(a => a.title === "Field Recordings");
  assert.strictEqual(before.artist, "", "the files name no artist — the case this is for");

  library.setNames(db, before.id, { title: "Field Recordings", artist: "Chris Watson" });

  /* Every reader, because there is no such thing as most of them agreeing. */
  const shelf = library.library(db, 100).map(a => `${a.artist} — ${a.title}`);
  assert.ok(shelf.includes("Chris Watson — Field Recordings"), "the library row");
  assert.deepStrictEqual(library.search(db, "watson").albums.map(a => a.title),
    ["Field Recordings"], "search by the new artist");
  assert.ok(library.artists(db).some(a => a.name === "Chris Watson"), "the artist list");
  assert.deepStrictEqual(library.byArtist(db, "Chris Watson").albums.map(a => a.title),
    ["Field Recordings"], "that artist's screen");
  assert.strictEqual(library.album(db, before.id).artist, "Chris Watson", "the album screen");

  /* Filed under the new name too, not left where the blank artist put it. An
     album that sorts under a name it does not show is one the user cannot
     find by scrolling to where it says it is. */
  const order = library.library(db, 100).map(a => a.artist);
  assert.deepStrictEqual(order, [...order].sort((a, b) => a.localeCompare(b)),
    "the shelf is still in artist order, with the correction in its place");
  ws.cleanup();
});

test("a rescan does not put the tags back", async () => {
  const { ws, db } = await scannedLibrary();
  const album = library.library(db, 100).find(a => a.title === "Field Recordings");
  library.setNames(db, album.id, { title: "Sea Nettles", artist: "Chris Watson" });

  await scanner.scan(db, [ws.music], { artDir: ws.art });
  await scanner.scan(db, [ws.music], { artDir: ws.art });

  const after = library.album(db, album.id);
  assert.strictEqual(after.title, "Sea Nettles", "the title the user typed");
  assert.strictEqual(after.artist, "Chris Watson", "and the artist");
  /* The scan is still doing its job on the columns it owns — the correction
     sits BESIDE the tags rather than on top of them. */
  assert.strictEqual(after.tags.title, "Field Recordings", "the tags are untouched");
  assert.strictEqual(after.tags.artist, "");
  ws.cleanup();
});

test("clearing a field goes back to what the files say", async () => {
  const { ws, db } = await scannedLibrary();
  const album = library.library(db, 100).find(a => a.title === "Souvlaki");
  library.setNames(db, album.id, { title: "Souvlaki Space Station", artist: "Slowdiv" });
  assert.strictEqual(library.album(db, album.id).title, "Souvlaki Space Station");

  /* The only way back, and the reason there is no third button for it. */
  const reverted = library.setNames(db, album.id, { title: "", artist: "" });
  assert.strictEqual(reverted.title, "Souvlaki");
  assert.strictEqual(reverted.artist, "Slowdive");
  assert.strictEqual(reverted.edited, false);
  assert.strictEqual(
    db.prepare("SELECT title_edit, artist_edit, sort_title_edit, sort_artist_edit FROM albums WHERE id = ?")
      .get(album.id).sort_artist_edit, "",
    "and the sort key goes with it, or the album files under a name it dropped");
  ws.cleanup();
});

test("a name that only repeats the tags is not stored as a correction", async () => {
  const { ws, db } = await scannedLibrary();
  const album = library.library(db, 100).find(a => a.title === "Souvlaki");
  /* Opening the dialog and pressing Save without typing. Storing that would
     leave every album carrying a row that says what the files already say —
     and would then survive a re-tag of the files it was copied from. */
  const same = library.setNames(db, album.id, { title: " Souvlaki ", artist: "Slowdive" });
  assert.strictEqual(same.edited, false, "surrounding space is not a correction either");
  assert.strictEqual(
    db.prepare("SELECT title_edit FROM albums WHERE id = ?").get(album.id).title_edit, "");
  ws.cleanup();
});

test("a correction is written to the primary, whichever version was on screen", async () => {
  const ws = workspace();
  /* One record on disk twice: the album and its deluxe reissue. */
  for (const [dir, extra] of [["Boards of Canada/Geogaddi", []],
                              ["Boards of Canada/Geogaddi (Deluxe Edition)", ["Bonus"]]]) {
    const full = path.join(ws.music, dir);
    fs.mkdirSync(full, { recursive: true });
    ["Ready Lets Go", "Gyroscope", ...extra].forEach((title, i) => {
      fs.writeFileSync(path.join(full, `0${i + 1} ${title}.wav`), wav({
        title, artist: "Boards of Canada", album: path.basename(dir), albumArtist: "Boards of Canada"
      }));
    });
  }
  const db = dbLib.open(ws.data);
  await scanner.scan(db, [ws.music], { artDir: ws.art });
  require("../lib/duplicates").regroup(db);

  const shown = library.library(db, 100).find(a => /Geogaddi/.test(a.title));
  const deluxe = shown.id.includes("Deluxe")
    ? shown.id : "a:Boards of Canada/Geogaddi (Deluxe Edition)";
  const primary = db.prepare("SELECT id FROM albums WHERE version_of = '' AND present = 1").get().id;
  assert.notStrictEqual(deluxe, primary, "the two really are one group");

  /* Typed on the deluxe tab; the name belongs to the record. */
  const saved = library.setNames(db, deluxe, { title: "Geogaddi", artist: "BoC" });
  assert.strictEqual(saved.id, primary, "the correction went to the primary");
  assert.strictEqual(library.album(db, deluxe).artist, "BoC",
    "and the deluxe tab shows the record's name, as it did before");
  ws.cleanup();
});

test("grouping copies of a record ignores the typed name", async () => {
  const { ws, db } = await scannedLibrary();
  const hex = library.library(db, 100).find(a => a.title === "Hex");
  const souvlaki = library.library(db, 100).find(a => a.title === "Souvlaki");

  /* Renaming one album to another's name must not fold them together: a match
     MOVES the loser's play counts onto the primary, and typing the name back
     would not bring them home. */
  library.setNames(db, hex.id, { title: "Souvlaki", artist: "Slowdive" });
  require("../lib/duplicates").regroup(db);

  assert.strictEqual(db.prepare("SELECT version_of FROM albums WHERE id = ?").get(hex.id).version_of, "",
    "still its own record");
  assert.strictEqual(
    db.prepare("SELECT version_of FROM albums WHERE id = ?").get(souvlaki.id).version_of, "");
  ws.cleanup();
});

test("Smart Picks follow the corrected artist rather than the tag", async () => {
  const { ws, db } = await scannedLibrary();
  /* An album the files name no artist for at all — so before the correction it
     is exactly what the row must never offer: something with no connection to
     anything played. */
  const field = library.library(db, 100).find(a => a.title === "Field Recordings");
  /* Slowdive rather than Talk Talk: the row allows one album per artist, and
     Talk Talk already has a second record in the fixture that would take the
     slot on its own merits and prove nothing. */
  library.setNames(db, field.id, { title: "Field Recordings", artist: "Slowdive" });

  dbLib.recordAlbumPlay(db,
    db.prepare("SELECT id FROM albums WHERE title = 'Souvlaki'").get().id, Date.now() - 3 * DAY);

  /* The profile is built from the SEEDS and matched against the CANDIDATES. If
     one side read the tags while the other read the correction, an album the
     user has just told the library who made it would still never line up with
     anything they had played. */
  const picked = picks.build(db).picks.find(p => p.title === "Field Recordings");
  assert.ok(picked, "the corrected album is now connected to what was played");
  assert.match(picked.reason, /Slowdive/);
  ws.cleanup();
});

/* ------------------------------------------------------------------ */
/*  How the library is ordered                                         */
/* ------------------------------------------------------------------ */

const titlesOf = (rows) => rows.map(a => a.title);

test("the library opens in the shelf order it always did", async () => {
  const { ws, db } = await scannedLibrary();
  try {
    /* Artist then year: every album an artist made, in the order they made
       them. Nobody who never opens the sort control should see a change. */
    assert.deepStrictEqual(library.normaliseSort(null),
      { sort: "artist", dir: "asc", seed: 1 });
    assert.deepStrictEqual(titlesOf(library.library(db, 100)),
      titlesOf(library.library(db, 100, 0, { sort: "artist", dir: "asc" })));
  } finally { ws.cleanup(); }
});

test("each sort opens in its own direction, not a shared one", () => {
  /* "Sort by year" means newest first and "sort by album" means A → Z. One
     shared default would answer the wrong question for half of them. */
  const opens = (id) => library.normaliseSort({ sort: id }).dir;
  assert.strictEqual(opens("album"), "asc");
  assert.strictEqual(opens("artist"), "asc");
  assert.strictEqual(opens("year"), "desc");
  assert.strictEqual(opens("added"), "desc");
  assert.strictEqual(opens("plays"), "desc");
  assert.strictEqual(opens("lastplayed"), "desc");
  /* Random has no direction at all. */
  assert.strictEqual(library.normaliseSort({ sort: "random", dir: "desc" }).dir, "asc");
  assert.ok(!library.sortOptions().find(o => o.id === "random").directional);
});

test("a direction reverses the wall and nothing else", async () => {
  const { ws, db } = await scannedLibrary();
  try {
    const up = titlesOf(library.library(db, 100, 0, { sort: "album", dir: "asc" }));
    const down = titlesOf(library.library(db, 100, 0, { sort: "album", dir: "desc" }));
    assert.deepStrictEqual(down, [...up].reverse());
  } finally { ws.cleanup(); }
});

test("an album with no year is unknown, not year zero", async () => {
  /*
   * The fixture's Field Recordings carries no year tag. Reversing to
   * newest-first must not float every untagged record to the TOP of the wall,
   * so unknowns are held at the end whichever way the arrow points.
   */
  const { ws, db } = await scannedLibrary();
  try {
    const newest = titlesOf(library.library(db, 100, 0, { sort: "year", dir: "desc" }));
    const oldest = titlesOf(library.library(db, 100, 0, { sort: "year", dir: "asc" }));
    assert.strictEqual(newest[newest.length - 1], "Field Recordings", newest.join(", "));
    assert.strictEqual(oldest[oldest.length - 1], "Field Recordings", oldest.join(", "));
  } finally { ws.cleanup(); }
});

test("an album never played is unknown too, at either end", async () => {
  const { ws, db } = await scannedLibrary();
  try {
    const spirit = db.prepare("SELECT id FROM albums WHERE title = 'Spirit of Eden'").get().id;
    dbLib.recordAlbumPlay(db, spirit, Date.now() - DAY);
    for (const dir of ["asc", "desc"]) {
      const rows = library.library(db, 100, 0, { sort: "lastplayed", dir });
      assert.strictEqual(rows[0].title, "Spirit of Eden",
        `the only played album leads under ${dir}: ` + titlesOf(rows).join(", "));
    }
  } finally { ws.cleanup(); }
});

test("a random sort is stable across pages, which is why it is seeded", async () => {
  /*
   * The grid reads a page at a time. SQLite's own RANDOM() draws again on
   * every call, so page two would be a different shuffle from page one —
   * showing some albums twice and others never. This is the test that fails
   * if the seed is dropped.
   */
  const { ws, db } = await scannedLibrary();
  try {
    const view = { sort: "random", seed: 4242 };
    const whole = titlesOf(library.library(db, 100, 0, view));
    const paged = [];
    for (let offset = 0; offset < whole.length; offset += 2) {
      paged.push(...titlesOf(library.library(db, 2, offset, view)));
    }
    assert.deepStrictEqual(paged, whole, "the pages join up into the same order");
    assert.strictEqual(new Set(paged).size, whole.length, "and nothing is repeated or missed");

    /* The same seed twice is the same wall; a different seed is a different
       one, or the reshuffle control does nothing visible. */
    assert.deepStrictEqual(titlesOf(library.library(db, 100, 0, view)), whole);
    const other = titlesOf(library.library(db, 100, 0, { sort: "random", seed: 99 }));
    assert.notDeepStrictEqual(other, whole);
  } finally { ws.cleanup(); }
});

test("a stored view from another version cannot break the screen", () => {
  /* This value comes out of a database row and off a query string. A library
     screen that throws because a setting is from last year is a library screen
     nobody can open. */
  assert.deepStrictEqual(library.normaliseSort({ sort: "by-vibes" }).sort, "artist");
  assert.strictEqual(library.normaliseSort({ sort: "album", dir: "sideways" }).dir, "asc");
  assert.strictEqual(library.normaliseSort({ sort: "random", seed: -5 }).seed, 1);
  assert.strictEqual(library.normaliseSort({ sort: "random", seed: 1e9 }).seed, 1);
  assert.strictEqual(library.normaliseSort({ sort: "random", seed: "abc" }).seed, 1);
  assert.doesNotThrow(() => library.normaliseSort(undefined));
});

test("a corrected name sorts where it is shown, not where the tags put it", async () => {
  /* The sorts read through albumNames() like every other query — an album
     filed under a name it does not display is one nobody can find by
     scrolling to where it says it is. */
  const { ws, db } = await scannedLibrary();
  try {
    const field = library.library(db, 100).find(a => a.title === "Field Recordings");
    library.setNames(db, field.id, { title: "Aardvark", artist: "Aardvark" });
    const first = library.library(db, 100, 0, { sort: "album", dir: "asc" })[0];
    assert.strictEqual(first.title, "Aardvark");
  } finally { ws.cleanup(); }
});
