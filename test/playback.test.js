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
async function rig(opts = {}) {
  const { zones } = opts;
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
  const radio = opts.radio || null;
  const playback = new Playback({
    db, household, baseUrl: () => BASE, onLibraryChange: () => { invalidated++; },
    scrobbler, radio
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
    /*
     * ONE call, not six. It used to be an AddURIToQueue per track, awaited in
     * turn, so ten albums was a hundred and twelve round trips one after
     * another — a queue that filled itself a few tracks at a time over several
     * seconds. A six-track album is one batch.
     */
    assert.strictEqual(actions.filter(a => a === "AddMultipleURIsToQueue").length, 1);
    assert.strictEqual(actions.filter(a => a === "AddURIToQueue").length, 0);
    assert.strictEqual(r.fake.state.queue.length, 6, "and all six arrived");

    /* The transport must be pointed at the QUEUE, not at a single track — that
       is what makes Sonos move between tracks by itself. */
    assert.strictEqual(r.fake.state.currentUri, `x-rincon-queue:${r.kitchen()}#0`);
    assert.strictEqual(r.fake.state.playMode, "NORMAL");
    assert.strictEqual(r.fake.state.transportState, "PLAYING");
    assert.strictEqual(r.fake.state.track, 1, "started at the first track");
  } finally { await r.cleanup(); }
});

test("a big selection goes in batches, not one call per track", async () => {
  /*
   * The report this exists for: ten albums added, and only some of the tracks
   * appeared, the rest arriving slowly over the next several seconds. That was
   * a hundred and twelve SOAP round trips, awaited one after another.
   */
  const r = await rig();
  try {
    /* Every album there is, so the selection is bigger than one batch. */
    const albums = r.db.prepare(
      "SELECT id FROM albums WHERE present = 1 AND version_of = ''").all().map(a => a.id);
    const result = await r.playback.playAlbums(r.kitchen(), albums);
    const actions = r.fake.actions();
    const batches = actions.filter(a => a === "AddMultipleURIsToQueue").length;

    assert.strictEqual(r.fake.state.queue.length, result.queued, "every track arrived");
    assert.ok(result.queued > 16, "and there were enough to need more than one batch: " + result.queued);
    assert.strictEqual(batches, Math.ceil(result.queued / 16), actions.join(", "));
    assert.ok(batches < result.queued / 4,
      `${batches} calls for ${result.queued} tracks, not one each`);
  } finally { await r.cleanup(); }
});

test("a long queue is read in pages, not in one enormous Browse", async () => {
  /*
   * THE REPORT THIS EXISTS FOR: "Browse to 192.168.0.93 failed: This operation
   * was aborted", on a queue of two hundred, right after jumping to a
   * different track. A Browse is not a control call — the player has to build
   * a DIDL document with an item per track, and it does that while it is also
   * starting the track and answering the poll. The big request is the one that
   * fails.
   */
  const r = await rig();
  try {
    /* More than one page of 50. */
    const albums = r.db.prepare(
      "SELECT id FROM albums WHERE present = 1 AND version_of = ''").all().map(a => a.id);
    for (let i = 0; i < 4; i++) await r.playback.playAlbums(r.kitchen(), albums, { replace: i === 0 });
    const size = r.fake.state.queue.length;
    assert.ok(size > 50, "the queue is longer than one page: " + size);

    const asked = [];
    r.fake.state.calls.length = 0;
    const out = await r.playback.queue(r.kitchen(), 500);
    for (const c of r.fake.state.calls) {
      if (c.action !== "Browse") continue;
      asked.push(Number(/<RequestedCount>(\d+)<\/RequestedCount>/.exec(c.body)[1]));
    }

    assert.strictEqual(out.items.length, size, "the whole queue still comes back");
    assert.strictEqual(out.total, size);
    assert.ok(asked.length > 1, "in more than one request: " + asked.join(", "));
    assert.ok(asked.every(n => n <= 50), "none of them large: " + asked.join(", "));

    /* And in ORDER, with nothing lost or repeated across a page boundary,
       which is exactly where a concatenation goes wrong. */
    assert.deepStrictEqual(out.items.map(i => i.index),
      Array.from({ length: size }, (_, i) => i + 1));
    assert.ok(out.items.every(i => i.trackId), "every one still resolved to a track");
  } finally { await r.cleanup(); }
});

