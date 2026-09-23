"use strict";
/*
 * End to end: a real server, a real scan of real files, and a fake Sonos
 * household on loopback. Covers the path a tap takes — album → Sonos queue →
 * the speaker fetching /stream — including the 24/48 conversion.
 */
const test = require("node:test");
const assert = require("node:assert");
const { haveFfmpeg, makeLibrary, probe } = require("./fixtures");
const { FakeHousehold } = require("./fake-sonos");

const skip = !haveFfmpeg() && "ffmpeg is not installed";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await sleep(100);
  }
}

test("MusicD Server end to end", { skip }, async (t) => {
  const lib = makeLibrary();
  const house = new FakeHousehold();
  await house.start();
  const { createServer } = require("../index.js");
  const srv = createServer({
    port: 3591, musicDir: lib.music, dataDir: lib.data, serverIp: "127.0.0.1",
    sonosHosts: ["127.0.0.11"]
  });
  const ctx = await srv.start();
  const api = async (p, body) => {
    const r = await fetch("http://127.0.0.1:3591/api/" + p, body ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    } : undefined);
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ...j };
  };

  try {
    await until(async () => (await api("status")).index_count === 3);
    const zones = await until(async () => { const z = await api("zones"); return z.zones.length === 2 && z.zones; });
    const kitchen = zones.find(z => z.display_name === "Kitchen");
    const study = zones.find(z => z.display_name === "Study");
    assert.ok(kitchen && study);
    assert.equal(kitchen.outputs[0].volume.type, "number");

    const albums = (await api("library/albums?sort=album")).albums;
    const hires = albums.find(a => a.title === "Hi Res");
    const cd = albums.find(a => a.title === "Album One");
    assert.equal(hires.quality, "24/96");

    await t.test("a CD-quality album plays bit-perfect", async () => {
      const r = await api("play", { offset: cd.offset, zone_or_output_id: kitchen.zone_id, kind: "play_now" });
      assert.equal(r.ok, true);
      const room = house.room("Kitchen");
      await until(() => room.queue.length === 3);
      assert.equal(room.state, "PLAYING");
      const f = await until(() => room.fetches.find(x => x.done));
      assert.equal(f.status, 200);
      assert.equal(f.type, "audio/flac");
      const info = probe(f.body);
      assert.deepEqual(info, { rate: 44100, channels: 2, bits: 16 });
    });

    await t.test("zone-state shows what is playing, from the library", async () => {
      const s = await until(async () => { const z = await api("zone-state?zone=" + kitchen.zone_id); return z.zone && z.zone.now_playing && z.zone.state === "playing" && z; });
      assert.equal(s.zone.now_playing.line1, "Song 1");
      assert.equal(s.zone.now_playing.line3, "Album One");
      assert.match(s.zone.now_playing.image_key, /^al-/);
    });

    await t.test("a 24/96 album reaches the speaker as 24/48 FLAC", async () => {
      await api("play", { offset: hires.offset, zone_or_output_id: study.zone_id, kind: "play_now" });
      const room = house.room("Study");
      const f = await until(() => room.fetches.find(x => x.done && x.body && x.body.length > 1000));
      assert.equal(f.status, 200);
      assert.equal(f.type, "audio/flac");
      assert.deepEqual(probe(f.body), { rate: 48000, channels: 2, bits: 24 });
      // Played again, it comes from the finished cache file with a length.
      await sleep(1500);
      const again = await fetch(room.queue[0].uri);
      assert.equal(again.status, 200);
      assert.ok(Number(again.headers.get("content-length")) > 1000);
      assert.deepEqual(probe(Buffer.from(await again.arrayBuffer())), { rate: 48000, channels: 2, bits: 24 });
    });

    await t.test("a track range request is honoured for bit-perfect files", async () => {
      const room = house.room("Kitchen");
      const r = await fetch(room.queue[1].uri, { headers: { Range: "bytes=0-99" } });
      assert.equal(r.status, 206);
      assert.equal((await r.arrayBuffer()).byteLength, 100);
    });

    await t.test("queue, next, play-from-here", async () => {
      const q = await api("queue?zone=" + kitchen.zone_id);
      assert.equal(q.items.length, 3);
      assert.equal(q.items[0].title, "Song 1");
      await api("control", { zone_or_output_id: kitchen.zone_id, command: "next" });
      await until(() => house.room("Kitchen").track === 2);
      const q2 = await until(async () => { const x = await api("queue?zone=" + kitchen.zone_id); return x.history.length === 1 && x; });
      assert.equal(q2.items[0].title, "Song 2");
      assert.equal(q2.history[0].track, "Song 1");
      await api("play-from-here", { zone_or_output_id: kitchen.zone_id, queue_item_id: 3 });
      await until(() => house.room("Kitchen").track === 3);
    });

    await t.test("queue and play next add in the right places", async () => {
      await api("play", { offset: cd.offset, zone_or_output_id: kitchen.zone_id, kind: "play_now" });
      await until(() => house.room("Kitchen").queue.length === 3);
      await api("play-track", { offset: hires.offset, track: 1, zone_or_output_id: kitchen.zone_id, kind: "play_next" });
      await api("play", { offset: hires.offset, zone_or_output_id: kitchen.zone_id, kind: "queue" });
      const room = house.room("Kitchen");
      await until(() => room.queue.length === 6);
      const titles = room.queue.map(q => /<dc:title>([^<]*)/.exec(q.meta)[1]);
      assert.deepEqual(titles, ["Song 1", "Hi 2", "Song 2", "Song 3", "Hi 1", "Hi 2"]);
    });

    await t.test("volume, mute and play modes", async () => {
      const out = kitchen.outputs[0].output_id;
      await api("volume", { output_id: out, how: "absolute", value: 33 });
      assert.equal(house.room("Kitchen").volume, 33);
      await api("volume", { output_id: out, how: "relative", value: -3 });
      assert.equal(house.room("Kitchen").volume, 30);
      await api("volume", { zone_or_output_id: kitchen.zone_id, mute: true });
      assert.equal(house.room("Kitchen").muted, true);
      await api("zone-settings", { zone_or_output_id: kitchen.zone_id, shuffle: true, loop: "loop" });
      assert.equal(house.room("Kitchen").playMode, "SHUFFLE");
    });

    await t.test("grouping joins a room to the coordinator, ungrouping frees it", async () => {
      await api("group-outputs", { output_ids: [kitchen.outputs[0].output_id, study.outputs[0].output_id] });
      assert.equal(house.room("Study").coordinator, house.room("Kitchen").uid);
      const z = await until(async () => { const x = await api("zones"); return x.zones.length === 1 && x.zones; });
      assert.equal(z[0].outputs.length, 2);
      assert.equal(z[0].display_name, "Kitchen + Study");
      await api("ungroup-outputs", { output_ids: [study.outputs[0].output_id] });
      await until(async () => (await api("zones")).zones.length === 2);
    });

    await t.test("search, album and extras answer in the interface's shapes", async () => {
      const s = await api("search?q=hi%20res");
      assert.equal(s.results[0].title, "Hi Res");
      const a = await api("album?offset=" + cd.offset);
      assert.equal(a.tracks.length, 3);
      assert.ok(a.actions.some(x => x.kind === "play_now"));
      const img = await fetch("http://127.0.0.1:3591/api/image/" + cd.image_key + "?size=200");
      assert.equal(img.status, 200);
      assert.equal(img.headers.get("content-type"), "image/jpeg");
    });
  } finally {
    await srv.stop();
    await house.stop();
  }
});
