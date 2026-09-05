/*
 * lib/upnp.js — the protocol, with nobody's dialect in it.
 *
 * These tests moved out of test/sonos.test.js when the module did. They kept
 * passing throughout, which is the point of a seam: the behaviour did not
 * change, only where it lives.
 *
 * The one new test is the boundary itself. A split that nothing asserts is a
 * split that drifts back together the first time somebody needs a constant
 * "just here" — which is precisely how all of this ended up in the Sonos file
 * to begin with.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const upnp = require("../lib/upnp");
const { createFakeSonos } = require("./fake-sonos");

const AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1";
const CONTROL_PATH = "/MediaRenderer/AVTransport/Control";

/* ---------------------------------------------------------------- */
/*  The boundary                                                     */
/* ---------------------------------------------------------------- */

/* The block comments are stripped before the check below, for the same reason
   test/frontend.test.js matches the TAG rather than the word when it guards
   the absent iOS metas: the prose EXPLAINING why something is not here names
   it, and a guard its own rationale trips is a guard that gets deleted. What
   is left is code, which is what the rule is actually about. */
function codeOf(file) {
  return fs.readFileSync(path.join(__dirname, "..", "lib", file), "utf8")
           .replace(/\/\*[\s\S]*?\*\//g, "");
}

test("lib/upnp.js has never heard of Sonos", () => {
  /*
   * THE TEST FOR WHETHER SOMETHING BELONGS THERE is whether a device that has
   * never heard of Sonos would still need it. Left unasserted, the file drifts
   * back into being lib/sonos.js under another name — one Sonos-only constant
   * at a time, each of them individually reasonable.
   */
  const src = codeOf("upnp.js");
  for (const word of ["Sonos", "RINCON", "ZonePlayer", "ZoneGroup", "x-rincon", "1400"]) {
    assert.ok(!src.includes(word), `lib/upnp.js mentions ${word} in code`);
  }
  /* And it reaches for nothing of ours but itself. */
  assert.ok(!/require\(["'][.]/.test(src), "lib/upnp.js requires no other module here");
});

test("a control path is asked for rather than looked up", () => {
  /*
   * The whole reason soap() could be shared. Sonos publishes a fixed table of
   * control URLs; a stock renderer names its own in its device description and
   * no two makes agree — so a table in here would be one manufacturer's paths
   * pretending to be the protocol.
   */
  const src = codeOf("upnp.js");
  assert.match(src, /controlPath/, "the caller supplies it");
  assert.ok(!/CONTROL_PATHS/.test(src), "and there is no table of them here");

  /* And the Sonos side is what fills it in, which is where that table belongs. */
  assert.match(codeOf("sonos.js"), /controlPath: CONTROL_PATHS\[service\]/);
});

/* ---------------------------------------------------------------- */
/*  SOAP                                                             */
/* ---------------------------------------------------------------- */

test("a UPnP fault surfaces its error code, not the HTTP status", async () => {
  const fake = createFakeSonos({ port: 11402 });
  fake.state.faults.set("Play", "701");
  await fake.listen();
  try {
    await assert.rejects(
      () => upnp.soap("127.0.0.1", AV_TRANSPORT, "Play", { Speed: 1 },
                      { port: 11402, controlPath: CONTROL_PATH }),
      (e) => {
        assert.ok(e instanceof upnp.UPnPError);
        assert.strictEqual(e.code, "701", "the code the player actually gave");
        assert.match(e.message, /UPnP 701/);
        /* A refusal IS an answer, and repeating it just gets the same answer
           twice — the flag callers decide a retry with. */
        assert.strictEqual(e.answered, true);
        return true;
      });
  } finally {
    await fake.close();
  }
});

test("an unreachable player fails with a message naming it", async () => {
  await assert.rejects(
    () => upnp.soap("127.0.0.1", AV_TRANSPORT, "Play", { Speed: 1 },
                    { port: 11497, controlPath: CONTROL_PATH }),
    (e) => {
      assert.ok(e instanceof upnp.UPnPError);
      assert.match(e.message, /Play to 127\.0\.0\.1 failed/);
      /* Nothing answered, so this one IS worth asking again. */
      assert.strictEqual(e.answered, false);
      return true;
    });
});

/* ---------------------------------------------------------------- */
/*  This server's own address                                        */
/* ---------------------------------------------------------------- */

test("the advertised address is one a speaker could actually reach", () => {
  assert.strictEqual(upnp.localAddress("192.168.1.9"), "192.168.1.9", "an override wins");
  const auto = upnp.localAddress();
  assert.match(auto, /^\d+\.\d+\.\d+\.\d+$/);
  assert.ok(!auto.startsWith("127."), "loopback is unreachable from a speaker");
});

/* ---------------------------------------------------------------- */
/*  Times                                                            */
/* ---------------------------------------------------------------- */

test("times convert both ways", () => {
  assert.strictEqual(upnp.hmsToSeconds("0:03:45"), 225);
  assert.strictEqual(upnp.hmsToSeconds("1:00:00"), 3600);
  assert.strictEqual(upnp.hmsToSeconds("NOT_IMPLEMENTED"), 0);
  assert.strictEqual(upnp.secondsToHms(225), "0:03:45");
  assert.strictEqual(upnp.secondsToHms(0), "0:00:00");
});

/* ---------------------------------------------------------------- */
/*  Play modes                                                       */
/* ---------------------------------------------------------------- */

test("every play mode round-trips through the two switches it means", () => {
  for (const mode of Object.keys(upnp.PLAY_MODES)) {
    const flags = upnp.parsePlayMode(mode);
    assert.strictEqual(upnp.playModeFor(flags), mode, mode);
  }
});

test("shuffle and repeat are independent, which the single enum hides", () => {
  /* The naming does not follow: plain "SHUFFLE" means shuffle AND repeat-all,
     while shuffle on its own is "SHUFFLE_NOREPEAT". Toggling one switch must
     not clear the other. */
  assert.strictEqual(upnp.playModeFor({ shuffle: true, repeat: "off" }), "SHUFFLE_NOREPEAT");
  assert.strictEqual(upnp.playModeFor({ shuffle: true, repeat: "all" }), "SHUFFLE");
  assert.strictEqual(upnp.playModeFor({ shuffle: true, repeat: "one" }), "SHUFFLE_REPEAT_ONE");
  assert.strictEqual(upnp.playModeFor({ shuffle: false, repeat: "all" }), "REPEAT_ALL");

  /* Turning shuffle on while repeat-all is set keeps repeat-all. */
  const current = upnp.parsePlayMode("REPEAT_ALL");
  assert.strictEqual(upnp.playModeFor({ ...current, shuffle: true }), "SHUFFLE");
});

test("a play mode the player invents is read as plain playback", () => {
  assert.deepStrictEqual(upnp.parsePlayMode("SOMETHING_NEW"), { shuffle: false, repeat: "off" });
  assert.deepStrictEqual(upnp.parsePlayMode(""), { shuffle: false, repeat: "off" });
  assert.deepStrictEqual(upnp.parsePlayMode(null), { shuffle: false, repeat: "off" });
});
