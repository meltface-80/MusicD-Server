"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dbLib = require("../lib/db");
const scanner = require("../lib/scanner");
const sonosLib = require("../lib/sonos");
const { Playback } = require("../lib/playback");
const { decodeId } = require("../lib/ids");
const { buildLibrary } = require("./fixtures");
const { createFakeSonos } = require("./fake-sonos");

const BASE = "http://192.168.1.9:3400";

const FAKE_PORT = 11450;

/*
 * One room by default. A single fake process answers for every room it
 * publishes, so a two-room household would have both rooms reporting the same
 * transport — which on real hardware means two speakers genuinely playing the
 * same thing, and two plays. That is correct behaviour and the wrong thing to
 * assert against here, so the play-counting tests get a household of one.
 */
async function rig({ zones } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-play-"));
  const music = path.join(root, "music");
  buildLibrary(music);

  const db = dbLib.open(path.join(root, "data"));
  await scanner.scan(db, [music], { artDir: path.join(root, "data", "cache", "art") });

  const fake = createFakeSonos({
    port: FAKE_PORT, host: "127.0.0.1",
    zones: zones || [{ uuid: "RINCON_AAA01400", name: "Kitchen", coordinator: "RINCON_AAA01400" }]
  });
  await fake.listen();

  const household = new sonosLib.Household({ hosts: ["127.0.0.1"], port: FAKE_PORT });
  await household.refresh({ force: true });

  let invalidated = 0;
  /* A scrobbler that only writes down what it was asked to do. The point of
     the tests below is not that Last.fm accepted anything — lib/lastfm.js has
     its own suite for that — but that this loop hands it exactly the listens
     it credits, and nothing else. */
  const scrobbled = [], announced = [];
  const scrobbler = {
    scrobble: async (listen) => { scrobbled.push(listen); return true; },
    nowPlaying: async (listen) => { announced.push(listen); return true; }
  };
  const playback = new Playback({
    db, household, baseUrl: () => BASE, onLibraryChange: () => { invalidated++; }, scrobbler
  });

  return {
    db, fake, household, playback, music, scrobbled, announced,
    kitchen: () => household.rooms().find(r => r.name === "Kitchen").uuid,
    albumId: (title) => db.prepare("SELECT id FROM albums WHERE title = ?").get(title).id,
    invalidations: () => invalidated,
    async cleanup() {
      await fake.close();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test("the household finds its rooms over a seeded host", async () => {
  const r = await rig({ zones: [
    { uuid: "RINCON_AAA01400", name: "Kitchen", coordinator: "RINCON_AAA01400" },
    { uuid: "RINCON_BBB01400", name: "Study",   coordinator: "RINCON_BBB01400" }
  ] });
  try {
    assert.deepStrictEqual(r.household.rooms().map(z => z.name), ["Kitchen", "Study"]);
  } finally { await r.cleanup(); }
});

test("two rooms playing the same track independently are two plays", async () => {
  const r = await rig({ zones: [
    { uuid: "RINCON_AAA01400", name: "Kitchen", coordinator: "RINCON_AAA01400" },
    { uuid: "RINCON_BBB01400", name: "Study",   coordinator: "RINCON_BBB01400" }
  ] });
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Hex"));
    r.fake.playingAt(1, "0:03:00", "0:05:00");
    await r.playback.poll();
    /* The fake answers for both rooms from one socket, so both coordinators
       report the same track — which is exactly what two speakers each playing
       it would look like, and is two plays. */
    assert.strictEqual(r.db.prepare("SELECT SUM(play_count) n FROM tracks").get().n, 2);
  } finally { await r.cleanup(); }
});

test("playing an album clears the queue, loads it, and starts it", async () => {
  const r = await rig();
  try {
    const result = await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));
    assert.strictEqual(result.queued, 6);
    assert.strictEqual(result.room, "Kitchen");

    const actions = r.fake.actions();
    assert.ok(actions.includes("RemoveAllTracksFromQueue"), "the old queue went first");
    assert.strictEqual(actions.filter(a => a === "AddURIToQueue").length, 6);

    /* The transport must be pointed at the QUEUE, not at a single track — that
       is what makes Sonos move between tracks by itself. */
    assert.strictEqual(r.fake.state.currentUri, `x-rincon-queue:${r.kitchen()}#0`);
    assert.strictEqual(r.fake.state.playMode, "NORMAL");
    assert.strictEqual(r.fake.state.transportState, "PLAYING");
    assert.strictEqual(r.fake.state.track, 1, "started at the first track");
  } finally { await r.cleanup(); }
});

