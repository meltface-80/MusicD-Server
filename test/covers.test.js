"use strict";

/*
 * Finding a cover for an album that has none.
 *
 * The fake MusicBrainz below REFUSES a request that does not identify itself,
 * because the real one does — and a stand-in that answers whatever it is asked
 * tests the caller's happy path and nothing about whether the caller is asking
 * the right way. That lesson cost this project four passing transport tests
 * and three releases of a broken updater.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dbLib = require("../lib/db");
const scanner = require("../lib/scanner");
const library = require("../lib/library");
const { createCovers, userAgent } = require("../lib/covers");
const { wav, PNG_1PX } = require("./fixtures");

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-cover-"));
  return {
    root,
    music: path.join(root, "music"),
    data: path.join(root, "data"),
    art: path.join(root, "data", "cache", "art"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function putAlbum(root, dir, { album, artist, year, tracks, cover = false }) {
  const full = path.join(root, dir);
  fs.mkdirSync(full, { recursive: true });
  tracks.forEach((title, i) => {
    fs.writeFileSync(path.join(full, `${String(i + 1).padStart(2, "0")} ${title}.wav`),
      wav({ seconds: 1, title, artist, album, albumArtist: artist, year, track: i + 1 }));
  });
  if (cover) fs.writeFileSync(path.join(full, "cover.png"), PNG_1PX);
}

const SOUVLAKI = ["Alison", "Machine Gun", "40 Days"];

async function scanned(build) {
  const ws = workspace();
  build(ws);
  const db = dbLib.open(ws.data);
  await scanner.scan(db, [ws.music], { artDir: ws.art });
  return { ws, db };
}

/* ------------------------------------------------------------------ */
/*  A stand-in for the two services, as strict as the real ones        */
/* ------------------------------------------------------------------ */

function reply(status, body, type) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? type : null) },
    json: async () => body,
    arrayBuffer: async () => body
  };
}

function fakeInternet(plan = {}) {
  const calls = [];
  const impl = async (url, options) => {
    const agent = (options && options.headers && options.headers["User-Agent"]) || "";
    calls.push({ url, at: Date.now(), agent });

    /* MusicBrainz blocks a client that will not say who it is, and its terms
       require an application, a version and a contact. */
    if (/musicbrainz\.org/.test(url)) {
      if (!agent || !/\S+\/\d/.test(agent) || !/https?:\/\//.test(agent)) {
        return reply(403, { error: "no meaningful User-Agent" }, "application/json");
      }
    }
    for (const [pattern, answer] of Object.entries(plan)) {
      if (new RegExp(pattern).test(url)) {
        return typeof answer === "function" ? answer(url, calls) : answer;
      }
    }
    if (/coverartarchive\.org/.test(url)) return reply(404, Buffer.alloc(0), "text/plain");
    return reply(200, { "release-groups": [], recordings: [] }, "application/json");
  };
  return { impl, calls };
}

const releaseGroups = (groups) =>
  reply(200, { "release-groups": groups }, "application/json");

const image = () => reply(200, PNG_1PX, "image/png");

function coversFor(db, ws, plan, extra = {}) {
  return createCovers({
    db, dataDir: ws.data, version: "9.9.9",
    fetchImpl: plan.impl, gapMs: 5, ...extra
  });
}

/* ------------------------------------------------------------------ */

