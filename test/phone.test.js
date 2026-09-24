"use strict";
/*
 * The Android app as a player: it says hello, shows up as a zone ("This
 * phone") to itself only, and everything its interface does to a room —
 * play an album, pause, skip, queue, volume, move what's playing — reaches it
 * as commands. What it reports back drives now playing and the play history.
 * No other device (the iPhone home-screen app, a browser) sees it or reaches it.
 */
const test = require("node:test");
const assert = require("node:assert");
const { haveFfmpeg, makeLibrary } = require("./fixtures");
const { FakeHousehold } = require("./fake-sonos");
const { signIn } = require("./auth-helper");

const skip = !haveFfmpeg() && "ffmpeg is not installed";
const PORT = 3603;
const B = "http://127.0.0.1:" + PORT;

async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise(r => setTimeout(r, 100));
  }
}

test("the phone is a zone", { skip, timeout: 60000 }, async (t) => {
  const lib = makeLibrary();
  const house = new FakeHousehold();
  await house.start();
  const { createServer } = require("../index.js");
  const srv = createServer({ port: PORT, musicDir: lib.music, dataDir: lib.data, serverIp: "127.0.0.1", sonosHosts: ["127.0.0.11"] });
  const ctx = await srv.start();
  const phoneToken = await signIn(B);                 // kind "android"
  const otherToken = await (async () => {           // a browser on another device
    const SRP = require("../public/srp");
    const { post } = require("./auth-helper");
    const ch = await post(B, "/api/auth/challenge", { username: "tester" });
    const s = SRP.clientStart();
    const p = SRP.clientProof("tester", "correct horse battery staple", ch.salt, ch.iterations, s, ch.B);
    return (await post(B, "/api/auth/verify", { id: ch.id, A: s.A, M1: p.M1, want_token: true, kind: "browser", device_name: "iPad" })).token;
  })();
  const call = async (token, method, p, body) => {
    const r = await fetch(B + p, { method, headers: Object.assign({ Authorization: "Bearer " + token }, body ? { "Content-Type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined });
    return Object.assign({ status: r.status }, await r.json().catch(() => ({})));
  };
  const phone = (m, p, b) => call(phoneToken, m, p, b);
  const other = (m, p, b) => call(otherToken, m, p, b);

  try {
    await until(async () => (await other("GET", "/api/status")).index_count === 3);
    await until(async () => (await other("GET", "/api/zones")).zones.filter(z => !z.is_phone).length === 2);

    let zoneId, seq = 0;
    await t.test("only the Android app can be a phone, and it says hello", async () => {
      assert.equal((await other("POST", "/api/phone/hello", { name: "iPad" })).status, 403);
      const h = await phone("POST", "/api/phone/hello", { name: "Pixel 8" });
      zoneId = h.zone_id;
      assert.match(zoneId, /^PHONE_/);
      seq = h.seq;
    });

    await t.test("it is 'This phone' to itself, and invisible and unreachable to every other device", async () => {
      const mine = (await phone("GET", "/api/zones")).zones.find(z => z.zone_id === zoneId);
      assert.equal(mine.display_name, "This phone");
      assert.equal(mine.is_phone, true);
      assert.ok(!(await other("GET", "/api/zones")).zones.some(z => z.zone_id === zoneId), "hidden from other devices");
      assert.ok(!(await other("GET", "/api/shortcut/zones")).zones.some(z => z.zone_id === zoneId));
      assert.ok(!(await phone("GET", "/api/outputs")).outputs.some(o => o.output_id === zoneId), "not offered for Sonos grouping");
      assert.equal((await other("GET", "/api/zone-state?zone=" + zoneId)).status, 403);
      const cd0 = (await other("GET", "/api/library/albums?sort=album")).albums[0];
      assert.equal((await other("POST", "/api/play", { offset: cd0.offset, zone_or_output_id: zoneId, kind: "play_now" })).status, 403);
      assert.equal((await other("POST", "/api/control", { zone_or_output_id: zoneId, command: "pause" })).status, 403);
    });

    const albums = (await other("GET", "/api/library/albums?sort=album")).albums;
    const cd = albums.find(a => a.title === "Album One");

    await t.test("Play Now on the phone reaches its player as a load", async () => {
      const waiting = phone("GET", `/api/phone/commands?after=${seq}&wait=5000`);
      const r = await phone("POST", "/api/play", { offset: cd.offset, zone_or_output_id: zoneId, kind: "play_now" });
      assert.equal(r.status, 200);
      const got = await waiting;
      const load = got.commands.find(c => c.op === "load");
      assert.ok(load, JSON.stringify(got));
      assert.equal(load.items.length, 3);
      assert.equal(load.items[0].title, "Song 1");
      assert.match(load.items[0].url, /\/stream\/t\d+\.flac\?s=/);
      assert.match(load.items[0].art_url, /\/api\/image\/.*s=/);
      seq = got.seq;
      // The phone can fetch it (signed, and with its token anyway).
      const audio = await fetch(load.items[0].url, { headers: { Authorization: "Bearer " + phoneToken } });
      assert.equal(audio.status, 200);
      assert.equal(audio.headers.get("content-type"), "audio/flac");
    });

    await t.test("what the phone reports is now playing, and becomes history", async () => {
      await phone("POST", "/api/phone/state", { index: 1, position: 31, duration: 60, state: "playing", volume: 40 });
      const st = await phone("GET", "/api/zone-state?zone=" + zoneId);
      assert.equal(st.zone.state, "playing");
      assert.equal(st.zone.now_playing.line1, "Song 2");
      assert.equal(st.zone.now_playing.line3, "Album One");
      assert.equal(st.zone.outputs[0].volume.value, 40);
      const played = ctx.db.raw.prepare("SELECT * FROM plays WHERE zone = ? OR title = 'Song 2'").all("Pixel 8");
      assert.ok(played.length >= 1, "the play was recorded");
      const q = await phone("GET", "/api/queue?zone=" + zoneId);
      assert.deepEqual(q.items.map(i => i.title), ["Song 2", "Song 3"]);
      assert.deepEqual(q.history.map(i => i.track), ["Song 1"]);
    });

    await t.test("transport, queue and volume become commands", async () => {
      await phone("POST", "/api/control", { zone_or_output_id: zoneId, command: "pause" });
      await phone("POST", "/api/seek", { zone_or_output_id: zoneId, how: "absolute", seconds: 1 });
      await phone("POST", "/api/volume", { output_id: zoneId, how: "absolute", value: 25 });
      await phone("POST", "/api/play", { offset: cd.offset, zone_or_output_id: zoneId, kind: "queue" });
      const got = await phone("GET", `/api/phone/commands?after=${seq}`);
      const ops = got.commands.map(c => c.op);
      assert.deepEqual(ops, ["pause", "seek", "volume", "insert"]);
      assert.equal(got.commands[3].at, 3);
      assert.equal(got.commands[3].items.length, 3);
      seq = got.seq;
      assert.equal((await phone("GET", "/api/zone-state?zone=" + zoneId)).zone.state, "paused");
    });

    await t.test("what's playing moves from the phone to a Sonos room and back", async () => {
      const kitchen = (await phone("GET", "/api/zones")).zones.find(z => z.display_name === "Kitchen");
      await phone("POST", "/api/phone/state", { index: 1, position: 1, duration: 3, state: "playing" });
      const r = await phone("POST", "/api/transfer-zone", { from: zoneId, to: kitchen.zone_id });
      assert.equal(r.status, 200, JSON.stringify(r));
      const room = house.room("Kitchen");
      await until(async () => room.queue.length === 6);
      const got = await phone("GET", `/api/phone/commands?after=${seq}`);
      assert.ok(got.commands.some(c => c.op === "stop"));
      seq = got.seq;
      const back = await phone("POST", "/api/transfer-zone", { from: kitchen.zone_id, to: zoneId });
      assert.equal(back.status, 200, JSON.stringify(back));
      const load = (await phone("GET", `/api/phone/commands?after=${seq}`)).commands.find(c => c.op === "load");
      assert.equal(load.items.length, 6);
    });

    await t.test("a phone can't be grouped with Sonos rooms", async () => {
      const kitchen = (await phone("GET", "/api/zones")).zones.find(z => z.display_name === "Kitchen");
      const r = await phone("POST", "/api/group-outputs", { output_ids: [kitchen.zone_id, zoneId] });
      assert.equal(r.status, 500);
      assert.match(r.error, /can't be grouped/);
      assert.equal((await other("POST", "/api/transfer-zone", { from: kitchen.zone_id, to: zoneId })).status, 403, "another device can't move music to the phone");
    });
  } finally {
    await srv.stop();
    await house.stop();
  }
});