test("the queue is loaded in track order, and each URI is a real track", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));
    const titles = r.fake.state.queue.map(item => {
      const token = /\/stream\/([A-Za-z0-9_-]+)\./.exec(item.uri)[1];
      return r.db.prepare("SELECT title FROM tracks WHERE id = ?").get(decodeId(token)).title;
    });
    assert.deepStrictEqual(titles,
      ["The Rainbow", "Eden", "Desire", "Inheritance", "I Believe in You", "Wealth"]);
  } finally { await r.cleanup(); }
});

test("every queued item carries metadata Sonos will accept", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Souvlaki"));
    for (const item of r.fake.state.queue) {
      assert.match(item.metadata, /RINCON_AssociatedZPUDN/, "the sentinel is present");
      assert.match(item.metadata, /<upnp:album>Souvlaki<\/upnp:album>/);
      assert.match(item.metadata, /protocolInfo="http-get:\*:audio\/wav:\*"/);
      assert.match(item.metadata, new RegExp(`<upnp:albumArtURI>${BASE}/art/`),
        "art is advertised at an address the speaker can reach");
      assert.ok(item.uri.startsWith(BASE + "/stream/"),
        "and so is the audio — never a container-internal address");
    }
  } finally { await r.cleanup(); }
});

test("playing from a track in the middle starts there and keeps the rest", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"), 3);
    assert.strictEqual(r.fake.state.queue.length, 6, "the whole album is still queued");
    assert.strictEqual(r.fake.state.track, 4, "but it starts at the fourth track");
  } finally { await r.cleanup(); }
});

test("queueing appends without clearing and without starting playback", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Souvlaki"));
    const before = r.fake.state.queue.length;
    r.fake.state.calls.length = 0;

    await r.playback.queueAlbum(r.kitchen(), r.albumId("Hex"));

    assert.ok(!r.fake.actions().includes("RemoveAllTracksFromQueue"), "nothing was cleared");
    assert.ok(!r.fake.actions().includes("Play"), "and nothing was restarted");
    assert.strictEqual(r.fake.state.queue.length, before + 3);
  } finally { await r.cleanup(); }
});

test("a room that is not on the network fails with something a person can read", async () => {
  const r = await rig();
  try {
    await assert.rejects(
      () => r.playback.playAlbum("RINCON_NOT_HERE", r.albumId("Hex")),
      /not on the network/);
  } finally { await r.cleanup(); }
});