test("a cover is found by album name and stored beside the database", async () => {
  const { ws, db } = await scanned((w) => putAlbum(w.music, "Slowdive/Souvlaki",
    { album: "Souvlaki", artist: "Slowdive", year: 1993, tracks: SOUVLAKI }));

  const net = fakeInternet({
    "release-group/\\?query": releaseGroups([{
      id: "rg-1", score: 100, title: "Souvlaki",
      "artist-credit": [{ name: "Slowdive" }]
    }]),
    "coverartarchive\\.org/release-group/rg-1/front-1200": image()
  });
  const covers = coversFor(db, ws, net);
  const result = await covers.sweep();

  assert.strictEqual(result.found, 1);
  const row = db.prepare("SELECT art, art_fetched FROM albums WHERE title = 'Souvlaki'").get();
  assert.strictEqual(row.art, "", "the folder still has no cover in it");
  assert.ok(row.art_fetched, "and the album now points at one that was found");
  assert.ok(fs.existsSync(row.art_fetched));
  assert.ok(row.art_fetched.startsWith(ws.data), "stored under the data directory");

  /* Nothing was written next to the music. The mount is very often read-only,
     and it is the user's, not this program's. */
  assert.deepStrictEqual(
    fs.readdirSync(path.join(ws.music, "Slowdive/Souvlaki")).filter(f => !f.endsWith(".wav")), []);

  assert.ok(library.library(db, 10)[0].art, "the card shows a picture now");
  ws.cleanup();
});

test("every request says who is calling, the way MusicBrainz requires", async () => {
  const { ws, db } = await scanned((w) => putAlbum(w.music, "Slowdive/Souvlaki",
    { album: "Souvlaki", artist: "Slowdive", year: 1993, tracks: SOUVLAKI }));
  const net = fakeInternet({});
  await coversFor(db, ws, net).sweep();

  assert.ok(net.calls.length, "it did ask something");
  for (const call of net.calls) {
    assert.match(call.agent, /^MusicD-Server\/9\.9\.9 \( https:\/\/github\.com\/\S+ \)$/,
      "an application, a version and a contact");
  }
  /* A 403 for an anonymous client would have been recorded as "no release
     matched", which looks exactly like an album nobody has heard of. */
  assert.ok(!net.calls.some(c => !c.agent));
  assert.match(userAgent("1.2.3"), /MusicD-Server\/1\.2\.3/);
  ws.cleanup();
});

test("requests are spaced out, however many albums are missing a cover", async () => {
  const { ws, db } = await scanned((w) => {
    for (const n of ["One", "Two", "Three"]) {
      putAlbum(w.music, "Artist/" + n,
        { album: n, artist: "Artist", year: 2000, tracks: ["a", "b", "c"] });
    }
  });
  const net = fakeInternet({});
  const gap = 40;
  await coversFor(db, ws, net, { gapMs: gap }).sweep();

  const mb = net.calls.filter(c => /musicbrainz/.test(c.url));
  assert.ok(mb.length >= 3, "one search per album at least");
  for (let i = 1; i < mb.length; i++) {
    assert.ok(mb[i].at - mb[i - 1].at >= gap - 5,
      `request ${i} came ${mb[i].at - mb[i - 1].at}ms after the last, under the ${gap}ms gap`);
  }
  ws.cleanup();
});

test("a hit with the wrong artist is not this album's cover", async () => {
  const { ws, db } = await scanned((w) => putAlbum(w.music, "Slowdive/Souvlaki",
    { album: "Souvlaki", artist: "Slowdive", year: 1993, tracks: SOUVLAKI }));
  const net = fakeInternet({
    "release-group/\\?query": releaseGroups([{
      id: "rg-wrong", score: 100, title: "Souvlaki",
      "artist-credit": [{ name: "Some Tribute Band" }]
    }]),
    "coverartarchive": image()
  });
  const result = await coversFor(db, ws, net).sweep();

  assert.strictEqual(result.found, 0);
  assert.strictEqual(
    db.prepare("SELECT art_fetched FROM albums WHERE title = 'Souvlaki'").get().art_fetched, "");
  assert.ok(!net.calls.some(c => /coverartarchive/.test(c.url)),
    "and no image was downloaded on the strength of it");
  ws.cleanup();
});

