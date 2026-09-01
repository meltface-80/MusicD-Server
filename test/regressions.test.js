"use strict";

/*
 * One test per bug that has actually happened here. Each names what broke, so
 * that a failure points at the behaviour rather than at the assertion.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const dbLib = require("../lib/db");
const scanner = require("../lib/scanner");
const library = require("../lib/library");
const sonosLib = require("../lib/sonos");
const { Playback } = require("../lib/playback");
const { buildLibrary, wav } = require("./fixtures");
const { createFakeSonos } = require("./fake-sonos");

const FAKE_PORT = 11460;

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-reg-"));
  return {
    root,
    music: path.join(root, "music"),
    data: path.join(root, "data"),
    art: path.join(root, "data", "cache", "art"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

async function scanned(ws) {
  const db = dbLib.open(ws.data);
  await scanner.scan(db, [ws.music], { artDir: ws.art });
  return db;
}

/* ---------------------------------------------------------------- */
/*  The scan                                                         */
/* ---------------------------------------------------------------- */

test("re-tagging one track does not blank the album's artist, year and genre", async () => {
  const ws = workspace();
  buildLibrary(ws.music);
  const db = await scanned(ws);
  const before = db.prepare("SELECT artist, year, genre, sort_artist FROM albums WHERE title = 'Spirit of Eden'").get();
  assert.deepStrictEqual(before, { artist: "Talk Talk", year: 1988, genre: "Art Rock", sort_artist: "talk talk" });

  /* Touch a single file, as any tag editor does. The other five come back
     through the reuse path, and the album's fields have to be derived from all
     six — not from the one that changed. */
  const one = path.join(ws.music, "Talk Talk/Spirit of Eden/01 The Rainbow.wav");
  fs.utimesSync(one, new Date(), new Date(Date.now() + 60000));

  const stats = await scanner.scan(db, [ws.music], { artDir: ws.art });
  assert.strictEqual(stats.parsed, 1, "exactly one file was re-read");
  assert.strictEqual(stats.reused, 20);

  const after = db.prepare("SELECT artist, year, genre, sort_artist FROM albums WHERE title = 'Spirit of Eden'").get();
  assert.deepStrictEqual(after, before,
    "a partial rescan left the album exactly as it was");
  ws.cleanup();
});

test("albums reached through a symlink are scanned", async () => {
  const ws = workspace();
  buildLibrary(ws.music);
  const linked = path.join(ws.root, "linked");
  fs.mkdirSync(linked);
  fs.symlinkSync(path.join(ws.music, "Slowdive"), path.join(linked, "Slowdive"));

  const db = dbLib.open(ws.data);
  const stats = await scanner.scan(db, [linked], { artDir: ws.art });
  assert.strictEqual(stats.albums, 1, "readdir calls a symlink neither a file nor a directory");
  assert.strictEqual(db.prepare("SELECT title FROM albums").get().title, "Souvlaki");
  ws.cleanup();
});

test("a symlink loop does not hang the scan", async () => {
  const ws = workspace();
  fs.mkdirSync(path.join(ws.music, "Album"), { recursive: true });
  fs.writeFileSync(path.join(ws.music, "Album", "01.wav"), wav({ title: "One", album: "Album" }));
  fs.symlinkSync(ws.music, path.join(ws.music, "Album", "loop"));

  const db = dbLib.open(ws.data);
  const stats = await scanner.scan(db, [ws.music], { artDir: ws.art });
  assert.strictEqual(stats.albums, 1);
  ws.cleanup();
});

test("two albums with a long shared path prefix get their own cached artwork", async () => {
  const ws = workspace();
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082", "hex");

  /* Deep, near-identical folder names — the shape of any classical library.
     The cache key used to be the path hex-truncated to 38 characters, so these
     two collided and the second album was handed the first one's cover. */
  for (const n of ["1", "2"]) {
    const dir = path.join(ws.music, "Herbert von Karajan", "Beethoven Symphony No " + n);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "01.wav"), wav({ title: "Movement I", album: "Symphony No " + n }));
  }
  /* Distinct covers, so a collision is visible rather than merely possible. */
  fs.writeFileSync(path.join(ws.music, "Herbert von Karajan", "Beethoven Symphony No 1", "cover.png"), png);
  fs.writeFileSync(path.join(ws.music, "Herbert von Karajan", "Beethoven Symphony No 2", "cover.png"),
    Buffer.concat([png, Buffer.from("x")]));

  const db = await scanned(ws);
  const arts = db.prepare("SELECT title, art FROM albums ORDER BY title").all();
  assert.strictEqual(arts.length, 2);
  assert.notStrictEqual(arts[0].art, arts[1].art, "each album kept its own cover");
  ws.cleanup();
});

