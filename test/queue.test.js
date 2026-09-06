/*
 * The seam between "a room's queue" and "how that particular room holds one".
 *
 * There is one implementation today, so almost nothing here is about
 * behaviour — test/playback.test.js already drives enqueueing, batching, the
 * one-at-a-time fallback and tap-to-jump through the real stack, and those
 * tests passed unchanged across this split, which is the strongest thing that
 * can be said about it.
 *
 * What these tests are for is the LINE. A seam nothing asserts is a seam that
 * closes the first time a direct call to a speaker is the shorter way to fix
 * something — and the whole reason for cutting it before there is a second
 * kind of player is that lib/playback.js also counts plays and drives the
 * radio, and is not a file to be discovering that in.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const os = require("os");
const dbLib = require("../lib/db");
const scanner = require("../lib/scanner");
const dlna = require("../lib/dlna");
const { Zones } = require("../lib/zones");
const settingsLib = require("../lib/settings");
const { Playback } = require("../lib/playback");
const { SonosQueue, ServerQueue } = require("../lib/queue");
const { Player, Household } = require("../lib/sonos");
const { createFakeSonos } = require("./fake-sonos");
const { createFakeRenderer } = require("./fake-dlna");
const { buildLibrary } = require("./fixtures");

function codeOf(file) {
  /* Block comments stripped: the prose explaining why something is absent
     names it, and a guard tripped by its own rationale is a guard somebody
     deletes. Same reason test/frontend.test.js matches the iOS metas by tag
     rather than by word. */
  return fs.readFileSync(path.join(__dirname, "..", "lib", file), "utf8")
           .replace(/\/\*[\s\S]*?\*\//g, "");
}

test("a queue implements all of what a queue is, so a second one has a list", () => {
  /*
   * Stated as a set rather than discovered from the one implementation. When
   * a server-side queue arrives for players that have none of their own, this
   * is what it has to answer — and a method quietly added to SonosQueue alone
   * would be a method lib/playback.js could come to depend on while the other
   * implementation knows nothing about it.
   */
  const required = ["list", "length", "add", "clear", "startAt", "jumpTo",
                    "position", "playing", "next", "previous"];
  const proto = SonosQueue.prototype;
  for (const name of required) {
    assert.strictEqual(typeof proto[name], "function", `a queue must have ${name}()`);
  }

  const own = Object.getOwnPropertyNames(proto)
    .filter(n => n !== "constructor" && typeof proto[n] === "function");
  assert.deepStrictEqual(own.slice().sort(), required.slice().sort(),
    "SonosQueue has grown a method the interface does not name");

  /* And the other implementation answers all of it. ServerQueue has more of
     its own — it is doing a job the speaker does for the Sonos one — but every
     name the interface states has to be there, or lib/playback.js would be
     calling something that exists on only one kind of room. */
  for (const name of required) {
    assert.strictEqual(typeof ServerQueue.prototype[name], "function",
      `ServerQueue is missing ${name}()`);
  }
});

test("startAt and jumpTo stay two calls, because on Sonos they are", async () => {
  /*
   * They look alike and a future server-side queue will implement both the
   * same way — but on Sonos the transport may be on a radio stream, so
   * startAt has to point it at the queue first and jumpTo must not. That one
   * CAN merge them is a fact about that protocol, not a licence to.
   *
   * DRIVEN AGAINST THE PLAYER RATHER THAN READ OFF THE SOURCE. The first
   * version of this test looked for SetAVTransportURI in the text of jumpTo(),
   * and passed happily when jumpTo was changed to call startAt() — the string
   * was not in its body any more, and the extra SOAP call went out all the
   * same. What the speaker is asked is the only thing that settles it.
   */
  const fake = createFakeSonos({ port: 11403 });
  await fake.listen();
  try {
    const player = new Player({ ip: "127.0.0.1", uuid: "RINCON_X", name: "Kitchen", port: 11403 });
    const queue = new SonosQueue(player);

    await queue.jumpTo(4);
    assert.deepStrictEqual(fake.actions(), ["Seek"],
      "a jump on a queue already playing is one call and no more");
    assert.strictEqual(fake.state.track, 4);

    fake.state.calls.length = 0;
    await queue.startAt(2, { autoplay: true, resetPlayMode: true });
    assert.deepStrictEqual(fake.actions(),
      ["SetAVTransportURI", "SetPlayMode", "Seek", "Play"],
      "starting has to point the transport at the queue first — the player " +
      "may have been on a radio stream, and Play would resume that instead");
    assert.match(fake.state.currentUri, /^x-rincon-queue:RINCON_X/);

    /* autoplay off is what the radio appends with: the queue is pointed at and
       positioned, and nothing is pressed. */
    fake.state.calls.length = 0;
    await queue.startAt(1, { autoplay: false });
    assert.ok(!fake.actions().includes("Play"), "nothing is started when autoplay is off");
    assert.ok(!fake.actions().includes("SetPlayMode"), "and the play mode is left alone");
  } finally {
    await fake.close();
  }
});