test("a Browse that times out once is asked again", async () => {
  /* Reading a queue is idempotent and the thing that failed was a player being
     busy for a moment, so one retry costs nothing and saves the screen. A
     REFUSAL is not retried: that is an answer, and asking again just gets it
     twice. */
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));

    /* The player goes silent once — a dropped connection, which is what a busy
       one looks like from here. */
    r.fake.state.dropOnce.add("Browse");
    r.fake.state.calls.length = 0;
    const out = await r.playback.queue(r.kitchen());
    assert.strictEqual(out.items.length, 6, "the second ask answered");
    assert.strictEqual(r.fake.state.calls.filter(c => c.action === "Browse").length, 2,
      "asked twice, not once and not three times");
  } finally { await r.cleanup(); }
});

test("a Browse the player REFUSES is not asked again", async () => {
  /* A refusal is an answer. Repeating it just gets the same answer twice, and
     a caller that cannot tell the two apart retries everything for ever. */
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));
    r.fake.state.faults.set("Browse", "701");
    r.fake.state.calls.length = 0;
    await assert.rejects(() => r.playback.queue(r.kitchen()), /refused/);
    assert.strictEqual(r.fake.state.calls.filter(c => c.action === "Browse").length, 1);
  } finally { await r.cleanup(); }
});

test("a player that refuses the batch still gets its queue", async () => {
  /*
   * This cannot be tried against every speaker that exists, so the old path
   * stays as the fallback: a refusal must end in a full queue, not an error.
   * Sonos takes a batch whole or not at all, so there is nothing half-added to
   * undo.
   */
  const r = await rig();
  try {
    r.fake.state.faults.set("AddMultipleURIsToQueue", "401");
    const result = await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));
    assert.strictEqual(result.queued, 6);
    assert.strictEqual(r.fake.state.queue.length, 6, "the queue was filled anyway");
    assert.strictEqual(r.fake.actions().filter(a => a === "AddURIToQueue").length, 6,
      "one at a time, which is what the fallback is");
    assert.strictEqual(r.fake.state.transportState, "PLAYING", "and it still started");
  } finally { await r.cleanup(); }
});

test("removing picked positions removes exactly those, and nothing shifts under it", async () => {
  /*
   * THE ORDER OF THE CALLS IS THE WHOLE OF THE CORRECTNESS. Sonos numbers the
   * queue from 1 and renumbers what is left the instant anything goes, so a
   * caller working forwards deletes the wrong tracks from the second range on.
   * Contiguous positions are collapsed into one range and the ranges applied
   * from the END backwards.
   */
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));
    const before = r.fake.state.queue.map(q => q.uri);
    assert.strictEqual(before.length, 6);

    /* 2 and 3 are a run; 5 is on its own. */
    const out = await r.playback.removeFromQueue(r.kitchen(), [3, 2, 5, 2]);
    assert.strictEqual(out.removed, 3, "duplicates counted once");

    const after = r.fake.state.queue.map(q => q.uri);
    assert.deepStrictEqual(after, [before[0], before[3], before[5]],
      "1, 4 and 6 are what is left");
    /* Two runs, so two calls — not three, and not six. */
    assert.strictEqual(
      r.fake.actions().filter(a => a === "RemoveTrackRangeFromQueue").length, 2);
  } finally { await r.cleanup(); }
});

test("clearing the queue is one call, whatever is in it", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));
    await r.playback.clearQueue(r.kitchen());
    assert.deepStrictEqual(r.fake.state.queue, []);
    assert.strictEqual(
      r.fake.actions().filter(a => a === "RemoveAllTracksFromQueue").length, 2,
      "once for the Play that replaced, once for the clear");
  } finally { await r.cleanup(); }
});