test("transport commands for a grouped room go to the coordinator", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-group-"));
  const fake = createFakeSonos({
    port: FAKE_PORT + 1, host: "127.0.0.1",
    zones: [
      { uuid: "RINCON_AAA01400", name: "Kitchen", coordinator: "RINCON_AAA01400" },
      { uuid: "RINCON_BBB01400", name: "Study",   coordinator: "RINCON_AAA01400" }
    ]
  });
  await fake.listen();
  try {
    const household = new sonosLib.Household({ hosts: ["127.0.0.1"], port: FAKE_PORT + 1 });
    await household.refresh({ force: true });
    const db = dbLib.open(path.join(root, "data"));
    const playback = new Playback({ db, household, baseUrl: () => BASE });

    assert.strictEqual(household.coordinatorFor("RINCON_BBB01400").name, "Kitchen");
    await playback.command("RINCON_BBB01400", "pause");
    assert.strictEqual(fake.state.transportState, "PAUSED_PLAYBACK");
    db.close();
  } finally {
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("volume stays with the speaker, not its group", async () => {
  const r = await rig();
  try {
    await r.playback.volume(r.kitchen(), 42);
    assert.strictEqual(r.fake.state.volume, 42);
    assert.deepStrictEqual(await r.playback.volume(r.kitchen()), { volume: 42, muted: false });

    await r.playback.mute(r.kitchen(), true);
    assert.strictEqual(r.fake.state.muted, true);
  } finally { await r.cleanup(); }
});

test("volume is clamped rather than passed through", async () => {
  const r = await rig();
  try {
    await r.playback.volume(r.kitchen(), 480);
    assert.strictEqual(r.fake.state.volume, 100);
    await r.playback.volume(r.kitchen(), -20);
    assert.strictEqual(r.fake.state.volume, 0);
  } finally { await r.cleanup(); }
});

/* ---------------------------------------------------------------- */
/*  Counting plays                                                   */
/* ---------------------------------------------------------------- */

test("a track is not counted until half of it has played", async () => {
  const r = await rig();
  try {
    const album = r.albumId("Spirit of Eden");
    await r.playback.playAlbum(r.kitchen(), album);

    r.fake.playingAt(1, "0:00:04", "0:05:00");
    await r.playback.poll();
    assert.strictEqual(r.db.prepare("SELECT SUM(play_count) n FROM tracks").get().n, 0,
      "four seconds in is not a play");

    r.fake.playingAt(1, "0:02:40", "0:05:00");
    await r.playback.poll();
    assert.strictEqual(r.db.prepare("SELECT SUM(play_count) n FROM tracks").get().n, 1);
  } finally { await r.cleanup(); }
});

test("a skipped track is never counted", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));
    for (const track of [1, 2, 3]) {
      r.fake.playingAt(track, "0:00:12", "0:05:00");
      await r.playback.poll();
    }
    assert.strictEqual(r.db.prepare("SELECT SUM(play_count) n FROM tracks").get().n, 0);
    assert.strictEqual(r.db.prepare("SELECT COUNT(*) n FROM plays").get().n, 0);
  } finally { await r.cleanup(); }
});

/*
 * A scrobble and a play count are the same event.
 *
 * This loop's half-way rule IS Last.fm's rule, so hooking the scrobbler
 * anywhere else — the Play button, the queue builder — would let the two
 * disagree about what was listened to. These tests exist to keep them the
 * same event rather than two events that currently agree.
 */
test("a scrobble happens exactly when the play is credited", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));

    r.fake.playingAt(1, "0:00:04", "0:05:00");
    await r.playback.poll();
    assert.strictEqual(r.scrobbled.length, 0, "four seconds in is not a listen");
    assert.strictEqual(r.announced.length, 1, "but it IS what is playing now");

    r.fake.playingAt(1, "0:02:40", "0:05:00");
    await r.playback.poll();
    assert.strictEqual(r.scrobbled.length, 1);
    assert.strictEqual(r.scrobbled[0].track, "The Rainbow");
    assert.strictEqual(r.scrobbled[0].artist, "Talk Talk");
    assert.strictEqual(r.scrobbled[0].album, "Spirit of Eden");
    /* The moment it STARTED — 160 seconds before this poll — not the moment it
       passed the half-way mark. A history is a list of start times. */
    const startedAgo = Date.now() - r.scrobbled[0].at;
    assert.ok(startedAgo > 150000 && startedAgo < 175000,
      `started roughly 160s ago, got ${Math.round(startedAgo / 1000)}s`);
  } finally { await r.cleanup(); }
});

test("a skipped track is never scrobbled", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));
    for (const track of [1, 2, 3]) {
      r.fake.playingAt(track, "0:00:12", "0:05:00");
      await r.playback.poll();
    }
    assert.strictEqual(r.scrobbled.length, 0,
      "counting on the way out would credit an album that was queued and skipped");
    assert.strictEqual(r.announced.length, 3, "each one was on, briefly");
  } finally { await r.cleanup(); }
});