/* ---------------------------------------------------------------- */
/*  Counting plays                                                   */
/* ---------------------------------------------------------------- */

async function playRig() {
  const ws = workspace();
  buildLibrary(ws.music);
  const db = await scanned(ws);

  const fake = createFakeSonos({
    port: FAKE_PORT, host: "127.0.0.1",
    zones: [{ uuid: "RINCON_AAA01400", name: "Kitchen", coordinator: "RINCON_AAA01400" }]
  });
  await fake.listen();
  const household = new sonosLib.Household({ hosts: ["127.0.0.1"], port: FAKE_PORT });
  await household.refresh({ force: true });
  const playback = new Playback({ db, household, baseUrl: () => "http://192.168.1.9:3400" });

  return {
    db, fake, playback,
    zone: "RINCON_AAA01400",
    albumId: (t) => db.prepare("SELECT id FROM albums WHERE title = ?").get(t).id,
    trackPlays: () => db.prepare("SELECT SUM(play_count) n FROM tracks").get().n || 0,
    albumPlays: () => db.prepare("SELECT SUM(play_count) n FROM albums").get().n || 0,
    async cleanup() { playback.stop(); await fake.close(); db.close(); ws.cleanup(); }
  };
}

test("pausing and resuming does not count the same track twice", async () => {
  const r = await playRig();
  try {
    await r.playback.playAlbum(r.zone, r.albumId("Spirit of Eden"));
    r.fake.playingAt(1, "0:03:00", "0:05:00");
    await r.playback.poll();
    assert.strictEqual(r.trackPlays(), 1);

    r.fake.state.transportState = "PAUSED_PLAYBACK";
    await r.playback.poll();
    r.fake.state.transportState = "PLAYING";
    await r.playback.poll();

    assert.strictEqual(r.trackPlays(), 1, "the pause did not make it a second play");
    assert.strictEqual(r.albumPlays(), 1);
  } finally { await r.cleanup(); }
});

test("a dropped poll does not count the same track twice", async () => {
  const r = await playRig();
  try {
    await r.playback.playAlbum(r.zone, r.albumId("Spirit of Eden"));
    r.fake.playingAt(1, "0:03:00", "0:05:00");
    await r.playback.poll();

    /* The speaker stops answering for one round — busy with the Sonos app. */
    r.fake.state.faults.set("GetTransportInfo", "500");
    await r.playback.poll();
    r.fake.state.faults.delete("GetTransportInfo");
    await r.playback.poll();

    assert.strictEqual(r.trackPlays(), 1);
  } finally { await r.cleanup(); }
});

test("playing the same track again from the top counts it again", async () => {
  const r = await playRig();
  try {
    await r.playback.playAlbum(r.zone, r.albumId("Spirit of Eden"));
    r.fake.playingAt(1, "0:03:00", "0:05:00");
    await r.playback.poll();
    assert.strictEqual(r.trackPlays(), 1);

    r.fake.playingAt(1, "0:00:01", "0:05:00");     // started over
    await r.playback.poll();
    r.fake.playingAt(1, "0:03:00", "0:05:00");
    await r.playback.poll();

    assert.strictEqual(r.trackPlays(), 2, "a replay is a second play");
  } finally { await r.cleanup(); }
});

test("seeking backwards inside a track does not count it again", async () => {
  const r = await playRig();
  try {
    await r.playback.playAlbum(r.zone, r.albumId("Spirit of Eden"));
    r.fake.playingAt(1, "0:04:30", "0:05:00");
    await r.playback.poll();

    r.fake.playingAt(1, "0:02:00", "0:05:00");     // back a bit, not to the top
    await r.playback.poll();
    r.fake.playingAt(1, "0:04:30", "0:05:00");
    await r.playback.poll();

    assert.strictEqual(r.trackPlays(), 1);
  } finally { await r.cleanup(); }
});

test("stopping the poll loop actually stops it", async () => {
  const r = await playRig();
  try {
    r.playback.start(20);
    await new Promise(done => setTimeout(done, 60));
    r.playback.stop();
    const seen = r.fake.state.calls.length;
    await new Promise(done => setTimeout(done, 120));
    assert.strictEqual(r.fake.state.calls.length, seen,
      "an in-flight tick must not re-arm the timer stop() just cleared");
  } finally { await r.cleanup(); }
});

