"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const { buildLibrary } = require("./fixtures");
const { encodeId, decodeId } = require("../lib/ids");

/* index.js reads its configuration from the environment at require time, so
   the workspace has to exist before it is loaded. Everything in this file
   shares the one server, which is also what proves the module is importable
   without binding a port or starting to poll speakers. */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-api-"));
process.env.MUSIC_DIRS = path.join(ROOT, "music");
process.env.DATA_DIR = path.join(ROOT, "data");
process.env.SCAN_ON_START = "false";
/* Nothing in a test run reaches the internet. lib/covers.js is exercised
   against a stand-in in test/covers.test.js; here the switch is off so that a
   rescan or a status poll cannot start a real lookup. */
process.env.COVER_LOOKUP = "false";
process.env.SERVER_IP = "192.168.1.9";
process.env.PORT = "3400";   // the advertised port, not the one the test binds
buildLibrary(process.env.MUSIC_DIRS);

const server = require("../index");
let base = "";
let listener = null;

test.before(async () => {
  listener = await new Promise(resolve => {
    const s = server.app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${s.address().port}`;
      resolve(s);
    });
  });
  await server.runScan("test");
});

test.after(async () => {
  if (listener) await new Promise(done => listener.close(done));
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function request(pathname, { headers = {}, method = "GET", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: payload
        ? { "Content-Type": "application/json", "Content-Length": payload.length, ...headers }
        : headers
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)
      }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function json(pathname, options) {
  const res = await request(pathname, options);
  return { status: res.status, body: JSON.parse(res.body.toString("utf8")) };
}

/* ---------------------------------------------------------------- */
/*  Status and home                                                  */
/* ---------------------------------------------------------------- */

test("cover lookup reports itself off when the container says so", async () => {
  const status = await json("/api/status");
  assert.strictEqual(status.body.covers.enabled, false);
  /* `available` has to travel in the STATUS, not only in the /api/covers
     replies: the side menu is painted from /api/status, and a status without
     it left the row hidden for ever in 0.4.9 — the feature shipped and could
     not be reached. */
  assert.ok("available" in status.body.covers,
    "the status says whether the container allows this at all");
  assert.strictEqual(status.body.covers.available, false);

  const covers = await json("/api/covers");
  assert.strictEqual(covers.body.available, false,
    "the switch is absent from the app, not merely off");

  /* And it cannot be talked into it from a phone. COVER_LOOKUP is the one
     answer a browser must not be able to override. */
  const refused = await json("/api/covers", { method: "POST", body: { enabled: true } });
  assert.strictEqual(refused.status, 409);
  assert.match(String(refused.body.error || ""), /switched off/);
  assert.strictEqual((await json("/api/covers")).body.enabled, false);
});

test("Last.fm is absent from a server that was given no key", async () => {
  /* Last.fm has no anonymous mode and no OAuth 2 — every call carries an
     api_key — so a container without one has nothing to offer, and says so
     rather than showing a row that cannot work. */
  const status = await json("/api/status");
  assert.strictEqual(status.body.lastfm.configured, false);
  assert.strictEqual(status.body.lastfm.connected, false);

  const started = await json("/api/lastfm/start", { method: "POST", body: {} });
  assert.strictEqual(started.status, 500);
  assert.match(String(started.body.error || ""), /not set up/);
});

test("status reports the library, the scan and the time zone", async () => {
  const { status, body } = await json("/api/status");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.stats.albums, 6);
  assert.strictEqual(body.stats.tracks, 21);
  assert.strictEqual(body.scan.running, false);
  assert.ok(body.time.zone, "the container's time zone is reported — the 6-month row needs it");
  assert.strictEqual(body.sonos.origin, "http://192.168.1.9:" + process.env.PORT,
    "the address speakers are given honours SERVER_IP");
});

test("home returns the six rows, in order", async () => {
  const { body } = await json("/api/home");
  assert.deepStrictEqual(body.rows.map(r => r.key),
    ["library", "random", "added", "played", "unplayed", "picks"]);
  assert.deepStrictEqual(body.rows.map(r => r.title), [
    "Library", "Random albums", "Recently added", "Recently played",
    "Not played in 6 months", "Smart Picks"
  ]);
});

test("home fills Library, Random and Recently added, and explains the empty rows", async () => {
  const { body } = await json("/api/home");
  const row = (key) => body.rows.find(r => r.key === key);

  assert.strictEqual(row("library").albums.length, 6);
  assert.strictEqual(row("random").albums.length, 6);
  assert.strictEqual(row("added").albums.length, 6);

  assert.deepStrictEqual(row("played").albums, [], "nothing has been played yet");
  assert.deepStrictEqual(row("unplayed").albums, []);
  assert.match(row("unplayed").empty, /six months/,
    "an empty row says why, so it does not read as a fault");
  assert.match(row("picks").empty, /Play a few albums/);
});

test("an album card carries everything the grid needs and nothing it does not", async () => {
  const { body } = await json("/api/home");
  const album = body.rows[0].albums.find(a => a.title === "Souvlaki");
  assert.deepStrictEqual(Object.keys(album).sort(), [
    "addedAt", "art", "artist", "duration", "genre", "id",
    "lastPlayedAt", "playCount", "title", "trackCount", "year"
  ]);
  assert.strictEqual(album.artist, "Slowdive");
  assert.strictEqual(album.year, 1993);
  assert.strictEqual(album.playCount, 0);
  assert.strictEqual(album.lastPlayedAt, null);
});

/* ---------------------------------------------------------------- */
/*  The home screen's order                                          */
/* ---------------------------------------------------------------- */

test("the row order is readable, and names every row", async () => {
  const { body } = await json("/api/rows");
  assert.deepStrictEqual(body.order,
    ["favourites", "library", "random", "added", "played", "unplayed", "picks"]);
  /* The menu needs a name for each, and it must be the same name the home
     screen uses — one table on the server rather than two lists to keep in
     step. */
  assert.strictEqual(body.titles.picks, "Smart Picks");
  assert.strictEqual(body.titles.unplayed, "Not played in 6 months");
  assert.deepStrictEqual(Object.keys(body.titles).sort(), [...body.order].sort());
});

test("Missing covers is a grid screen, and not one of the home rows", async () => {
  /*
   * It used to be a list inside the side menu, which meant tapping an album
   * opened its panel over whatever was behind the drawer — so Back landed on
   * Home rather than on the albums you were working through. It is a wall of
   * albums now, so it is a row /api/albums can open, and Back lands on it.
   *
   * NOT a home row: it is a maintenance screen. lib/settings.js's DEFAULT_ROWS
   * is what the home screen is made of, and this is deliberately absent from
   * it, so neither Home nor Settings > Home screen offers it.
   */
  const rows = await json("/api/rows");
  assert.ok(!rows.body.order.includes("nocover"), "not on the home screen");
  assert.ok(!("nocover" in rows.body.titles), "and not offered as a carousel");
  /* Still a name for every row that IS listed — the menu reads these. */
  assert.deepStrictEqual(Object.keys(rows.body.titles).sort(), [...rows.body.order].sort());

  const grid = await json("/api/albums?row=nocover&limit=200");
  assert.strictEqual(grid.status, 200);
  const names = grid.body.albums.map(a => a.title);
  /* Hex has no cover.png in the fixture library; Spirit of Eden has one. */
  assert.ok(names.includes("Hex"), names.join(", "));
  assert.ok(!names.includes("Spirit of Eden"), names.join(", "));
  /* And they are albums, not a bare list of names: the wall paints the same
     card every other grid does. */
  for (const album of grid.body.albums) {
    assert.strictEqual(album.art, "", album.title + " is on this wall for a reason");
    assert.ok("trackCount" in album && "duration" in album, "the full album shape");
  }
});

test("the missing wall says why, not just which", async () => {
  /*
   * "no artist to search on" is an answer somebody can act on and a bare name
   * is not — it is the whole reason this screen beats a count. It rides in on
   * `reason`, the same field Smart Picks uses.
   */
  const hex = server.db.prepare(
    "SELECT id FROM albums WHERE title = 'Hex'").get();
  assert.ok(hex, "the fixture library has Hex");
  server.db.prepare(
    `INSERT INTO cover_lookups (album_id, tried_at, ok, source, note, gen)
     VALUES (?, ?, 0, '', ?, 1)
     ON CONFLICT(album_id) DO UPDATE SET note = excluded.note, ok = 0`)
    .run(hex.id, Date.now(), "nothing on the Cover Art Archive");

  const { body } = await json("/api/albums?row=nocover&limit=200");
  const row = body.albums.find(a => a.id === hex.id);
  assert.ok(row, "still on the wall — a miss is not a cover");
  assert.strictEqual(row.reason, "nothing on the Cover Art Archive");

  /* A hit is a different row in the same table, and must not become a reason:
     the album leaves the wall instead. */
  server.db.prepare("DELETE FROM cover_lookups WHERE album_id = ?").run(hex.id);
});

test("rearranging the rows rearranges the home screen", async () => {
  const wanted = ["picks", "unplayed", "played", "added", "random", "library", "favourites"];
  const { body: saved } = await json("/api/rows", { method: "POST", body: { order: wanted } });
  assert.deepStrictEqual(saved.order, wanted);

  const { body: home } = await json("/api/home");
  /* Favourites is absent when there are none, so compare what is left. */
  assert.deepStrictEqual(home.rows.map(r => r.key),
    wanted.filter(k => k !== "favourites"));

  /* Put it back, so the order of tests in this file cannot matter. */
  await json("/api/rows", { method: "POST", body: { order: [] } });
  const { body: back } = await json("/api/home");
  assert.strictEqual(back.rows[0].key, "library");
});

test("an order naming rows that do not exist still leaves a whole home screen", async () => {
  await json("/api/rows", { method: "POST", body: { order: ["nope", "picks", 42] } });
  const { body } = await json("/api/rows");
  assert.strictEqual(body.order[0], "picks", "what it could use, it used");
  assert.deepStrictEqual([...body.order].sort(),
    ["added", "favourites", "library", "picks", "played", "random", "unplayed"],
    "and every row is still there");
  await json("/api/rows", { method: "POST", body: { order: [] } });
});

/* ---------------------------------------------------------------- */
/*  Rows, albums, search                                             */
/* ---------------------------------------------------------------- */

test("every home row is also a full grid", async () => {
  for (const row of ["library", "random", "added", "played", "unplayed", "picks"]) {
    const { status, body } = await json("/api/albums?row=" + row);
    assert.strictEqual(status, 200, row);
    assert.ok(Array.isArray(body.albums), row);
  }
});

test("an unknown row is refused rather than silently answered", async () => {
  const { status, body } = await json("/api/albums?row=labels");
  assert.strictEqual(status, 400);
  assert.match(body.error, /Unknown row/);
});

test("an album comes back with its tracks", async () => {
  const { body: home } = await json("/api/home");
  const spirit = home.rows[0].albums.find(a => a.title === "Spirit of Eden");
  const { status, body } = await json("/api/album/" + encodeId(spirit.id));
  assert.strictEqual(status, 200);
  assert.strictEqual(body.tracks.length, 6);
  assert.strictEqual(body.tracks[0].title, "The Rainbow");
  assert.strictEqual(body.multiDisc, false);
});

test("an album id that does not exist is a 404, not a crash", async () => {
  const { status } = await json("/api/album/" + encodeId("a:nowhere"));
  assert.strictEqual(status, 404);
  const bad = await json("/api/album/!!!not-base64!!!");
  assert.ok(bad.status === 404 || bad.status === 400);
});

test("search covers albums, artists and tracks", async () => {
  const { body } = await json("/api/search?q=Talk");
  assert.strictEqual(body.albums.length, 2);
  assert.strictEqual(body.artists[0].name, "Talk Talk");
});

test("artists lists every album artist with a count", async () => {
  const { body } = await json("/api/artists");
  const names = body.artists.map(a => a.name);
  assert.ok(names.includes("Talk Talk"));
  assert.strictEqual(body.artists.find(a => a.name === "Talk Talk").albums, 2);
});

test("an artist page lists their albums oldest first", async () => {
  const { body } = await json("/api/artist/" + encodeURIComponent("Talk Talk"));
  assert.deepStrictEqual(body.albums.map(a => a.title), ["Spirit of Eden", "Laughing Stock"]);
});

/* ---------------------------------------------------------------- */
/*  Media                                                            */
/* ---------------------------------------------------------------- */

async function firstTrack() {
  const { body: home } = await json("/api/home");
  const album = home.rows[0].albums.find(a => a.title === "Souvlaki");
  const { body } = await json("/api/album/" + encodeId(album.id));
  return { album, track: body.tracks[0] };
}

test("a whole track streams with a length and a range offer", async () => {
  const { track } = await firstTrack();
  const res = await request(`/stream/${encodeId(track.id)}.wav`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers["accept-ranges"], "bytes");
  assert.strictEqual(res.headers["content-type"], "audio/wav");
  assert.strictEqual(Number(res.headers["content-length"]), res.body.length);
  assert.strictEqual(res.body.subarray(0, 4).toString("ascii"), "RIFF", "it is the real file");
});

test("a byte range is honoured — Sonos opens every track with one", async () => {
  const { track } = await firstTrack();
  const whole = await request(`/stream/${encodeId(track.id)}.wav`);
  const part = await request(`/stream/${encodeId(track.id)}.wav`, { headers: { Range: "bytes=100-199" } });

  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.body.length, 100);
  assert.strictEqual(part.headers["content-range"], `bytes 100-199/${whole.body.length}`);
  assert.ok(part.body.equals(whole.body.subarray(100, 200)), "and it is the right 100 bytes");
});

test("an open-ended range runs to the end of the file", async () => {
  const { track } = await firstTrack();
  const whole = await request(`/stream/${encodeId(track.id)}.wav`);
  const rest = await request(`/stream/${encodeId(track.id)}.wav`, { headers: { Range: "bytes=200-" } });
  assert.strictEqual(rest.status, 206);
  assert.strictEqual(rest.body.length, whole.body.length - 200);
});

test("a suffix range returns the last bytes", async () => {
  const { track } = await firstTrack();
  const whole = await request(`/stream/${encodeId(track.id)}.wav`);
  const tail = await request(`/stream/${encodeId(track.id)}.wav`, { headers: { Range: "bytes=-50" } });
  assert.strictEqual(tail.status, 206);
  assert.strictEqual(tail.body.length, 50);
  assert.ok(tail.body.equals(whole.body.subarray(whole.body.length - 50)));
});

test("a range past the end of the file is refused with 416", async () => {
  const { track } = await firstTrack();
  const res = await request(`/stream/${encodeId(track.id)}.wav`,
    { headers: { Range: "bytes=99999999-" } });
  assert.strictEqual(res.status, 416);
  assert.match(res.headers["content-range"], /^bytes \*\/\d+$/);
});

test("a HEAD gives the length without the body", async () => {
  const { track } = await firstTrack();
  const res = await request(`/stream/${encodeId(track.id)}.wav`, { method: "HEAD" });
  assert.strictEqual(res.status, 200);
  assert.ok(Number(res.headers["content-length"]) > 0);
  assert.strictEqual(res.body.length, 0);
});

test("streaming an unknown track is a 404", async () => {
  const res = await request(`/stream/${encodeId("t:nope.flac")}.flac`);
  assert.strictEqual(res.status, 404);
});

test("cover art is served, and cached", async () => {
  const { album } = await firstTrack();
  const res = await request(`/art/${encodeId(album.id)}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers["content-type"], "image/png");
  assert.match(res.headers["cache-control"], /max-age=/);
  assert.strictEqual(res.body.subarray(1, 4).toString("ascii"), "PNG");
});

test("an album with no cover 404s rather than serving something wrong", async () => {
  const { body: home } = await json("/api/home");
  const hex = home.rows[0].albums.find(a => a.title === "Hex");
  assert.strictEqual(hex.art, "", "the card knows there is no art");
  const res = await request(`/art/${encodeId(hex.id)}`);
  assert.strictEqual(res.status, 404);
});

/* ---------------------------------------------------------------- */
/*  Playback endpoints without a speaker on the network              */
/* ---------------------------------------------------------------- */

test("asking to play with no room named is refused clearly", async () => {
  const res = await new Promise((resolve, reject) => {
    const url = new URL("/api/play", base);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: "POST",
      headers: { "Content-Type": "application/json" }
    }, r => {
      const chunks = [];
      r.on("data", c => chunks.push(c));
      r.on("end", () => resolve({ status: r.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ albumId: "a:whatever" }));
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /Choose a room/);
});

test("the room list is empty and says why when no player answers", async () => {
  const { status, body } = await json("/api/zones");
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body.rooms, []);
  assert.ok(body.error, "the reason is carried to the UI rather than logged and lost");
});

/* ---------------------------------------------------------------- */
/*  The app itself                                                   */
/* ---------------------------------------------------------------- */

test("the web app is served, and a deep link falls back to it", async () => {
  const root = await request("/");
  assert.strictEqual(root.status, 200);
  assert.match(root.body.toString(), /<title>MusicD<\/title>/);

  const deep = await request("/album/anything");
  assert.strictEqual(deep.status, 200);
  assert.match(deep.body.toString(), /<div class="app">/);
});

test("an unknown API path is a JSON 404, not the web app", async () => {
  const { status, body } = await json("/api/labels");
  assert.strictEqual(status, 404, "a caller's typo must not come back as HTML with a 200");
  assert.match(body.error, /No such endpoint/);
});

test("a negative limit cannot unbound a row", async () => {
  /* SQLite reads LIMIT -1 as no limit at all, so a bare Math.min was a way to
     ask the server to serialise the whole library — six times over on /home. */
  const home = await json("/api/home?limit=-1");
  for (const row of home.body.rows) {
    assert.ok(row.albums.length <= 24, row.key + " stayed within the default page");
  }
  const albums = await json("/api/albums?row=library&limit=-1");
  assert.ok(albums.body.albums.length <= 200);

  const huge = await json("/api/albums?row=library&limit=99999");
  assert.ok(huge.body.albums.length <= 500, "and the cap still applies upwards");
});

test("the grid pages with an offset rather than stopping at a cap", async () => {
  const first = await json("/api/albums?row=library&limit=2&offset=0");
  const second = await json("/api/albums?row=library&limit=2&offset=2");
  assert.strictEqual(first.body.albums.length, 2);
  assert.strictEqual(second.body.albums.length, 2);
  const overlap = first.body.albums.filter(a => second.body.albums.some(b => b.id === a.id));
  assert.deepStrictEqual(overlap, [], "the second page continues the first");
});

test("album tracks say whether Sonos can play them", async () => {
  const { body: home } = await json("/api/home");
  const album = home.rows[0].albums.find(a => a.title === "Souvlaki");
  const { body } = await json("/api/album/" + encodeId(album.id));
  for (const track of body.tracks) {
    assert.strictEqual(typeof track.playable, "boolean",
      "the client must not have to work this out for itself");
  }
});

test("an artist whose name contains a percent sign is reachable", async () => {
  /* Express has already decoded the parameter; decoding it again threw. */
  const { status } = await json("/api/artist/" + encodeURIComponent("50% Off"));
  assert.strictEqual(status, 200);
});

test("status names the build, not just the version", async () => {
  /* "I updated and nothing changed" cannot be told apart from "the update did
     not reach me" unless a container can say exactly what it is. */
  const { body } = await json("/api/status");
  assert.strictEqual(body.version, require("../package.json").version);
  assert.ok(body.build, "a build block is reported");
  assert.strictEqual(body.build.version, body.version);
  for (const key of ["commit", "date", "ref"]) {
    assert.strictEqual(typeof body.build[key], "string",
      key + " is always present, empty on a local build");
  }
});

test("the app shell is revalidated, never served blind from cache", async () => {
  /* A flat max-age here meant that for an hour after an update the browser
     kept using the OLD index.html and app.js without asking — a container that
     had genuinely updated showed the previous interface, and the only symptom
     was "I updated and nothing changed". */
  for (const file of ["/", "/app.js", "/style.css", "/sharecard.js"]) {
    const res = await request(file);
    assert.strictEqual(res.status, 200, file);
    assert.strictEqual(res.headers["cache-control"], "no-cache", file + " must revalidate");
    assert.ok(res.headers.etag, file + " carries an ETag, so revalidating costs a 304");
  }
  /* The deep-link fallback is the same document and follows the same rule. */
  const deep = await request("/album/anything");
  assert.strictEqual(deep.headers["cache-control"], "no-cache");
});

test("an unchanged shell file revalidates to a 304, not a re-download", async () => {
  const first = await request("/app.js");
  const again = await request("/app.js", { headers: { "If-None-Match": first.headers.etag } });
  assert.strictEqual(again.status, 304, "so no-cache costs a round trip, not a payload");
  assert.strictEqual(again.body.length, 0);
});

test("icons keep a long cache — they are what does not change between versions", async () => {
  const res = await request("/icons/favicon.svg");
  assert.strictEqual(res.status, 200);
  assert.match(res.headers["cache-control"], /max-age=\d{5,}/);
});

test("the shell it serves is stamped with the version that built it", async () => {
  const version = require("../package.json").version;
  const res = await request("/");
  const html = res.body.toString();
  assert.match(html, new RegExp(`<meta name="musicd-build" content="${version.replace(/\./g, "\\.")}">`),
    "the document records which version it is");
  /* A browser holding an old app.js cannot serve it against a new address, so
     the asset URLs change with every release. */
  for (const asset of ["app.js", "sharecard.js", "style.css"]) {
    assert.ok(html.includes(`${asset}?v=${version}`), asset + " is versioned");
  }
});

test("a deep link gets the same built shell, not the file on disk", async () => {
  const deep = (await request("/album/anything")).body.toString();
  assert.match(deep, /<meta name="musicd-build"/);
  assert.match(deep, /app\.js\?v=/);
});

test("the service worker is served with the version in it and never cached", async () => {
  const res = await request("/sw.js");
  assert.strictEqual(res.status, 200);
  const body = res.body.toString();
  assert.ok(body.includes(`const VERSION = "${require("../package.json").version}"`),
    "the version is substituted — its changing is what makes a browser look for a new worker");
  assert.ok(!body.includes("__BUILD_VERSION__"), "and the placeholder is gone");
  assert.strictEqual(res.headers["cache-control"], "no-cache",
    "a cached worker script is a cached update check");
  assert.strictEqual(res.headers["service-worker-allowed"], "/");
});

test("the wordmark is served as a vector on a transparent ground", async () => {
  const res = await request("/icons/wordmark.svg");
  assert.strictEqual(res.status, 200);
  const svg = res.body.toString();
  assert.match(svg, /<svg[^>]*viewBox=/);
  assert.ok(!/<image\b/.test(svg), "traced, not a wrapped bitmap");
});

/* ------------------------------------------------------------------ */
/*  Correcting an album's name                                         */
/* ------------------------------------------------------------------ */

/* Field Recordings is the fixture album whose files name no artist at all —
   the "Unknown artist" the dialog exists to fix. */
const FIELD = encodeId("a:Unknown/2001 - Field Recordings");

test("an album screen says what the files say as well as what is shown", async () => {
  const { body } = await json("/api/album/" + FIELD);
  assert.strictEqual(body.artist, "", "no artist, which is the state being corrected");
  assert.deepStrictEqual(body.tags, { title: "Field Recordings", artist: "" },
    "the dialog needs the tags to offer them back");
  assert.strictEqual(body.edited, false);
});

test("a name correction is stored and shown everywhere", async () => {
  const saved = await json("/api/album/name", {
    method: "POST", body: { album: FIELD, title: "Sea Nettles", artist: "Chris Watson" }
  });
  assert.strictEqual(saved.status, 200);
  assert.deepStrictEqual(
    { title: saved.body.title, artist: saved.body.artist, edited: saved.body.edited },
    { title: "Sea Nettles", artist: "Chris Watson", edited: true });

  const screen = await json("/api/album/" + FIELD);
  assert.strictEqual(screen.body.title, "Sea Nettles");
  assert.strictEqual(screen.body.artist, "Chris Watson");
  assert.deepStrictEqual(screen.body.tags, { title: "Field Recordings", artist: "" },
    "and the tags are still the tags — nothing was written to the files");

  /* The rows and the searches, which are separate queries and the place a
     half-finished rename shows up. */
  const shelf = await json("/api/albums?row=library&limit=200");
  assert.ok(shelf.body.albums.some(a => a.title === "Sea Nettles" && a.artist === "Chris Watson"),
    "the library row");
  const found = await json("/api/search?q=nettles");
  assert.deepStrictEqual(found.body.albums.map(a => a.title), ["Sea Nettles"], "search by the new title");
  const byArtist = await json("/api/search?q=watson");
  assert.ok(byArtist.body.artists.some(a => a.name === "Chris Watson"), "and by the new artist");
  const artists = await json("/api/artists");
  assert.ok(artists.body.artists.some(a => a.name === "Chris Watson"), "the artist list");
  const screenFor = await json("/api/artist/" + encodeURIComponent("Chris Watson"));
  assert.deepStrictEqual(screenFor.body.albums.map(a => a.title), ["Sea Nettles"],
    "and that artist's own screen");
});

test("a rescan leaves the correction alone", async () => {
  await server.runScan("test-after-edit");
  const screen = await json("/api/album/" + FIELD);
  assert.strictEqual(screen.body.title, "Sea Nettles", "the scan rewrites the tag columns, not these");
  assert.strictEqual(screen.body.artist, "Chris Watson");
});

test("clearing a field puts the tags back", async () => {
  const back = await json("/api/album/name", {
    method: "POST", body: { album: FIELD, title: "", artist: "" }
  });
  assert.strictEqual(back.status, 200);
  assert.deepStrictEqual(
    { title: back.body.title, artist: back.body.artist, edited: back.body.edited },
    { title: "Field Recordings", artist: "", edited: false });
  const screen = await json("/api/album/" + FIELD);
  assert.strictEqual(screen.body.artist, "", "back to what the files say");
});

test("a correction needs an album that exists", async () => {
  const none = await json("/api/album/name", { method: "POST", body: { title: "x" } });
  assert.strictEqual(none.status, 400, "no album named at all");
  assert.match(none.body.error, /Which album/);

  const missing = await json("/api/album/name", {
    method: "POST", body: { album: encodeId("a:nowhere/at all"), title: "x" }
  });
  assert.strictEqual(missing.status, 404);
});

test("correcting a name is a POST, so nothing can rename an album by being linked to", () => {
  /* The same rule the update endpoints follow: anything that CHANGES the
     library is a POST, or a crawler, a prefetch or an <img src> in a message
     could do it. */
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(source, /app\.post\("\/api\/album\/name"/);
  assert.ok(!/app\.get\("\/api\/album\/name"/.test(source));
});

/* ------------------------------------------------------------------ */
/*  What a record is, and who made it                                  */
/* ------------------------------------------------------------------ */

/* This server is started with no INFO_LOOKUP override, so the lookup is
   available — but nothing in a test run reaches the internet, and the routes
   below prove exactly that: they answer, and they answer null. */

test("an album's write-up is its own request, not part of the album", async () => {
  /* Folding it into /api/album would hold the track list behind a lookup that
     may go to the internet. Two calls means the album is there instantly. */
  const album = await json("/api/album/" + FIELD);
  assert.ok(!("info" in album.body), "the album screen's own payload is unchanged");

  const info = await json("/api/album/" + FIELD + "/info");
  assert.strictEqual(info.status, 200);
  assert.ok("info" in info.body, "and the write-up has an endpoint of its own");
});

test("no confident match is a 200 with nothing in it, never an error", async () => {
  /* An error would tell the client to retry something already settled and
     written down. Null is the honest answer for "asked, and there is none". */
  const res = await json("/api/artist/" + encodeURIComponent("Nobody At All") + "/info");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.info, null);
});

test("an album that is not in the library has no write-up", async () => {
  /* Not an error: the id is well formed and the question is a fair one, and
     the answer is that there is nothing to say. */
  const missing = await json("/api/album/" + encodeId("a:nowhere/at all") + "/info");
  assert.strictEqual(missing.status, 200);
  assert.strictEqual(missing.body.info, null);
});

test("the status says whether looking things up is allowed at all", async () => {
  const status = await json("/api/status");
  assert.ok(status.body.info, "the client is told");
  assert.strictEqual(typeof status.body.info.available, "boolean");
  assert.strictEqual(typeof status.body.info.known, "number");
});

test("correcting a name throws that album's write-up away", async () => {
  /* The write-up was found by searching for the old name, so a rename makes it
     the answer to a question nobody is asking. */
  const db = server.db;
  db.prepare(`INSERT INTO info (kind, key, source, summary, fetched_at, ok)
              VALUES ('album', ?, 'wikipedia', 'Something.', ?, 1)`)
    .run(decodeId(FIELD), Date.now());
  assert.ok(db.prepare("SELECT 1 FROM info WHERE key = ?").get(decodeId(FIELD)),
    "it is there to begin with");

  await json("/api/album/name", {
    method: "POST", body: { album: FIELD, title: "Sea Nettles", artist: "Chris Watson" }
  });
  assert.strictEqual(db.prepare("SELECT 1 FROM info WHERE key = ?").get(decodeId(FIELD)),
    undefined, "and gone after the rename");

  /* Put the library back the way the tests above left it. */
  await json("/api/album/name", { method: "POST", body: { album: FIELD, title: "", artist: "" } });
});

/* ------------------------------------------------------------------ */
/*  How the Library screen is ordered                                  */
/* ------------------------------------------------------------------ */

test("the order comes with the vocabulary to draw it", async () => {
  /* The sheet is built from the SERVER's list rather than a copy kept in the
     client, so the two cannot drift as sorts are added or renamed. */
  const { status, body } = await json("/api/sort");
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body.view, { sort: "artist", dir: "asc", seed: 1 },
    "and opens on the shelf order it always did");
  assert.strictEqual(body.options.length, 7);
  for (const o of body.options) {
    assert.ok(o.id && o.label, JSON.stringify(o));
    /* Every direction has a NAME for that sort: "Newest first" and "Z → A" are
       the same arrow, and one shared label would be wrong for one of them. */
    if (o.directional) assert.ok(o.asc && o.desc, o.id + " names both directions");
  }
});

test("a chosen order is stored and applied to the row and the grid alike", async () => {
  const saved = await json("/api/sort", {
    method: "POST", body: { sort: "album", dir: "desc" }
  });
  assert.deepStrictEqual(saved.body.view, { sort: "album", dir: "desc", seed: 1 });

  const grid = await json("/api/albums?row=library&limit=200");
  const titles = grid.body.albums.map(a => a.title);
  assert.deepStrictEqual(titles, [...titles].sort().reverse(), titles.join(", "));

  /* The Home row is the same shelf, so it is in the same order — a row
     labelled "Library" that disagrees with the screen it opens into is two
     screens disagreeing about one thing. */
  const home = await json("/api/home?limit=60");
  const row = home.body.rows.find(r => r.key === "library");
  assert.deepStrictEqual(row.albums.map(a => a.title), titles.slice(0, row.albums.length));
});

test("what is stored is always something this server would accept", async () => {
  /* Normalised on the way IN as well as out, so a request from an older client
     or a hand-made one cannot leave a value that breaks the screen later. */
  const odd = await json("/api/sort", {
    method: "POST", body: { sort: "by-vibes", dir: "sideways", seed: -3 }
  });
  assert.deepStrictEqual(odd.body.view, { sort: "artist", dir: "asc", seed: 1 });
});

test("the order survives the server being restarted", async () => {
  /*
   * THE POINT OF STORING IT SERVER-SIDE. It lives in DATA_DIR, which the
   * container's own lifetime does not touch and the in-app updater is not
   * allowed to write to — so a reboot, a restart and an update all find it as
   * it was left. A browser's storage would also lose it to a cleared cache or
   * a re-added home-screen shortcut.
   */
  await json("/api/sort", { method: "POST", body: { sort: "plays" } });

  const dbLib = require("../lib/db");
  const settingsLib = require("../lib/settings");
  const library = require("../lib/library");
  /* A second connection to the same file on disk, which is what a restart is
     from the setting's point of view. */
  const fresh = dbLib.open(process.env.DATA_DIR);
  try {
    const stored = settingsLib.open(fresh).get("library.sort");
    assert.deepStrictEqual(library.normaliseSort(JSON.parse(stored)),
      { sort: "plays", dir: "desc", seed: 1 });
  } finally { fresh.close(); }

  /* Put it back so the ordering tests above do not depend on running first. */
  await json("/api/sort", { method: "POST", body: { sort: "artist" } });
});