test("a track playing on is scrobbled once, not once per poll", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));
    r.fake.playingAt(1, "0:03:00", "0:05:00");
    for (let i = 0; i < 5; i++) await r.playback.poll();
    assert.strictEqual(r.scrobbled.length, 1);
    assert.strictEqual(r.announced.length, 1, "and announced once, when it started");
  } finally { await r.cleanup(); }
});

test("a compilation scrobbles the track's artist, not Various Artists", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Late Night Tales"));
    r.fake.playingAt(1, "0:03:00", "0:05:00");
    await r.playback.poll();
    assert.strictEqual(r.scrobbled.length, 1);
    assert.strictEqual(r.scrobbled[0].artist, "Nina Simone",
      "nobody listened to a band called Various Artists");
    assert.strictEqual(r.scrobbled[0].albumArtist, "Various Artists");
  } finally { await r.cleanup(); }
});

test("a long track counts after four minutes, not at its own half way", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));
    r.fake.playingAt(1, "0:04:05", "0:20:00");
    await r.playback.poll();
    assert.strictEqual(r.db.prepare("SELECT SUM(play_count) n FROM tracks").get().n, 1);
  } finally { await r.cleanup(); }
});

test("the same track playing on is counted once, not once per poll", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));
    r.fake.playingAt(1, "0:03:00", "0:05:00");
    for (let i = 0; i < 5; i++) await r.playback.poll();
    assert.strictEqual(r.db.prepare("SELECT SUM(play_count) n FROM tracks").get().n, 1);
  } finally { await r.cleanup(); }
});

test("an album played through counts as one album play, not one per track", async () => {
  const r = await rig();
  try {
    const album = r.albumId("Spirit of Eden");
    await r.playback.playAlbum(r.kitchen(), album);
    for (let track = 1; track <= 6; track++) {
      r.fake.playingAt(track, "0:03:00", "0:05:00");
      await r.playback.poll();
    }
    assert.strictEqual(r.db.prepare("SELECT play_count FROM albums WHERE id = ?").get(album).play_count, 1);
    assert.strictEqual(r.db.prepare("SELECT SUM(play_count) n FROM tracks WHERE album_id = ?").get(album).n, 6);
  } finally { await r.cleanup(); }
});

test("moving on to a different album counts that album too", async () => {
  const r = await rig();
  try {
    const spirit = r.albumId("Spirit of Eden");
    const hex = r.albumId("Hex");
    await r.playback.playAlbum(r.kitchen(), spirit);
    r.fake.playingAt(1, "0:03:00", "0:05:00");
    await r.playback.poll();

    await r.playback.playAlbum(r.kitchen(), hex);
    r.fake.playingAt(1, "0:03:00", "0:05:00");
    await r.playback.poll();

    assert.strictEqual(r.db.prepare("SELECT play_count FROM albums WHERE id = ?").get(spirit).play_count, 1);
    assert.strictEqual(r.db.prepare("SELECT play_count FROM albums WHERE id = ?").get(hex).play_count, 1);
  } finally { await r.cleanup(); }
});

test("a paused player is not counted, however long it sits there", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Hex"));
    r.fake.playingAt(1, "0:04:30", "0:05:00");
    r.fake.state.transportState = "PAUSED_PLAYBACK";
    for (let i = 0; i < 3; i++) await r.playback.poll();
    assert.strictEqual(r.db.prepare("SELECT COUNT(*) n FROM plays").get().n, 0);
  } finally { await r.cleanup(); }
});

test("music from another app is ignored by the play counter", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Hex"));
    r.fake.state.queue = [{ uri: "x-sonos-spotify:track123", metadata: "" }];
    r.fake.playingAt(1, "0:03:00", "0:05:00");
    await r.playback.poll();
    assert.strictEqual(r.db.prepare("SELECT COUNT(*) n FROM plays").get().n, 0);
  } finally { await r.cleanup(); }
});