test("a position that is not one is refused rather than guessed at", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));
    const out = await r.playback.removeFromQueue(r.kitchen(), [0, -1, "x", null]);
    assert.strictEqual(out.removed, 0);
    assert.strictEqual(r.fake.state.queue.length, 6, "and nothing was touched");
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

/* ---------------------------------------------------------------- */
/*  Several albums at once, from the grid's select mode              */
/* ---------------------------------------------------------------- */

test("several albums play as one queue, in the order they were chosen", async () => {
  const r = await rig();
  try {
    const result = await r.playback.playAlbums(r.kitchen(),
      [r.albumId("Hex"), r.albumId("Spirit of Eden"), r.albumId("Souvlaki")]);

    /* Three albums, one clear. Enqueueing them one album at a time would clear
       the queue three times and leave only the last album on the speaker —
       which is the whole reason this is one call rather than a loop. */
    assert.strictEqual(r.fake.actions().filter(a => a === "RemoveAllTracksFromQueue").length, 1);
    assert.strictEqual(result.queued, 3 + 6 + 3);
    assert.strictEqual(r.fake.state.queue.length, 3 + 6 + 3);

    const albums = r.fake.state.queue.map(item =>
      /<upnp:album>([^<]*)<\/upnp:album>/.exec(item.metadata)[1]);
    assert.deepStrictEqual([...new Set(albums)], ["Hex", "Spirit of Eden", "Souvlaki"],
      "the order chosen is the order queued, not whatever order the library is in");

    assert.strictEqual(r.fake.state.transportState, "PLAYING");
    assert.strictEqual(r.fake.state.track, 1, "and it starts at the first of them");
  } finally { await r.cleanup(); }
});

test("queueing several albums appends them all and starts nothing", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Souvlaki"));
    const before = r.fake.state.queue.length;
    r.fake.state.calls.length = 0;

    await r.playback.playAlbums(r.kitchen(),
      [r.albumId("Hex"), r.albumId("Spirit of Eden")], { replace: false });

    assert.ok(!r.fake.actions().includes("RemoveAllTracksFromQueue"), "nothing was cleared");
    assert.ok(!r.fake.actions().includes("Play"), "and nothing was restarted");
    assert.strictEqual(r.fake.state.queue.length, before + 3 + 6);
  } finally { await r.cleanup(); }
});

test("each album in a multi-album queue keeps its own sleeve and artist", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbums(r.kitchen(), [r.albumId("Hex"), r.albumId("Souvlaki")]);
    /* enqueue() looks each album up once for the metadata. Handing every track
       the FIRST album's details would show one sleeve down the whole queue,
       which is exactly what the Sonos app would then display. */
    for (const item of r.fake.state.queue) {
      assert.match(item.metadata, /RINCON_AssociatedZPUDN/);
      assert.match(item.metadata, /<upnp:album>(Hex|Souvlaki)<\/upnp:album>/);
    }
    const arts = new Set(r.fake.state.queue.map(item =>
      (/<upnp:albumArtURI>([^<]*)<\/upnp:albumArtURI>/.exec(item.metadata) || [])[1]));
    assert.strictEqual(arts.size, 2, "two albums, two covers");
  } finally { await r.cleanup(); }
});

test("a selection of albums that are all gone says so rather than clearing the room", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Souvlaki"));
    const before = r.fake.state.queue.length;
    await assert.rejects(
      () => r.playback.playAlbums(r.kitchen(), ["a:gone", "a:alsogone"]),
      /no playable files/);
    /* The check is BEFORE the queue is cleared, so a stale selection cannot
       cost somebody the queue they were listening to. */
    assert.strictEqual(r.fake.state.queue.length, before);
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
/*
 * Artwork on the screens that are NOT the album screen.
 *
 * Now playing, the Queue and the mini transport all take their cover from the
 * transport payloads rather than from /api/album, and all three lost it in
 * 0.4.9 when the column behind them was renamed and the readers were not.
 * Nothing asserted on these payloads, so the suite stayed green while the app
 * showed three empty boxes.
 */
test("now playing and the queue carry the album's cover", async () => {
  const r = await rig();
  try {
    /* Spirit of Eden is the fixture album with a cover.png in its folder. */
    await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));
    r.fake.playingAt(1, "0:00:04", "0:05:00");

    const now = await r.playback.nowPlaying(r.kitchen());
    assert.ok(now.album, "there is an album playing");
    assert.match(now.album.art, /^\/art\/\S+$/,
      "the Now playing screen and the mini bar both read this one field");

    const queue = await r.playback.queue(r.kitchen());
    assert.ok(queue.items.length, "the queue has rows");
    for (const item of queue.items) {
      assert.match(item.art, /^\/art\/\S+$/, `queue row "${item.title}" has its cover`);
    }
  } finally { await r.cleanup(); }
});

