"use strict";

/*
 * Saying WHICH RECORD an album is.
 *
 * The whole risk in this module is that a search always answers. So most of
 * what is checked here is what it REFUSES: another artist's record, a name
 * with no relation to the one asked about, an id that was never offered.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dbLib = require("../lib/db");
const scanner = require("../lib/scanner");
const { createCovers } = require("../lib/covers");
const { createIdentify } = require("../lib/identify");
const { wav } = require("./fixtures");

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-ident-"));
  const dirs = { root, music: path.join(root, "music"), data: path.join(root, "data") };
  fs.mkdirSync(dirs.music, { recursive: true });
  fs.mkdirSync(dirs.data, { recursive: true });
  dirs.cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return dirs;
}

const ACCELERATE = ["Living Well Is The Best Revenge", "Man-Sized Wreath",
                    "Supernatural Superserious"];

async function scanned({ album = "Accelerate", artist = "REM", tracks = ACCELERATE } = {}) {
  const ws = workspace();
  const dir = path.join(ws.music, artist, album);
  fs.mkdirSync(dir, { recursive: true });
  tracks.forEach((title, i) => fs.writeFileSync(
    path.join(dir, `${String(i + 1).padStart(2, "0")} ${title}.wav`),
    wav({ seconds: 1, title, artist, album, albumArtist: artist, track: i + 1 })));
  const db = dbLib.open(ws.data);
  await scanner.scan(db, [ws.music], { artDir: path.join(ws.data, "art") });
  const id = db.prepare("SELECT id FROM albums WHERE present = 1").get().id;
  return { ws, db, id };
}

/* A stand-in for MusicBrainz that refuses an unidentified client the way the
   real one does. A permissive fake would pass every test here while the real
   service answered 403 to all of it. */
function fakeMusicBrainz(releases, seen = []) {
  return async (url, options) => {
    const agent = (options && options.headers && options.headers["User-Agent"]) || "";
    seen.push({ url, agent });
    if (!agent || !/\S+\/\d/.test(agent) || !/https?:\/\//.test(agent)) {
      return { ok: false, status: 403, headers: { get: () => "application/json" },
               json: async () => ({ error: "no meaningful User-Agent" }) };
    }
    return { ok: true, status: 200, headers: { get: () => "application/json" },
             json: async () => ({ releases }) };
  };
}

function identifierFor(db, ws, releases, seen, extra = {}) {
  const covers = createCovers({
    db, dataDir: ws.data, version: "9.9.9",
    fetchImpl: fakeMusicBrainz(releases, seen), gapMs: 5
  });
  return { identify: createIdentify({ db, covers, ...extra }), covers };
}

const release = (over) => ({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  score: 100, title: "Accelerate", status: "Official",
  "artist-credit": [{ name: "R.E.M." }],
  "track-count": 3, date: "2008-03-31", country: "GB", ...over
});

/* ------------------------------------------------------------------ */

