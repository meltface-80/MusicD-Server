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

const { SonosQueue } = require("../lib/queue");
const { Player } = require("../lib/sonos");
const { createFakeSonos } = require("./fake-sonos");

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
  const required = ["list", "length", "add", "clear", "startAt", "jumpTo"];
  const proto = SonosQueue.prototype;
  for (const name of required) {
    assert.strictEqual(typeof proto[name], "function", `a queue must have ${name}()`);
  }

  const own = Object.getOwnPropertyNames(proto)
    .filter(n => n !== "constructor" && typeof proto[n] === "function");
  assert.deepStrictEqual(own.slice().sort(), required.slice().sort(),
    "SonosQueue has grown a method the interface does not name");
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

test("the transport stayed on the player, where both protocols have it", () => {
  /*
   * A queue is the list and where in it we are. Play, pause, seek-within-a-
   * track and volume are the same actions on any UPnP device, and pulling them
   * behind this line too would have made the seam a second copy of Player
   * rather than a boundary.
   */
  const src = codeOf("queue.js");
  for (const action of ["setVolume", "setMute", "\\.pause\\(", "\\.stop\\(",
                        "\\.next\\(", "\\.previous\\(", "\\.seek\\("]) {
    assert.ok(!new RegExp(action).test(src), `lib/queue.js drives ${action}`);
  }
  /* play() is the one exception and it is deliberate: starting at a position
     is not "begin playing" until something presses play. */
  assert.match(src, /startAt\([\s\S]{0,400}this\.player\.play\(\)/);
});