test("a cover that was FOUND shows on those screens too", async () => {
  const r = await rig();
  try {
    /* Hex is the fixture album with no cover of any kind. Give it one the way
       lib/covers.js does — a path in art_fetched, with `art` left empty — and
       every screen must treat it as a cover, because to a listener it is one. */
    const hex = r.albumId("Hex");
    r.db.prepare("UPDATE albums SET art_fetched = '/somewhere/found.jpg' WHERE id = ?").run(hex);

    await r.playback.playAlbum(r.kitchen(), hex);
    r.fake.playingAt(1, "0:00:04", "0:05:00");

    const now = await r.playback.nowPlaying(r.kitchen());
    assert.match(now.album.art, /^\/art\/\S+$/);
    const queue = await r.playback.queue(r.kitchen());
    assert.ok(queue.items.every(i => /^\/art\/\S+$/.test(i.art)));
  } finally { await r.cleanup(); }
});

test("an album with no cover at all says so, rather than pointing at nothing", async () => {
  const r = await rig();
  try {
    await r.playback.playAlbum(r.kitchen(), r.albumId("Hex"));
    r.fake.playingAt(1, "0:00:04", "0:05:00");
    const now = await r.playback.nowPlaying(r.kitchen());
    assert.strictEqual(now.album.art, "",
      "an empty string is what the client tests to hide the image");
  } finally { await r.cleanup(); }
});

/*
 * A corrected name has to reach the transport too.
 *
 * /api/now and /api/queue feed three screens that /api/album never touches,
 * and the speaker gets a fourth copy in the DIDL it is handed. An album called
 * one thing on the home screen and another on Now playing is the same bug
 * 0.4.9 shipped when a renamed column was updated in one reader of three.
 */
test("a corrected name reaches Now playing, the queue and the speaker", async () => {
  const r = await rig();
  try {
    const library = require("../lib/library");
    /* Field Recordings is the fixture album whose files name NO artist — the
       case the edit dialog exists for, and the one where the album artist is
       what the player has to fall back on. */
    const field = r.albumId("Field Recordings");
    library.setNames(r.db, field, { title: "Sea Nettles", artist: "Chris Watson" });

    await r.playback.playAlbum(r.kitchen(), field);
    r.fake.playingAt(1, "0:00:04", "0:05:00");

    const now = await r.playback.nowPlaying(r.kitchen());
    assert.strictEqual(now.album.title, "Sea Nettles", "Now playing and the mini bar");
    assert.strictEqual(now.album.artist, "Chris Watson");

    const queue = await r.playback.queue(r.kitchen());
    assert.ok(queue.items.length, "the queue has rows to check");

    /* What the SPEAKER was told. Sonos shows this in its own app and on any
       display the player has, so a name corrected here and not there is a
       correction that only half happened.

       The album artist is a FALLBACK in the DIDL — a track that names its own
       artist keeps it, because a compilation's album artist is "Various
       Artists" and not who performed the track. That is why this album is the
       one asserted on: its files name nobody, so the corrected album artist is
       what the player is given. */
    const sent = r.fake.state.queue.map(item => item.metadata).join(" ");
    assert.ok(sent.includes("Sea Nettles"), "the DIDL carries the corrected album title");
    assert.ok(sent.includes("Chris Watson"), "and the corrected album artist");
  } finally { await r.cleanup(); }
});

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