test("a stylised artist name still matches", async () => {
  const { ws, db } = await scanned((w) => putAlbum(w.music, "Pink/Funhouse",
    { album: "Funhouse", artist: "P!nk", year: 2008, tracks: ["So What", "Sober", "Please"] }));
  const net = fakeInternet({
    "release-group/\\?query": releaseGroups([{
      id: "rg-2", score: 100, title: "Funhouse", "artist-credit": [{ name: "Pink" }]
    }]),
    "coverartarchive\\.org/release-group/rg-2/front-1200": image()
  });
  assert.strictEqual((await coversFor(db, ws, net).sweep()).found, 1);
  ws.cleanup();
});

/*
 * The path the user asked for by name: "use album name, artist name and track
 * names". The track names are the fallback, and they are only believed when
 * TWO of them agree on the same release — one track is on a dozen
 * compilations, so a single hit is not evidence of anything.
 */
test("track names find the album when the album tag does not", async () => {
  const { ws, db } = await scanned((w) => putAlbum(w.music, "Slowdive/Wrong Name",
    { album: "Not The Real Title", artist: "Slowdive", year: 1993, tracks: SOUVLAKI }));

  const net = fakeInternet({
    "release-group/\\?query": releaseGroups([]),
    "recording/\\?query": (url) => reply(200, {
      recordings: [{
        score: 100, "artist-credit": [{ name: "Slowdive" }],
        releases: [
          /* Listed FIRST, and only for the first track. Taking the first
             release a track points at would pick this one — the agreement
             between two tracks is the whole of the evidence, so the fixture
             has to make "first" and "agreed on" different answers. */
          ...(/Alison/.test(url) ? [{ "release-group": { id: "rg-a-compilation" } }] : []),
          { "release-group": { id: "rg-souvlaki" } }
        ]
      }]
    }, "application/json"),
    "coverartarchive\\.org/release-group/rg-souvlaki/front-1200": image()
  });

  assert.strictEqual((await coversFor(db, ws, net).sweep()).found, 1);
  assert.ok(net.calls.some(c => /rg-souvlaki/.test(c.url)),
    "the release both tracks pointed at");
  assert.ok(!net.calls.some(c => /rg-a-compilation/.test(c.url)),
    "not the one only a single track pointed at");
  ws.cleanup();
});

test("an album whose folder has a cover is never asked about", async () => {
  const { ws, db } = await scanned((w) => putAlbum(w.music, "Slowdive/Souvlaki",
    { album: "Souvlaki", artist: "Slowdive", year: 1993, tracks: SOUVLAKI, cover: true }));
  const net = fakeInternet({});
  const covers = coversFor(db, ws, net);
  assert.deepStrictEqual(covers.pending(), []);
  await covers.sweep();
  assert.strictEqual(net.calls.length, 0, "nothing left this machine");
  ws.cleanup();
});

test("a miss is remembered, so the next sweep does not ask again", async () => {
  const { ws, db } = await scanned((w) => putAlbum(w.music, "Slowdive/Souvlaki",
    { album: "Souvlaki", artist: "Slowdive", year: 1993, tracks: SOUVLAKI }));
  const net = fakeInternet({});
  const covers = coversFor(db, ws, net);

  await covers.sweep();
  const asked = net.calls.length;
  assert.ok(asked > 0);

  await covers.sweep();
  assert.strictEqual(net.calls.length, asked,
    "a library of coverless bootlegs must not re-ask about all of them every scan");

  /* A week later it is worth another try — MusicBrainz gains releases. */
  db.prepare("UPDATE cover_lookups SET tried_at = ?").run(Date.now() - 8 * 86400000);
  await covers.sweep();
  assert.ok(net.calls.length > asked);
  ws.cleanup();
});

