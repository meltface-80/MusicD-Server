"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const { buildLibrary } = require("./fixtures");
const { encodeId } = require("../lib/ids");

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