/* ---------------------------------------------------------------- */
/*  Starting an album part way in                                    */
/* ---------------------------------------------------------------- */

test("playing from a track starts on THAT track when the album has unplayable files", async () => {
  const ws = workspace();
  const dir = path.join(ws.music, "Mixed", "Album");
  fs.mkdirSync(dir, { recursive: true });
  /* Track 2 is a format Sonos will not decode, so the queue is one shorter
     than the list the album screen shows and counts positions in. */
  fs.writeFileSync(path.join(dir, "01 One.wav"), wav({ title: "One", album: "Album", track: 1 }));
  fs.writeFileSync(path.join(dir, "02 Two.wma"), Buffer.alloc(2048));
  fs.writeFileSync(path.join(dir, "03 Three.wav"), wav({ title: "Three", album: "Album", track: 3 }));
  fs.writeFileSync(path.join(dir, "04 Four.wav"), wav({ title: "Four", album: "Album", track: 4 }));

  const db = await scanned(ws);
  const fake = createFakeSonos({
    port: FAKE_PORT + 1, host: "127.0.0.1",
    zones: [{ uuid: "RINCON_AAA01400", name: "Kitchen", coordinator: "RINCON_AAA01400" }]
  });
  await fake.listen();
  try {
    const household = new sonosLib.Household({ hosts: ["127.0.0.1"], port: FAKE_PORT + 1 });
    await household.refresh({ force: true });
    const playback = new Playback({ db, household, baseUrl: () => "http://192.168.1.9:3400" });

    const albumId = db.prepare("SELECT id FROM albums").get().id;
    const album = library.album(db, albumId);
    assert.strictEqual(album.tracks.length, 4, "all four are listed");
    /* The untagged WMA sorts first, having no track number — which is exactly
       why the row's POSITION is the wrong thing to send to the queue builder. */
    const wma = album.tracks.find(t => t.title === "02 Two");
    assert.strictEqual(wma.playable, false, "the WMA is marked, not hidden");

    const row = album.tracks.findIndex(t => t.title === "Four");
    assert.ok(row > album.tracks.indexOf(wma), "the chosen row sits after the skipped file");
    await playback.playAlbum("RINCON_AAA01400", albumId, row);

    assert.strictEqual(fake.state.queue.length, 3, "the WMA never reached the queue");
    const started = fake.state.queue[fake.state.track - 1];
    const startedId = Buffer.from(/\/stream\/([A-Za-z0-9_-]+)\./.exec(started.uri)[1], "base64url").toString();
    assert.strictEqual(db.prepare("SELECT title FROM tracks WHERE id = ?").get(startedId).title, "Four",
      "an index counted in the full list must not be applied to the filtered one");
    db.close();
  } finally {
    await fake.close();
    ws.cleanup();
  }
});

test("Opus is reported unplayable, consistently on both sides", async () => {
  const ws = workspace();
  const dir = path.join(ws.music, "Opus", "Album");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "01 One.opus"), Buffer.alloc(2048));
  fs.writeFileSync(path.join(dir, "02 Two.wav"), wav({ title: "Two", album: "Album", track: 2 }));

  const db = await scanned(ws);
  const album = library.album(db, db.prepare("SELECT id FROM albums").get().id);
  const opus = album.tracks.find(t => t.title === "01 One");

  /* Opus maps to audio/ogg, which is why a MIME-based check in the client
     disagreed with the extension-based one on the server: the badge said
     nothing and then the track silently vanished on Play. */
  assert.strictEqual(opus.mime, "audio/ogg");
  assert.strictEqual(opus.playable, false, "Sonos does not decode Opus");
  assert.strictEqual(album.tracks.find(t => t.title === "Two").playable, true);
  db.close();
  ws.cleanup();
});

/* ---------------------------------------------------------------- */
/*  Discovery                                                        */
/* ---------------------------------------------------------------- */

test("a failed discovery is remembered, so the next request is not made to wait", async () => {
  const house = new sonosLib.Household({ hosts: ["127.0.0.1"], port: 11497 });

  const first = Date.now();
  await house.refresh({ force: true });
  const firstMs = Date.now() - first;
  assert.ok(house.lastError, "and the reason is kept");

  const second = Date.now();
  await house.refresh();
  const secondMs = Date.now() - second;

  assert.ok(secondMs < 100,
    `a second attempt inside the backoff must be free (was ${secondMs}ms, first was ${firstMs}ms)`);
});