test("lib/playback.js asks a queue, never a speaker", () => {
  /*
   * THE POINT OF THE WHOLE RELEASE. Every one of these is either a Sonos queue
   * extension or a Sonos URI scheme, and a player that holds no queue of its
   * own implements none of them. One left behind here is one branch that would
   * have to be written twice — in the file that also counts plays.
   */
  const src = codeOf("playback.js");
  for (const call of ["browseQueue", "addToQueue", "addManyToQueue", "clearQueue",
                      "seekTrack", "mediaInfo", "queueUri", "setAvTransportUri",
                      "x-rincon", "AddURIToQueue", "RemoveAllTracksFromQueue"]) {
    assert.ok(!src.includes(call), `lib/playback.js still reaches for ${call}`);
  }

  /* And it builds no metadata: what a track IS comes from the library, what a
     player wants to be TOLD about it is protocol, and only one of those is
     this file's business. */
  assert.ok(!/require\(["']\.\/didl["']\)/.test(src),
    "lib/playback.js builds DIDL, which belongs with the queue that sends it");
});

test("one place decides where a room's queue lives", () => {
  /*
   * A room whose queue is held by the server rather than by the device should
   * be one more branch in queueFor() and no change anywhere else. That is only
   * true while queueFor() is the sole constructor.
   */
  const src = codeOf("playback.js");
  assert.match(src, /queueFor\(player\)\s*\{[\s\S]{0,200}new SonosQueue\(player\)/);
  assert.strictEqual((src.match(/new SonosQueue\(/g) || []).length, 1,
    "a queue is constructed in exactly one place");
  /* Every other user of a queue goes through it. */
  assert.ok((src.match(/this\.queueFor\(/g) || []).length >= 5,
    "the callers ask queueFor() rather than holding one of their own");
});

test("the line is whether an action needs a LIST, not whether it looks like transport", () => {
  /*
   * This guard used to forbid next() and previous() here too, on the reasoning
   * that a queue is "the list and where in it we are" and everything else is
   * transport. That reasoning shipped two buttons that did nothing: 0.4.47 sent
   * AVTransport's Next and Previous to a stock renderer, which moves through
   * the queue the DEVICE holds — and a stock renderer holds none.
   *
   * THE REAL DIVIDING LINE is whether an action means anything with no list at
   * all. Play, pause, stop, seek-within-a-track and volume do: they are the
   * same actions on any device, playing anything. Next and previous do not —
   * they are a move through a list, so they belong to whatever holds it.
   */
  const src = codeOf("queue.js");
  for (const action of ["setVolume", "setMute", "\\.pause\\(", "\\.stop\\(",
                        "\\.seek\\("]) {
    assert.ok(!new RegExp(action).test(src), `lib/queue.js drives ${action}`);
  }
  /* play() is the one exception among those and it is deliberate: starting at
     a position is not "begin playing" until something presses play. */
  assert.match(src, /startAt\([\s\S]{0,400}this\.player\.play\(\)/);

  /* And lib/playback.js sends neither to a player directly — the queue decides
     what "next" means, because only it knows whether there is a list. */
  const pb = codeOf("playback.js");
  assert.ok(!/coord\.next\(\)/.test(pb) && !/coord\.previous\(\)/.test(pb),
    "lib/playback.js still sends Next or Previous to the device");
  assert.match(pb, /this\.queueFor\(coord\)\.next\(\)/);
  assert.match(pb, /this\.queueFor\(coord\)\.previous\(\)/);
});

/* ---------------------------------------------------------------- */
/*  A queue the server holds, and gapless                            */
/* ---------------------------------------------------------------- */

/*
 * A real Playback driving a real fake renderer through a real database.
 *
 * Not a mock of the queue: the whole question here is whether the pieces move
 * each other, and every bug in the last three releases was a join between two
 * pieces that each worked.
 */
const WIIM = "uuid:11111111-2222-3333-4444-555555555555";

async function upnpRig({ port, gapless = true, sink } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-sq-"));
  const music = path.join(root, "music");
  buildLibrary(music);
  const db = dbLib.open(path.join(root, "data"));
  await scanner.scan(db, [music], { artDir: path.join(root, "data", "cache", "art") });

  const device = createFakeRenderer({ port, name: "WiiM Pro Plus", gapless,
                                     ...(sink === undefined ? {} : { sink }) });
  await device.listen();

  const renderers = new dlna.Renderers({ seeds: [device.location] });
  renderers.search = async () => [];
  await renderers.refresh({ force: true });

  const settings = settingsLib.open(db);
  const household = new Zones({
    sonos: new Household({ hosts: [] }), renderers, settings
  });
  household.setEnabled(WIIM, true);

  const playback = new Playback({
    db, household, baseUrl: () => "http://192.168.1.9:3400",
    onLibraryChange: () => {}, scrobbler: null, radio: null
  });

  return {
    db, device, playback, household,
    albumId: (title) => db.prepare("SELECT id FROM albums WHERE title = ?").get(title).id,
    queue: () => playback.queueFor(household.get(WIIM)),
    async cleanup() {
      await device.close();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test("a room with no queue of its own gets one the server holds", async () => {
  const r = await upnpRig({ port: 49181 });
  try {
    const queue = r.queue();
    assert.ok(queue instanceof ServerQueue, "and it is not a SonosQueue");
    assert.strictEqual(queue.holds, true, "unlike the placeholder it replaced");

    const out = await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    assert.strictEqual(out.queued, 6);

    /* The device holds one URI; the QUEUE holds the record. */
    assert.strictEqual(await r.queue().length(), 6);
    assert.strictEqual(r.device.state.transportState, "PLAYING");
    assert.match(r.device.state.currentUri, /\/stream\//);

    /* The rows outlive the objects: a second Playback on the same database —
       a restart — finds the room where it left off. */
    assert.strictEqual(r.queue().at(), 1);
  } finally { await r.cleanup(); }
});

test("the next track is armed while this one is still starting", async () => {
  /*
   * THE WHOLE OF GAPLESS. Waiting for the transition means the gap has already
   * happened — the device needs the next URI early enough to pre-buffer it,
   * which is why this is done when a track STARTS.
   */
  const r = await upnpRig({ port: 49182 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    assert.ok(r.device.state.nextUri, "something was handed over");
    assert.notStrictEqual(r.device.state.nextUri, r.device.state.currentUri,
      "and it is the track AFTER this one");
  } finally { await r.cleanup(); }
});

test("and armed again every time the device moves on", async () => {
  /*
   * THE TEST THAT MATTERS, and the one a fake that never advanced would pass
   * with the bug in place. Handing over the next URI ONCE gives exactly two
   * gapless tracks and a gap after every one thereafter, because the slot
   * EMPTIES when the device crosses into it.
   *
   * So the fake advances the way a real device does, the poll notices, and the
   * following track has to be armed — for as long as the queue lasts.
   */
  const r = await upnpRig({ port: 49183 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    const seen = [r.device.state.currentUri];

    for (let step = 0; step < 5; step++) {
      assert.ok(r.device.state.nextUri,
        `nothing was armed after track ${step + 1} — the queue gaps from here on`);
      assert.ok(r.device.advance(), "the device crossed into it");
      assert.strictEqual(r.device.state.nextUri, "",
        "which empties the slot, as a real device does");

      await r.playback.poll();
      /* Arming the next track is deliberately not awaited by the poll, so a
         slow device cannot hold up counting plays in another room. settle()
         is how a test waits for what production never needs to. */
      await r.playback.settle();
      /* The poll has to notice where the room actually IS, and refill. */
      assert.strictEqual(r.queue().at(), step + 2,
        "the queue followed the device to position " + (step + 2));
      seen.push(r.device.state.currentUri);
    }

    assert.strictEqual(new Set(seen).size, 6, "six different tracks played in order");
    /* The last track has nothing after it, and nothing is invented. */
    assert.strictEqual(r.device.state.nextUri, "", "the record ends rather than looping");
  } finally { await r.cleanup(); }
});

test("the device is told what it is playing, in its own dialect", async () => {
  /*
   * A renderer handed a bare URL shows whatever it makes of one — usually the
   * file name, often nothing at all. So metadata goes with every track.
   *
   * IN THE DLNA DIALECT, which differs from Sonos' in both directions:
   *
   *   - NO RINCON SENTINEL. It is a Sonos namespace and means nothing here.
   *   - DLNA.ORG_OP=01 in the protocolInfo, which says byte-range seek is
   *     supported. A certified renderer told nothing may simply refuse to
   *     scrub, so the transport bar working depends on saying it — and it is
   *     claimed honestly, because /stream/ answers real 206s.
   */
  const r = await upnpRig({ port: 49186 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    const meta = r.device.state.currentMeta;
    assert.ok(meta, "something was sent");
    assert.match(meta, /<dc:title>/, "the device can say what is playing");
    assert.match(meta, /<upnp:albumArtURI>|<upnp:album>/, "and what it came off");
    assert.match(meta, /DLNA\.ORG_OP=01/, "byte-range seek is advertised");
    assert.ok(!meta.includes("RINCON"), "and no Sonos sentinel, which means nothing here");

    /* The armed track carries its own, or the device shows the previous one's
       title for the whole of the next track. */
    assert.match(r.device.state.nextMeta, /<dc:title>/);
    assert.notStrictEqual(r.device.state.nextMeta, meta);
  } finally { await r.cleanup(); }
});

test("a Sonos still gets the sentinel, and no DLNA flags", async () => {
  /*
   * The other half of the same decision. Without the sentinel a Sonos accepts
   * the SOAP call and then refuses to play, with no error anywhere a person
   * can see — so the dialects must not converge by accident.
   */
  const didl = require("../lib/didl");
  const track = { id: "t1", album_id: "a1", title: "One", artist: "Talk Talk",
                  mime: "audio/flac", duration: 120, no: 1 };
  const forSonos = didl.trackItem(track, { uri: "http://x/1.flac", album: "Spirit of Eden" });
  const forDlna = didl.trackItem(track, { uri: "http://x/1.flac", album: "Spirit of Eden",
                                          dlna: true });

  assert.match(forSonos, /RINCON_AssociatedZPUDN/);
  assert.match(forSonos, /protocolInfo="http-get:\*:audio\/flac:\*"/,
    "Sonos is happy with a bare fourth field and gets one");
  assert.ok(!forSonos.includes("DLNA.ORG"));

  assert.ok(!forDlna.includes("RINCON"));
  assert.match(forDlna, /protocolInfo="http-get:\*:audio\/flac:DLNA\.ORG_OP=01;/);
});

/*
 * Nothing has stopped the room but the end of a track: the window in which a
 * device might merely be opening a URI it was just handed has passed.
 */
async function stops(r) {
  r.playback.sentUris.clear();
  r.device.state.transportState = "STOPPED";
  for (let i = 0; i < 2; i++) { await r.playback.poll(); await r.playback.settle(); }
}

test("a room is filtered by what IT plays, not by what a Sonos plays", async () => {
  /*
   * Reported by reading philippe44's LMS-to-uPnP bridge, which asks
   * GetProtocolInfo and this did not. Every room went through the Sonos list
   * whatever kind it was, so a renderer that does not decode FLAC was handed
   * FLAC and failed silently — and one that plays Opus was refused it with an
   * error naming a speaker its owner may not own.
   */
  const r = await upnpRig({ port: 49203, sink: ["http-get:*:audio/mpeg:*"] });
  try {
    await assert.rejects(
      () => r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden")),   // .wav fixtures
      (e) => {
        assert.match(e.message, /WiiM Pro Plus cannot play any of these files/,
          "the ROOM is named, not a manufacturer: " + e.message);
        assert.match(e.message, /It handles mpeg\./, "and it says what it did offer");
        return true;
      });
    assert.strictEqual(await r.queue().length(), 0, "and nothing was queued");
  } finally { await r.cleanup(); }
});

test("and the same room takes what it did offer", async () => {
  const r = await upnpRig({ port: 49204, sink: ["http-get:*:audio/wav:*"] });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    assert.ok(await r.queue().length() > 0, "the wav files went on");
    assert.strictEqual(r.device.state.transportState, "PLAYING");
  } finally { await r.cleanup(); }
});

test("a device that cannot hand over early still plays, one track at a time", async () => {
  /*
   * SetNextAVTransportURI is optional. A device without it is not refused —
   * it plays with a gap between tracks, which is what that device can do, and
   * `can` was read from its own description rather than assumed.
   *
   * "ONE TRACK AT A TIME" IS THE PART THAT WAS NEVER ASSERTED. The first
   * version of this test stopped at "the first track plays", which was true
   * with the album ending there for ever — nothing armed the next one and the
   * poll skipped any room that was not PLAYING, so a renderer without the
   * action played exactly one track and stopped. Found by reading philippe44's
   * LMS-to-uPnP bridge, which has handled it since forever.
   */
  const r = await upnpRig({ port: 49184, gapless: false });
  try {
    assert.strictEqual(r.queue().gapless, false);
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    const first = r.device.state.currentUri;
    assert.strictEqual(r.device.state.transportState, "PLAYING", "it plays");
    assert.strictEqual(r.device.state.nextUri, "", "nothing was handed over");
    assert.ok(!r.device.actions().includes("SetNextAVTransportURI"),
      "and it was never asked to do what it said it could not");

    await stops(r);
    assert.strictEqual(r.device.state.transportState, "PLAYING", "the record did not end");
    assert.strictEqual(r.queue().at(), 2);
    assert.notStrictEqual(r.device.state.currentUri, first, "it is on the second track");
  } finally { await r.cleanup(); }
});

test("a hand-over that silently failed does not end the album", async () => {
  /*
   * The other way to arrive at a stopped device: the slot WAS armed and the
   * device stopped instead of crossing over. The bridge calls this
   * SQ_NEXT_FAILED and asks the server to move on; without it a gapless room
   * ends its record wherever the hand-over happened to miss, intermittently,
   * which is the worst kind of fault to be left with.
   */
  const r = await upnpRig({ port: 49198 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    assert.ok(r.device.state.nextUri, "armed");
    const first = r.device.state.currentUri;

    await stops(r);
    assert.strictEqual(r.device.state.transportState, "PLAYING");
    assert.notStrictEqual(r.device.state.currentUri, first);
  } finally { await r.cleanup(); }
});

test("a room somebody stopped stays stopped", async () => {
  /*
   * A SILENT DEVICE IS THE SAME SHAPE EITHER WAY, so which one it is is
   * remembered rather than inferred. Restarting music a person deliberately
   * silenced is far worse than an album that ended early — and it is the
   * failure mode that makes the fix above dangerous if it guesses.
   */
  for (const [action, port] of [["stop", 49199], ["pause", 49200]]) {
    const r = await upnpRig({ port });
    try {
      await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
      const on = r.device.state.currentUri;
      await r.playback.command(WIIM, action);
      r.playback.sentUris.clear();
      for (let i = 0; i < 2; i++) { await r.playback.poll(); await r.playback.settle(); }

      assert.notStrictEqual(r.device.state.transportState, "PLAYING",
        `${action} was undone by the poll`);
      assert.strictEqual(r.device.state.currentUri, on, "and it did not move on");
      assert.strictEqual(r.queue().at(), 1);
    } finally { await r.cleanup(); }
  }
});

test("play after a stop lets the poll move the room on again", async () => {
  /* The flag has to be cleared by anything that starts music, or a room that
     was once stopped never advances itself again. */
  const r = await upnpRig({ port: 49201 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    await r.playback.command(WIIM, "stop");
    await r.playback.command(WIIM, "play");
    const first = r.device.state.currentUri;

    await stops(r);
    assert.strictEqual(r.queue().at(), 2, "the room advanced");
    assert.notStrictEqual(r.device.state.currentUri, first);
  } finally { await r.cleanup(); }
});

test("the end of the record is the end, not a loop", async () => {
  const r = await upnpRig({ port: 49202 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Field Recordings"));   // two tracks
    await r.playback.command(WIIM, "next");
    assert.strictEqual(r.queue().at(), 2);
    const last = r.device.state.currentUri;

    await stops(r);
    assert.strictEqual(r.queue().at(), 2, "it stayed at the end");
    assert.strictEqual(r.device.state.currentUri, last);
    assert.strictEqual(r.device.state.transportState, "STOPPED",
      "and nothing started it again");
  } finally { await r.cleanup(); }
});

test("the room follows its own app rather than assuming it stepped by one", async () => {
  /*
   * A device can be sent somewhere else by whatever else controls it. A
   * position that only ever incremented would then arm the wrong track for the
   * rest of the evening, with nothing to notice the disagreement — so where
   * the room IS comes from what it is playing.
   */
  const r = await upnpRig({ port: 49185 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    const queue = r.queue();

    /* Somebody else jumps it to the fifth track. */
    const fifth = queue.trackAt(5);
    await r.household.get(WIIM).setAvTransportUri(
      "http://192.168.1.9:3400/stream/" + require("../lib/ids").encodeId(fifth) + ".wav");
    await r.playback.poll();
    await r.playback.settle();

    assert.strictEqual(r.queue().at(), 5, "the queue went where the room went");
    assert.ok(r.device.state.nextUri, "and armed the sixth, not the second");
  } finally { await r.cleanup(); }
});

test("the queue screen's divider follows the room, not the device's idea of it", async () => {
  /*
   * /api/queue says which item is playing so the screen can mark it and count
   * what is left. For a Sonos that is the speaker's own position. For a
   * renderer it is 1 for ever — so the divider would sit at the top of the
   * list and the summary would keep saying the whole record was still to come,
   * however far through it the room actually was.
   */
  const r = await upnpRig({ port: 49188 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    assert.strictEqual((await r.playback.queue(WIIM)).index, 1);

    r.device.advance();
    await r.playback.poll();
    await r.playback.settle();

    const q = await r.playback.queue(WIIM);
    assert.strictEqual(q.index, 2, "the screen follows the room to the second track");
    assert.strictEqual(q.total, 6, "and still knows how long the record is");
    assert.strictEqual(r.device.state.track, 1, "while the device still says 1");
  } finally { await r.cleanup(); }
});

test("the radio tops up a queue the server holds, and knows where the room is", async () => {
  /*
   * THE SILENT FAILURE THIS RELEASE WAS MOST LIKELY TO SHIP.
   *
   * topUp() asked the DEVICE where in the queue it was, which is the right
   * question for a Sonos and meaningless for a renderer: one playing a single
   * URI reports Track as 1 for ever, because it has no queue to have a
   * position in.
   *
   * TWO ALBUMS ARE WHAT MAKE THAT VISIBLE, and the first version of this test
   * used one — which passes either way, because with everything after the
   * first track belonging to the album playing, "is this the last album?" is
   * true whether the position is right or not. With a SECOND album queued,
   * a position stuck at 1 leaves that album sitting in "still to come" for
   * ever: the radio never thinks the queue is running out, never adds
   * anything, and the music stops at the end of the record with the switch
   * still saying it is on.
   */
  const { createRadio } = require("../lib/radio");
  const r = await upnpRig({ port: 49187 });
  try {
    const settings = settingsLib.open(r.db);
    const radio = createRadio({ db: r.db, settings });
    radio.setEnabled(WIIM, true);
    radio.setMatchGenre(WIIM, false);
    r.playback.radio = radio;

    /* Four tracks, then three: the room has to reach the END of the second. */
    await r.playback.playAlbum(WIIM, r.albumId("Laughing Stock"));
    await r.playback.enqueue(WIIM,
      require("../lib/library").tracksForAlbum(r.db, r.albumId("Hex")),
      { replace: false, autoplay: false });
    assert.strictEqual(await r.queue().length(), 7);

    /* Walk it to the last track, the way the device actually does. */
    for (let i = 0; i < 6; i++) {
      r.device.advance();
      await r.playback.poll();
      await r.playback.settle();
    }
    assert.strictEqual(r.queue().position(), 7, "the room is on the last track");
    assert.strictEqual(r.device.state.track, 1,
      "while the device still says 1, as one with no queue does");

    const after = await r.queue().length();
    assert.ok(after > 7, "a third album went on behind it: " + after);
  } finally { await r.cleanup(); }
});

test("next and previous move a room whose queue the server holds", async () => {
  /*
   * THE BUG 0.4.47 SHIPPED. Both buttons sent AVTransport's own Next and
   * Previous, which move through the queue the DEVICE holds — and a stock
   * renderer holds none. It is playing one URI with nothing to move to, so the
   * buttons did nothing at all while play and pause worked perfectly, which is
   * exactly how it was reported.
   *
   * Driven against the device, because "did the room actually move" is the
   * only thing that settles it.
   */
  const r = await upnpRig({ port: 49189 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    const first = r.device.state.currentUri;
    assert.strictEqual(r.queue().at(), 1);

    await r.playback.command(WIIM, "next");
    assert.strictEqual(r.queue().at(), 2, "the room moved on");
    assert.notStrictEqual(r.device.state.currentUri, first,
      "and the device is playing something else");
    assert.strictEqual(r.device.state.transportState, "PLAYING");
    /* And the track after THAT is armed, so pressing next does not cost the
       record its gaplessness from there on. */
    assert.ok(r.device.state.nextUri, "the following track was armed");

    await r.playback.command(WIIM, "next");
    assert.strictEqual(r.queue().at(), 3);

    await r.playback.command(WIIM, "previous");
    assert.strictEqual(r.queue().at(), 2, "and back again");

    /* NOTHING was sent to the device's own Next or Previous: it has no queue
       to move through, and asking it to would be the bug. */
    assert.ok(!r.device.actions().includes("Next"));
    assert.ok(!r.device.actions().includes("Previous"));
  } finally { await r.cleanup(); }
});

test("the end of the queue is said in words", async () => {
  /*
   * "Nothing is queued at position 3" is true and unhelpful. Somebody pressing
   * next on the last track has done nothing wrong and should be told what
   * happened, not shown the inside of a lookup — and the room is left playing
   * rather than stopped.
   *
   * There is no matching refusal at the TOP of the queue: back has somewhere
   * to go there, which is the start of the track. See below.
   */
  const r = await upnpRig({ port: 49190 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Field Recordings"));   // two tracks
    await r.playback.command(WIIM, "next");
    assert.strictEqual(r.queue().at(), 2);
    await assert.rejects(() => r.playback.command(WIIM, "next"),
      /last track in the queue/);
    assert.strictEqual(r.queue().at(), 2);
    assert.strictEqual(r.device.state.transportState, "PLAYING");
  } finally { await r.cleanup(); }
});

test("a device still opening a URI is not read as the room being on the one before", async () => {
  /*
   * REPORTED AGAINST A WiiM: press skip and the screen keeps painting the
   * PREVIOUS track, still advancing, for a second or two — so a skip near the
   * end of a record shows that track's waveform fully played before the new one
   * appears. A renderer handed a URI carries on describing the track before it
   * while it opens the stream; Sonos has no such window, because its own Next
   * moves the queue inside the speaker before it answers.
   */
  const r = await upnpRig({ port: 49194 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    const first = r.device.state.currentUri;
    r.device.state.relTime = "0:04:00";        // well into it, which is when people skip
    r.device.state.settleMs = 4000;

    await r.playback.command(WIIM, "next");
    /* The fixture is honest about the window: asked where it is, the device
       still names the track it was playing before the press. */
    const said = await r.household.get(WIIM).positionInfo();
    assert.strictEqual(said.uri, first);
    assert.strictEqual(said.relTime, "0:04:00");

    const now = await r.playback.nowPlaying(WIIM);
    assert.notStrictEqual(now.track.id, r.queue().trackAt(1),
      "but the room is reported on the track it was told to play");
    assert.strictEqual(now.position, 0, "at the top of it, not four minutes in");
    assert.strictEqual(now.duration, now.track.duration,
      "and its own length, not the length of the track that just ended");
  } finally { await r.cleanup(); }
});

test("a restart is not settled until the device is back at the top", async () => {
  /*
   * The same report wearing different clothes. Back near the end of a track
   * restarts it WITHOUT changing the URI, so asking "is the device on the URI
   * we sent" says yes on the first poll and hands back the position from before
   * the press — the bar sits at 98% for a moment instead of going to zero.
   */
  const r = await upnpRig({ port: 49195 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    r.device.state.relTime = "0:03:30";
    r.device.state.settleMs = 4000;

    await r.playback.command(WIIM, "previous");     // well in: restarts this track
    const now = await r.playback.nowPlaying(WIIM);

    assert.strictEqual(r.queue().at(), 1, "the same track");
    assert.strictEqual(now.position, 0, "and it is at the top of it");
  } finally { await r.cleanup(); }
});

test("a device sent somewhere else by its own app is believed at once", async () => {
  /*
   * The window must not become an argument. It exists for a device that has not
   * caught up — one reporting a track that is neither what it was told nor what
   * it was leaving has genuinely gone somewhere, and the room follows it.
   */
  const r = await upnpRig({ port: 49196 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    const queue = r.queue();
    const fifth = queue.trackAt(5);

    /* Straight at the device, inside the settling window of the play above. */
    await r.household.get(WIIM).setAvTransportUri(
      "http://192.168.1.9:3400/stream/" + require("../lib/ids").encodeId(fifth) + ".wav");
    const now = await r.playback.nowPlaying(WIIM);
    assert.strictEqual(now.track.id, fifth, "the room follows what is playing");
  } finally { await r.cleanup(); }
});

test("what a device was last handed outlives the object that recorded it", async () => {
  /*
   * queueFor() builds a queue per call, so a fact about a window of SECONDS
   * would be forgotten the moment it was written down. The Map lives on
   * Playback for that reason, and this is the assertion that says so: the
   * queue asked is not the queue that did the sending.
   */
  const r = await upnpRig({ port: 49197 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    r.device.state.relTime = "0:04:00";
    r.device.state.settleMs = 4000;
    await r.playback.command(WIIM, "next");

    const fresh = r.queue();                       // a brand new ServerQueue
    assert.ok(fresh.sent, "it can still see what the device was handed");
    assert.strictEqual(fresh.playing({ uri: r.device.state.currentUri, relTime: "0:04:00" }).seconds, 0);
  } finally { await r.cleanup(); }
});

test("back on the first track starts it again rather than refusing", async () => {
  /*
   * REPORTED AGAINST A WiiM: eighteen seconds into the first track of a record,
   * deciding to hear it from the beginning, and getting "That is the first
   * track in the queue." 0.4.49 read back as the mirror of next and refused at
   * the top of the list — the one press the button was there for.
   */
  const r = await upnpRig({ port: 49191 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    r.device.state.relTime = "0:00:18";
    const uri = r.device.state.currentUri;

    await r.playback.command(WIIM, "previous");

    assert.strictEqual(r.queue().at(), 1, "still on the first track");
    assert.strictEqual(r.device.state.currentUri, uri, "and it is the same track");
    assert.strictEqual(r.device.state.relTime, "0:00:00", "played from the top");
    assert.strictEqual(r.device.state.transportState, "PLAYING");
  } finally { await r.cleanup(); }
});

test("back is start-this-again once you are into a track, and only then the one before", async () => {
  /*
   * The convention every back button follows, and the reason a SECOND press
   * does go back: a restart puts the track at zero, so the press after it
   * lands inside JUST_STARTED_SECONDS.
   */
  const r = await upnpRig({ port: 49192 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    await r.playback.command(WIIM, "next");
    assert.strictEqual(r.queue().at(), 2);
    const second = r.device.state.currentUri;

    /* Well into it: back means this one, from the top. */
    r.device.state.relTime = "0:01:12";
    await r.playback.command(WIIM, "previous");
    assert.strictEqual(r.queue().at(), 2, "the same track");
    assert.strictEqual(r.device.state.currentUri, second);

    /* The device now reports the top of the track, as a real one does after
       being pointed at a URI — so the next press is inside the window. */
    assert.strictEqual(r.device.state.relTime, "0:00:00");
    await r.playback.command(WIIM, "previous");
    assert.strictEqual(r.queue().at(), 1, "and now it goes back");
    assert.notStrictEqual(r.device.state.currentUri, second);
  } finally { await r.cleanup(); }
});

test("a device that will not say where it is has its track restarted", async () => {
  /*
   * The safe side of the trade, and it is not symmetric: restarting a track you
   * meant to leave costs one more press, while leaving a track you meant to
   * restart loses your place in it.
   */
  const r = await upnpRig({ port: 49193 });
  try {
    await r.playback.playAlbum(WIIM, r.albumId("Spirit of Eden"));
    await r.playback.command(WIIM, "next");
    const second = r.device.state.currentUri;
    r.device.state.faults.set("GetPositionInfo", 501);

    await r.playback.command(WIIM, "previous");
    assert.strictEqual(r.queue().at(), 2, "it stayed where it was");
    assert.strictEqual(r.device.state.currentUri, second);
    assert.strictEqual(r.device.state.transportState, "PLAYING",
      "and a refused position did not become a refused button");
  } finally { await r.cleanup(); }
});

test("a Sonos still moves through its own queue", async () => {
  /*
   * The other half. A speaker that holds its queue knows where it is, and its
   * Previous already does the "restart this track if you are well into it"
   * thing people expect from the button — reimplementing either would be worse
   * than both.
   */
  const fake = createFakeSonos({ port: 11420 });
  await fake.listen();
  try {
    const player = new Player({ ip: "127.0.0.1", uuid: "RINCON_X", name: "Kitchen", port: 11420 });
    const queue = new SonosQueue(player);
    await queue.next();
    await queue.previous();
    assert.deepStrictEqual(fake.actions(), ["Next", "Previous"],
      "sent straight to the speaker, which is the thing that holds the list");
  } finally {
    await fake.close();
  }
});