test("a release that agrees with the library's own facts is offered", async () => {
  const { ws, db, id } = await scanned();
  try {
    const seen = [];
    const { identify } = identifierFor(db, ws, [release()], seen);
    const out = await identify.candidatesFor(id, "Accelerate", "REM");
    assert.strictEqual(out.length, 1, JSON.stringify(out));
    assert.strictEqual(out[0].title, "Accelerate");
    assert.strictEqual(out[0].sameLength, true, "three tracks on disk, three in the release");
    assert.match(out[0].why, /3 tracks/);
    assert.match(out[0].why, /2008/);
    /* Told MusicBrainz who was asking — the real one 403s a client that
       will not say. */
    assert.match(seen[0].agent, /MusicD-Server\/9\.9\.9 \( https/);
    assert.match(seen[0].url, /\/release\/\?query=/);
  } finally { db.close(); ws.cleanup(); }
});

test("nothing is written by asking", async () => {
  const { ws, db, id } = await scanned();
  try {
    const { identify } = identifierFor(db, ws, [release()], []);
    await identify.candidatesFor(id, "Accelerate", "REM");
    assert.strictEqual(identify.current(id).from, "", "still unidentified until somebody taps one");
    assert.strictEqual(
      db.prepare("SELECT mbid_chosen FROM albums WHERE id = ?").get(id).mbid_chosen, "");
  } finally { db.close(); ws.cleanup(); }
});

test("confirming one stores the release id and NOTHING else", async () => {
  const { ws, db, id } = await scanned();
  try {
    const before = db.prepare("SELECT title, artist, year, genre FROM albums WHERE id = ?").get(id);
    const { identify } = identifierFor(db, ws, [release()], []);
    await identify.candidatesFor(id, "Accelerate", "REM");
    const now = identify.chooseFor(id, 0);

    assert.strictEqual(now.mbid, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.strictEqual(now.from, "chosen");
    const after = db.prepare("SELECT title, artist, year, genre FROM albums WHERE id = ?").get(id);
    assert.deepStrictEqual(after, before, "not a title, not an artist, not a year, not a genre");
  } finally { db.close(); ws.cleanup(); }
});

test("another artist's record of the same name is not this album", async () => {
  /* THE WHOLE POINT. A search always answers, and "Accelerate" is a common
     enough title that somebody else has used it. */
  const { ws, db, id } = await scanned();
  try {
    const { identify } = identifierFor(db, ws, [
      release({ "artist-credit": [{ name: "Christina Aguilera" }] }),
      release({ "artist-credit": [{ name: "Remedy" }] })   // merely CONTAINS "rem"
    ], []);
    const out = await identify.candidatesFor(id, "Accelerate", "REM");
    assert.deepStrictEqual(out, [], JSON.stringify(out));
  } finally { db.close(); ws.cleanup(); }
});

test("a record with no relation to the name is not offered at the bottom", async () => {
  /* Offering it last is how somebody taps it at half past eleven. The title is
     a gate, not a point. */
  const { ws, db, id } = await scanned();
  try {
    const { identify } = identifierFor(db, ws, [
      release({ title: "Automatic for the People" }),
      release({ title: "Green" })
    ], []);
    const out = await identify.candidatesFor(id, "Accelerate", "REM");
    assert.deepStrictEqual(out, [], JSON.stringify(out));
  } finally { db.close(); ws.cleanup(); }
});

test("the pressing with your track count is offered first", async () => {
  /* A name is shared by a dozen releases; a name AND an exact track count
     almost never is. It is the strongest thing the library knows. */
  const { ws, db, id } = await scanned();
  try {
    const { identify } = identifierFor(db, ws, [
      release({ id: "11111111-1111-1111-1111-111111111111",
                "track-count": 24, date: "2011", score: 100, country: "US" }),
      release({ id: "22222222-2222-2222-2222-222222222222",
                "track-count": 3, date: "2008", score: 90, country: "GB" })
    ], []);
    const out = await identify.candidatesFor(id, "Accelerate", "REM");
    assert.strictEqual(out.length, 2, JSON.stringify(out));
    assert.strictEqual(out[0].sameLength, true, out.map(o => o.why).join(" | "));
    identify.chooseFor(id, 0);
    assert.strictEqual(identify.current(id).mbid, "22222222-2222-2222-2222-222222222222");
  } finally { db.close(); ws.cleanup(); }
});

test("an id that was never offered cannot be stored", async () => {
  /* The server holds the list. A client answers with a POSITION, because a
     server that stores an identifier a phone hands it has checked nothing. */
  const { ws, db, id } = await scanned();
  try {
    const { identify } = identifierFor(db, ws, [release()], []);
    assert.throws(() => identify.chooseFor(id, 0), /expired/,
      "nothing was offered yet, so there is nothing to choose");
    await identify.candidatesFor(id, "Accelerate", "REM");
    assert.throws(() => identify.chooseFor(id, 7), /not one of the results/);
    assert.throws(() => identify.chooseFor(id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
      /not one of the results/);
    assert.strictEqual(identify.current(id).from, "");
  } finally { db.close(); ws.cleanup(); }
});

test("a malformed id from the service never becomes an identity", async () => {
  const { ws, db, id } = await scanned();
  try {
    const { identify } = identifierFor(db, ws, [
      release({ id: "../../etc/passwd" }), release({ id: "" })
    ], []);
    const out = await identify.candidatesFor(id, "Accelerate", "REM");
    assert.deepStrictEqual(out, []);
  } finally { db.close(); ws.cleanup(); }
});

test("a confirmation outranks the tag, and clearing it falls back", async () => {
  const { ws, db, id } = await scanned();
  try {
    db.prepare("UPDATE tracks SET mbid = ?").run("99999999-9999-9999-9999-999999999999");
    const { identify } = identifierFor(db, ws, [release()], []);
    assert.strictEqual(identify.current(id).from, "tags");

    await identify.candidatesFor(id, "Accelerate", "REM");
    identify.chooseFor(id, 0);
    assert.strictEqual(identify.current(id).mbid, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "what a person confirmed beats what a ripper wrote");

    identify.clearFor(id);
    assert.strictEqual(identify.current(id).mbid, "99999999-9999-9999-9999-999999999999",
      "the tag underneath was never touched");
    assert.strictEqual(identify.current(id).from, "tags");
  } finally { db.close(); ws.cleanup(); }
});

test("the fields are searched with, not the stored names", async () => {
  /* The albums worth identifying are the ones whose stored names are wrong.
     Correcting the name in the box is how somebody says so — the same rule
     Find cover follows. */
  const { ws, db, id } = await scanned({ album: "Accelerate", artist: "REM - Discography" });
  try {
    const seen = [];
    const { identify } = identifierFor(db, ws, [release()], seen);
    await identify.candidatesFor(id, "Accelerate", "R.E.M.");
    const query = decodeURIComponent(seen[0].url);
    assert.match(query, /artist:"R\.E\.M\."/, query);
    assert.ok(!/Discography/.test(query), query);
  } finally { db.close(); ws.cleanup(); }
});

test("an album with no artist to search on is refused rather than guessed at", async () => {
  const { ws, db, id } = await scanned();
  try {
    const seen = [];
    const { identify } = identifierFor(db, ws, [release()], seen);
    await assert.rejects(() => identify.candidatesFor(id, "Accelerate", "  "),
      /nothing to search on/);
    assert.strictEqual(seen.length, 0, "and nothing was asked");
  } finally { db.close(); ws.cleanup(); }
});

test("IDENTIFY=false answers off without touching the network", async () => {
  const { ws, db, id } = await scanned();
  try {
    const seen = [];
    const { identify } = identifierFor(db, ws, [release()], seen, { available: false });
    assert.strictEqual(identify.status().available, false);
    await assert.rejects(() => identify.candidatesFor(id, "Accelerate", "REM"), /switched off/);
    assert.strictEqual(seen.length, 0);
  } finally { db.close(); ws.cleanup(); }
});

test("a confirmed release makes the cover EXACT, with no search at all", async () => {
  /*
   * THE WHOLE REASON THIS EXISTS. With an id there is no query, no scoring and
   * no near-miss: the Cover Art Archive is asked about THAT release. The
   * albums that need it most are the ones whose names are worst, which are
   * exactly the ones a name search cannot rescue.
   */
  const { ws, db, id } = await scanned();
  try {
    const seen = [];
    const asked = [];
    const covers = createCovers({
      db, dataDir: ws.data, version: "9.9.9", gapMs: 5,
      fetchImpl: async (url, options) => {
        asked.push(url);
        if (/musicbrainz/.test(url)) return fakeMusicBrainz([release()], seen)(url, options);
        /* The Cover Art Archive, answering for the release it was asked about. */
        return { ok: true, status: 200,
                 headers: { get: (h) => (h === "content-type" ? "image/png" : null) },
                 arrayBuffer: async () => Buffer.from("89504e470d0a1a0a0000000d49484452", "hex") };
      }
    });
    const identify = createIdentify({ db, covers });
    await identify.candidatesFor(id, "Accelerate", "REM");
    identify.chooseFor(id, 0);

    asked.length = 0;
    await covers.sweep();
    assert.strictEqual(covers.status().fetched, 1, asked.join(" | "));
    assert.ok(!asked.some(u => /\?query=|itunes/.test(u)),
      "nothing was searched for: " + asked.join(" | "));
    assert.ok(asked.some(u => u.includes("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")),
      "the confirmed release is what was asked about: " + asked.join(" | "));
  } finally { db.close(); ws.cleanup(); }
});

test("identification and covers queue on ONE gate", async () => {
  /*
   * MusicBrainz asks for a request a second per APPLICATION. Two modules each
   * politely waiting a second of their own is two requests a second from this
   * one app — the rate limit broken by the code written to honour it.
   */
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "identify.js"), "utf8");
  assert.ok(!/setTimeout|setInterval/.test(src), "no timer of its own");
  assert.match(src, /covers\.searchMusicBrainz\(/, "it asks through lib/covers.js's gate");
  assert.ok(!/https?:\/\/musicbrainz/.test(src), "and does not know the address");
});

test("nothing it learns is written back but the id", () => {
  /* The rule this module lives under. lib/duplicates.js decides what is one
     record by looking at the disk, and a regroup MOVES play counts — so a
     website must never be able to cause one. */
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "identify.js"), "utf8");
  const writes = src.match(/UPDATE albums SET [^"]+/g) || [];
  assert.deepStrictEqual([...new Set(writes.map(w => w.replace(/\s+/g, " ").trim()))],
    ["UPDATE albums SET mbid_chosen = ? WHERE id = ?",
     "UPDATE albums SET mbid_chosen = '' WHERE id = ?"]);
  assert.ok(!/UPDATE tracks|INSERT INTO albums|version_of/.test(src));
});