/* ------------------------------------------------------------------ */
/*  Random Album Radio                                                 */
/* ------------------------------------------------------------------ */

/*
 * The top-up, driven through the real poll loop against the fake speaker.
 *
 * Everything here goes through the queue the PLAYER holds — the fake honours
 * StartingIndex the way a real one does, so the radio is reading the tail of a
 * queue rather than being handed the whole of it.
 */
const { createRadio } = require("../lib/radio");
const settingsLib = require("../lib/settings");

function withRadio(db, { enabled = true, matchGenre = false } = {}) {
  const radio = createRadio({ db, settings: settingsLib.open(db) });
  radio.setEnabled(enabled);
  radio.setMatchGenre(matchGenre);
  return radio;
}

/* How many albums the player's queue holds, read the way the radio reads it. */
function albumsInQueue(r) {
  const ids = new Set();
  for (const item of r.fake.state.queue) {
    const id = decodeId((/\/stream\/([^./?]+)/.exec(item.uri) || [])[1] || "");
    const track = id ? r.db.prepare("SELECT album_id FROM tracks WHERE id = ?").get(id) : null;
    if (track) ids.add(track.album_id);
  }
  return [...ids];
}

test("the radio adds another album once the last one is playing", async () => {
  const r = await rig();
  try {
    r.playback.radio = withRadio(r.db);
    await r.playback.playAlbum(r.kitchen(), r.albumId("Souvlaki"));
    assert.deepStrictEqual(albumsInQueue(r), [r.albumId("Souvlaki")], "one album to start");

    /* On the first track, with the rest of the album still ahead: nothing due. */
    r.fake.playingAt(1, "0:00:01", "0:03:00");
    await r.playback.poll();
    await new Promise(done => setImmediate(done));
    assert.strictEqual(albumsInQueue(r).length, 1, "the album has not run out yet");

    /* On the LAST track, with nothing after it. */
    r.fake.playingAt(r.fake.state.queue.length, "0:00:01", "0:03:00");
    await r.playback.poll();
    await new Promise(done => setTimeout(done, 60));
    const after = albumsInQueue(r);
    assert.strictEqual(after.length, 2, "a second album was queued: " + after.join(", "));
    assert.notStrictEqual(after[1], r.albumId("Souvlaki"), "and it is not the one playing");
  } finally { await r.cleanup(); }
});

test("the radio does nothing at all while it is switched off", async () => {
  const r = await rig();
  try {
    r.playback.radio = withRadio(r.db, { enabled: false });
    await r.playback.playAlbum(r.kitchen(), r.albumId("Souvlaki"));
    r.fake.playingAt(r.fake.state.queue.length, "0:00:01", "0:03:00");
    await r.playback.poll();
    await new Promise(done => setTimeout(done, 60));
    assert.strictEqual(albumsInQueue(r).length, 1, "the queue ends where it was left");
  } finally { await r.cleanup(); }
});

test("the radio keeps to the genre when it is asked to", async () => {
  const r = await rig();
  try {
    r.playback.radio = withRadio(r.db, { matchGenre: true });
    /* Spirit of Eden is Art Rock, and so are Laughing Stock and Hex. */
    await r.playback.playAlbum(r.kitchen(), r.albumId("Spirit of Eden"));
    r.fake.playingAt(r.fake.state.queue.length, "0:00:01", "0:03:00");
    await r.playback.poll();
    await new Promise(done => setTimeout(done, 60));

    const added = albumsInQueue(r).filter(id => id !== r.albumId("Spirit of Eden"));
    assert.strictEqual(added.length, 1);
    const genre = r.db.prepare("SELECT genre FROM albums WHERE id = ?").get(added[0]).genre;
    assert.strictEqual(genre, "Art Rock", "picked " + added[0]);
  } finally { await r.cleanup(); }
});

