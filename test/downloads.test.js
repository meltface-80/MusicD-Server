"use strict";
/*
 * Downloads for the Android app: an album's list, each track as it is on disk
 * or as Opus 256, current titles for albums already on the phone, and plays
 * made offline joining the history.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { haveFfmpeg, makeLibrary, probe } = require("./fixtures");
const { signIn } = require("./auth-helper");
const { phonePlays } = require("../lib/server/downloads");

const skip = !haveFfmpeg() && "ffmpeg is not installed";
const PORT = 3604;
const B = "http://127.0.0.1:" + PORT;

test("what a phone can play as it is", () => {
  assert.equal(phonePlays({ path: "/m/a.flac", codec: "FLAC", channels: 2 }), true);
  assert.equal(phonePlays({ path: "/m/a.mp3", codec: "MPEG 1 Layer 3" }), true);
  assert.equal(phonePlays({ path: "/m/a.m4a", codec: "AAC" }), true);
  assert.equal(phonePlays({ path: "/m/a.m4a", codec: "ALAC" }), false);
  assert.equal(phonePlays({ path: "/m/a.dsf", codec: "DSD" }), false);
  assert.equal(phonePlays({ path: "/m/a.ape", codec: "Monkey's Audio" }), false);
  assert.equal(phonePlays({ path: "/m/a.flac", codec: "FLAC", channels: 6 }), false);
});

test("albums download to the phone", { skip, timeout: 60000 }, async (t) => {
  const lib = makeLibrary();
  const { createServer } = require("../index.js");
  const srv = createServer({ port: PORT, musicDir: lib.music, dataDir: lib.data, serverIp: "127.0.0.1", sonosHosts: [] });
  const ctx = await srv.start();
  const token = await signIn(B);
  const auth = { Authorization: "Bearer " + token };
  const get = (p) => fetch(B + p, { headers: auth });
  const post = async (p, body) => (await fetch(B + p, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, auth), body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 80 && ctx.library.count < 3; i++) await new Promise(r => setTimeout(r, 100));
    const albums = (await (await get("/api/library/albums?sort=album")).json()).albums;
    const cd = albums.find(a => a.title === "Album One");
    const hires = albums.find(a => a.title === "Hi Res");

    await t.test("an album lists its tracks, sizes and where to fetch them", async () => {
      const a = await (await get(`/api/download/album?offset=${cd.offset}&quality=original`)).json();
      assert.equal(a.title, "Album One");
      assert.equal(a.tracks.length, 3);
      assert.equal(a.tracks[0].ext, "flac");
      assert.ok(a.tracks[0].size > 1000);
      assert.match(a.tracks[0].path, /^\/api\/download\/t\d+\?quality=original$/);
      assert.match(a.art_url, /\/api\/image\/.*[?&]s=/);
      const o = await (await get(`/api/download/album?offset=${cd.offset}&quality=opus`)).json();
      assert.equal(o.tracks[0].ext, "opus");
    });

    await t.test("Original is the file itself — hi-res stays hi-res", async () => {
      const a = await (await get(`/api/download/album?offset=${hires.offset}&quality=original`)).json();
      const r = await get(a.tracks[0].path);
      assert.equal(r.status, 200);
      const body = Buffer.from(await r.arrayBuffer());
      const onDisk = fs.readFileSync(ctx.library.track(a.tracks[0].id).path);
      assert.ok(body.equals(onDisk), "byte for byte");
      assert.deepEqual(probe(body), { rate: 96000, channels: 2, bits: 24 });
      const part = await fetch(B + a.tracks[0].path, { headers: Object.assign({ Range: "bytes=0-99" }, auth) });
      assert.equal(part.status, 206, "a download can resume");
    });

    await t.test("Opus 256 is made once and kept", async () => {
      const a = await (await get(`/api/download/album?offset=${cd.offset}&quality=opus`)).json();
      const t0 = Date.now();
      const r = await get(a.tracks[0].path);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "audio/ogg");
      const body = Buffer.from(await r.arrayBuffer());
      assert.equal(body.toString("ascii", 0, 4), "OggS");
      assert.ok(body.includes(Buffer.from("OpusHead")));
      const first = Date.now() - t0;
      const t1 = Date.now();
      const again = Buffer.from(await (await get(a.tracks[0].path)).arrayBuffer());
      assert.ok(again.equals(body), "the same file the second time");
      assert.ok(Date.now() - t1 <= first + 50, "from the cache");
    });

    await t.test("the phone refreshes its albums' titles and covers", async () => {
      await post("/api/album/edit", { offset: cd.offset, title: "Album One (fixed)" });
      const r = await post("/api/download/albums", { ids: [cd.offset, 999999] });
      assert.equal(r.albums[0].title, "Album One (fixed)");
      assert.equal(r.albums[1].exists, false);
      // The album as the Home row draws it.
      assert.equal(r.albums[0].album.offset, cd.offset);
      assert.equal(r.albums[0].album.title, "Album One (fixed)");
    });

    await t.test("automatic downloads: the albums the phone keeps by itself", async () => {
      const none = await (await get("/api/download/auto")).json();
      assert.deepEqual(none.albums, []);
      const recent = await (await get("/api/download/auto?recent=2&aotd=1")).json();
      assert.ok(recent.albums.length >= 2 && recent.albums.length <= 3, JSON.stringify(recent));
      assert.equal(recent.albums.filter(a => a.sources.includes("recent")).length, 2);
      assert.equal(recent.albums.filter(a => a.sources.includes("aotd")).length, 1);
      for (const a of recent.albums) assert.ok(Number.isInteger(a.id) && a.title);
    });

    await t.test("plays made offline join the history", async () => {
      const a = await (await get(`/api/download/album?offset=${cd.offset}`)).json();
      const r = await post("/api/phone/plays", { plays: [{ track_id: a.tracks[0].id, ts: Date.now() - 3600000 }, { track_id: 999999, ts: 1 }] });
      assert.equal(r.recorded, 1);
      const row = ctx.db.raw.prepare("SELECT * FROM plays ORDER BY id DESC LIMIT 1").get();
      assert.equal(row.title, "Song 1");
      assert.match(row.zone, /^PHONE_/);
    });
  } finally {
    await srv.stop();
  }
});