test("counting a play tells the rest of the app the library moved", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Hex"));
    r.fake.playingAt(1, "0:03:00", "0:05:00");
    await r.playback.poll();
    assert.ok(r.invalidations() > 0, "Smart Picks and Recently played were invalidated");
  } finally { await r.cleanup(); }
});

/* ---------------------------------------------------------------- */
/*  Now playing and the queue                                        */
/* ---------------------------------------------------------------- */

test("now playing names the track, the album and the room", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Souvlaki"));
    r.fake.playingAt(2, "0:01:00", "0:04:00");

    const now = await r.playback.nowPlaying(r.kitchen());
    assert.strictEqual(now.zone.name, "Kitchen");
    assert.strictEqual(now.state, "PLAYING");
    assert.strictEqual(now.track.title, "Machine Gun");
    assert.strictEqual(now.album.title, "Souvlaki");
    assert.strictEqual(now.position, 60);
    assert.strictEqual(now.duration, 240);
    assert.strictEqual(now.grouped, false);
    assert.strictEqual(now.foreign, false);
  } finally { await r.cleanup(); }
});

test("now playing says so when the speaker is on something else", async () => {
  const r = await rig();
  try {
    r.fake.state.queue = [{ uri: "x-rincon-mp3radio://example.com/stream", metadata: "" }];
    r.fake.playingAt(1, "0:00:30", "0:00:00");
    const now = await r.playback.nowPlaying(r.kitchen());
    assert.strictEqual(now.track, null);
    assert.strictEqual(now.foreign, true, "so the screen can say where it came from");
  } finally { await r.cleanup(); }
});

test("the queue is read back off the player, with our own titles", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Hex"));
    r.fake.playingAt(2, "0:00:10", "0:03:00");

    const q = await r.playback.queue(r.kitchen());
    assert.strictEqual(q.total, 3);
    assert.strictEqual(q.index, 2, "the player says which one is current");
    assert.deepStrictEqual(q.items.map(i => i.title),
      ["The Loom", "A Street Scene", "Absent Friend"]);
    assert.strictEqual(q.items[0].album, "Hex",
      "resolved from our own library, not from what the player echoed back");
  } finally { await r.cleanup(); }
});

test("shuffle and repeat preserve each other on the player", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Hex"));
    assert.strictEqual(r.fake.state.playMode, "NORMAL");

    await r.playback.command(r.kitchen(), "shuffle");
    assert.strictEqual(r.fake.state.playMode, "SHUFFLE_NOREPEAT", "shuffle on, repeat untouched");

    /* Repeat cycles off → all → one, and must not clear shuffle on the way. */
    await r.playback.command(r.kitchen(), "repeat");
    assert.strictEqual(r.fake.state.playMode, "SHUFFLE");
    await r.playback.command(r.kitchen(), "repeat");
    assert.strictEqual(r.fake.state.playMode, "SHUFFLE_REPEAT_ONE");
    await r.playback.command(r.kitchen(), "repeat");
    assert.strictEqual(r.fake.state.playMode, "SHUFFLE_NOREPEAT", "and cycles back to off");

    await r.playback.command(r.kitchen(), "shuffle");
    assert.strictEqual(r.fake.state.playMode, "NORMAL", "shuffle off, repeat still off");
  } finally { await r.cleanup(); }
});

test("now playing splits the play mode into the two switches the buttons drive", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Hex"));
    r.fake.state.playMode = "SHUFFLE_REPEAT_ONE";
    r.fake.playingAt(1, "0:00:10", "0:03:00");

    const now = await r.playback.nowPlaying(r.kitchen());
    assert.strictEqual(now.shuffle, true);
    assert.strictEqual(now.repeat, "one");
    assert.strictEqual(now.playMode, "SHUFFLE_REPEAT_ONE", "the raw mode is still reported");
  } finally { await r.cleanup(); }
});