test("the radio does not interrupt what is already queued behind it", async () => {
  /* Two albums queued by hand: the second is still to come, so the radio has
     nothing to do until it is reached. */
  const r = await rig();
  try {
    r.playback.radio = withRadio(r.db);
    await r.playback.playAlbum(r.kitchen(), r.albumId("Souvlaki"));
    await r.playback.queueAlbum(r.kitchen(), r.albumId("Hex"));
    const before = albumsInQueue(r).length;

    /* Still inside the FIRST album. */
    r.fake.playingAt(1, "0:00:01", "0:03:00");
    await r.playback.poll();
    await new Promise(done => setTimeout(done, 60));
    assert.strictEqual(albumsInQueue(r).length, before, "nothing added over the top");
  } finally { await r.cleanup(); }
});

test("the radio tops up at the end of a queue it did not build alone", async () => {
  /*
   * THE CASE THE WHOLE FEATURE IS FOR, and the only one where reading the TAIL
   * of the queue rather than the whole of it makes any difference.
   *
   * Play one album, queue another by hand, and listen to the end of the
   * second. Everything AFTER the current track is nothing, so this is the last
   * album and another is due — but the queue as a whole still contains the
   * first album, so a radio that read all of it would decide there was more to
   * come and let the music stop.
   */
  const r = await rig();
  try {
    r.playback.radio = withRadio(r.db);
    await r.playback.playAlbum(r.kitchen(), r.albumId("Souvlaki"));
    await r.playback.queueAlbum(r.kitchen(), r.albumId("Hex"));
    const before = albumsInQueue(r);
    assert.strictEqual(before.length, 2, "two albums queued by hand");

    /* The very last track of the second album. */
    r.fake.playingAt(r.fake.state.queue.length, "0:00:01", "0:03:00");
    await r.playback.poll();
    await new Promise(done => setTimeout(done, 60));

    const after = albumsInQueue(r);
    assert.strictEqual(after.length, 3, "a third album followed: " + after.join(", "));
    assert.ok(!before.includes(after[2]), "and it is not one already played");
  } finally { await r.cleanup(); }
});

test("the radio would rather add nothing than repeat what is queued", async () => {
  /*
   * Deterministic on purpose. Cut the library down to exactly the two albums
   * already in the queue, and there is no third answer: a radio that excludes
   * everything queued must add nothing, and one that only excludes the album
   * PLAYING has the first album still eligible and will eventually offer it
   * back. Asserting on "nothing was added" is the only version of this that
   * cannot pass by luck of the draw.
   */
  const r = await rig();
  try {
    r.playback.radio = withRadio(r.db);
    await r.playback.playAlbum(r.kitchen(), r.albumId("Souvlaki"));
    await r.playback.queueAlbum(r.kitchen(), r.albumId("Hex"));
    r.db.prepare("UPDATE albums SET present = 0 WHERE title NOT IN ('Souvlaki', 'Hex')").run();

    const before = r.fake.state.queue.length;
    r.fake.playingAt(before, "0:00:01", "0:03:00");
    await r.playback.poll();
    await new Promise(done => setTimeout(done, 60));

    assert.strictEqual(r.fake.state.queue.length, before,
      "there was nothing left to add, so nothing was added");
    assert.deepStrictEqual(albumsInQueue(r).sort(),
      [r.albumId("Hex"), r.albumId("Souvlaki")].sort(), "and neither was queued twice");
  } finally { await r.cleanup(); }
});

test("a top-up does not restart or reorder what is playing", async () => {
  /* The append must not touch the transport: pointing it at the queue again
     would start the record over. */
  const r = await rig();
  try {
    r.playback.radio = withRadio(r.db);
    await r.playback.playAlbum(r.kitchen(), r.albumId("Souvlaki"));
    const first = r.fake.state.queue.map(q => q.uri);

    r.fake.playingAt(r.fake.state.queue.length, "0:00:01", "0:03:00");
    const at = r.fake.state.track;
    await r.playback.poll();
    await new Promise(done => setTimeout(done, 60));

    assert.strictEqual(r.fake.state.track, at, "the player is still on the same track");
    assert.deepStrictEqual(r.fake.state.queue.slice(0, first.length).map(q => q.uri), first,
      "and what was already queued is untouched, in order");
    assert.ok(r.fake.state.queue.length > first.length, "the new album went on the end");
  } finally { await r.cleanup(); }
});