test("a caller arriving during the first discovery waits for its answer", async () => {
  const fake = createFakeSonos({ port: 11496 });
  await fake.listen();
  try {
    const house = new sonosLib.Household({ hosts: ["127.0.0.1"], port: 11496 });
    /* Not awaited: the second call has to arrive while the first is still in
       flight, which is exactly what /api/status kicking off a refresh does to
       the /api/zones request behind it. */
    const inFlight = house.refresh({ force: true });
    const joined = await house.refresh();
    await inFlight;
    assert.strictEqual(joined.length, 2, "it joined the running refresh rather than the empty cache");
  } finally {
    await fake.close();
  }
});

/* ---------------------------------------------------------------- */
/*  The API                                                          */
/* ---------------------------------------------------------------- */

test("an artist whose name contains a percent sign has a working page", async () => {
  const ws = workspace();
  const dir = path.join(ws.music, "50% Off", "Discount");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "01 One.wav"),
    wav({ title: "One", artist: "50% Off", albumArtist: "50% Off", album: "Discount" }));

  const db = await scanned(ws);
  const express = require("express");
  const app = express();
  app.get("/api/artist/:name", (req, res) =>
    res.json({ artist: req.params.name, albums: library.byArtist(db, req.params.name) }));

  const server = app.listen(0, "127.0.0.1");
  await new Promise(done => server.on("listening", done));
  try {
    const port = server.address().port;
    const body = await new Promise((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port, path: "/api/artist/" + encodeURIComponent("50% Off") },
        res => {
          const chunks = [];
          res.on("data", c => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
        }).on("error", reject);
    });
    assert.strictEqual(body.status, 200, "decoding an already-decoded param threw URIError");
    assert.strictEqual(body.json.artist, "50% Off");
    assert.strictEqual(body.json.albums.length, 1);
  } finally {
    server.close();
    db.close();
    ws.cleanup();
  }
});

test("an upgrade that adds tag columns re-reads the files, instead of blanking albums", async () => {
  /*
   * The 0.1.0 → 0.2.0 shape of the bug, and the reason a large library came
   * back from a rescan full of "Unknown artist" and folder-name titles.
   *
   * 0.2.0 added album, album artist, genre and year as per-track columns and
   * started deriving the album from ALL of them. The migration added the
   * columns EMPTY, and the scan skips any file whose size and mtime have not
   * changed — so those files were never opened again, the columns stayed empty,
   * and the next scan derived the album from nothing.
   */
  const ws = workspace();
  buildLibrary(ws.music);
  const db = await scanned(ws);

  const before = db.prepare(
    "SELECT title, artist, year, genre FROM albums WHERE title = 'Spirit of Eden'").get();
  assert.deepStrictEqual(before,
    { title: "Spirit of Eden", artist: "Talk Talk", year: 1988, genre: "Art Rock" });

  /* Exactly what the migration leaves behind: the columns exist and are empty,
     and nothing records that they were never filled in. */
  db.prepare(`UPDATE tracks SET albumartist = '', album_tag = '', genre = '',
              year = NULL, tags_read = 0`).run();

  const stats = await scanner.scan(db, [ws.music], { artDir: ws.art });
  assert.strictEqual(stats.reused, 0, "every track was re-read, not skipped on mtime");
  assert.strictEqual(stats.parsed, 21);

  const after = db.prepare(
    "SELECT title, artist, year, genre FROM albums WHERE title = 'Spirit of Eden'").get();
  assert.deepStrictEqual(after, before, "and the album came back exactly as it was");
  ws.cleanup();
});

test("once re-read, a rescan goes back to skipping unchanged files", async () => {
  /* The re-read is a one-off. If tags_read were not written back, every scan
     would re-parse the whole library forever. */
  const ws = workspace();
  buildLibrary(ws.music);
  const db = await scanned(ws);
  db.prepare("UPDATE tracks SET tags_read = 0").run();

  const repair = await scanner.scan(db, [ws.music], { artDir: ws.art });
  assert.strictEqual(repair.parsed, 21, "the repair pass reads everything");

  const next = await scanner.scan(db, [ws.music], { artDir: ws.art });
  assert.strictEqual(next.parsed, 0, "and the one after it reads nothing");
  assert.strictEqual(next.reused, 21);
  ws.cleanup();
});