test("being asked to slow down stops the sweep rather than grinding on", async () => {
  const { ws, db } = await scanned((w) => {
    for (const n of ["One", "Two", "Three", "Four"]) {
      putAlbum(w.music, "Artist/" + n,
        { album: n, artist: "Artist", year: 2000, tracks: ["a", "b", "c"] });
    }
  });
  const net = fakeInternet({
    "musicbrainz": reply(503, { error: "slow down" }, "application/json")
  });
  const covers = coversFor(db, ws, net);
  const result = await covers.sweep();

  assert.strictEqual(result.found, 0);
  assert.match(result.error, /slower pace/);
  assert.strictEqual(net.calls.length, 1,
    "one refusal is enough; four more would be how a throttle becomes a block");
  /* And nothing was recorded as a miss, so the retry is not a week away. */
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM cover_lookups").get().n, 0);
  ws.cleanup();
});

test("switched off, it asks nothing", async () => {
  const { ws, db } = await scanned((w) => putAlbum(w.music, "Slowdive/Souvlaki",
    { album: "Souvlaki", artist: "Slowdive", year: 1993, tracks: SOUVLAKI }));
  const net = fakeInternet({});
  const covers = coversFor(db, ws, net, { enabled: false });
  await covers.sweep();
  assert.strictEqual(net.calls.length, 0);
  assert.strictEqual(covers.status().enabled, false);
  covers.setEnabled(true);
  await covers.sweep();
  assert.ok(net.calls.length > 0, "and everything again once it is switched back on");
  ws.cleanup();
});

/*
 * The bug this column exists to prevent. The scan rewrites `art` from what is
 * in the folder on every pass, so a cover kept there would be wiped by the
 * next rescan and fetched all over again — every six hours, forever.
 */
test("a rescan does not throw away a cover that was found", async () => {
  const { ws, db } = await scanned((w) => putAlbum(w.music, "Slowdive/Souvlaki",
    { album: "Souvlaki", artist: "Slowdive", year: 1993, tracks: SOUVLAKI }));
  const net = fakeInternet({
    "release-group/\\?query": releaseGroups([{
      id: "rg-1", score: 100, title: "Souvlaki", "artist-credit": [{ name: "Slowdive" }]
    }]),
    "coverartarchive\\.org/release-group/rg-1/front-1200": image()
  });
  const covers = coversFor(db, ws, net);
  await covers.sweep();
  const before = db.prepare("SELECT art_fetched FROM albums WHERE title = 'Souvlaki'").get();
  assert.ok(before.art_fetched);

  await scanner.scan(db, [ws.music], { artDir: ws.art });

  const after = db.prepare("SELECT art_fetched FROM albums WHERE title = 'Souvlaki'").get();
  assert.strictEqual(after.art_fetched, before.art_fetched);
  assert.deepStrictEqual(covers.pending(), [], "and it is not on the list to look for again");
  ws.cleanup();
});

test("an album with nothing specific to search on is not searched for", async () => {
  const { ws, db } = await scanned((w) => putAlbum(w.music, "Unknown/Field Recordings",
    { album: "", artist: "", year: "", tracks: ["One", "Two"] }));
  const net = fakeInternet({});
  await coversFor(db, ws, net).sweep();
  assert.strictEqual(net.calls.length, 0,
    "a blank artist matches half a catalogue, so there is no query worth making");
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM cover_lookups").get().n, 1,
    "and it is written down, so it is not reconsidered every scan");
  ws.cleanup();
});

test("a release with no art at any size costs one request, not three", async () => {
  const { ws, db } = await scanned((w) => putAlbum(w.music, "Slowdive/Souvlaki",
    { album: "Souvlaki", artist: "Slowdive", year: 1993, tracks: SOUVLAKI }));
  const net = fakeInternet({
    "release-group/\\?query": releaseGroups([{
      id: "rg-1", score: 100, title: "Souvlaki", "artist-credit": [{ name: "Slowdive" }]
    }])
  });
  await coversFor(db, ws, net).sweep();
  const images = net.calls.filter(c => /coverartarchive/.test(c.url));
  assert.strictEqual(images.length, 1, "a 404 means no art at all, so the other sizes are pointless");
  ws.cleanup();
});
