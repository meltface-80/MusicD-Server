/*
 * lib/zones.js — the rooms, whoever they belong to.
 *
 * Two households answer to this server now, and everything above it asks about
 * ROOMS. What is worth testing is the routing and the one policy decision:
 * a discovered device is LISTED, not switched on.
 *
 * The last test here is the important one. It boots the real index.js against
 * a fake speaker and a fake renderer and drives /api/zones and /api/zone the
 * way a phone does — because the bug this project shipped in 0.4.43 was a
 * wiring bug that every unit test in the tree walked straight past.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dbLib = require("../lib/db");
const settingsLib = require("../lib/settings");
const sonosLib = require("../lib/sonos");
const dlna = require("../lib/dlna");
const { Zones } = require("../lib/zones");
const { createFakeSonos } = require("./fake-sonos");
const { createFakeRenderer } = require("./fake-dlna");

const KITCHEN = "RINCON_AAA01400";
const WIIM = "uuid:11111111-2222-3333-4444-555555555555";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-zones-"));
  return {
    settings: settingsLib.open(dbLib.open(path.join(root, "data"))),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

/* A household and a renderer list, both already populated — the routing is
   what is under test, not the discovery that filled them. */
async function rig({ sonosPort, rendererPort }) {
  const ws = workspace();
  const fakeSonos = createFakeSonos({
    port: sonosPort, host: "127.0.0.1",
    zones: [{ uuid: KITCHEN, name: "Kitchen", coordinator: KITCHEN }]
  });
  await fakeSonos.listen();
  const fakeRenderer = createFakeRenderer({ port: rendererPort, name: "WiiM Pro Plus" });
  await fakeRenderer.listen();

  const sonos = new sonosLib.Household({ hosts: ["127.0.0.1"], port: sonosPort });
  await sonos.refresh({ force: true });

  const renderers = new dlna.Renderers({ seeds: [fakeRenderer.location] });
  renderers.search = async () => [];
  await renderers.refresh({ force: true });

  return {
    zones: new Zones({ sonos, renderers, settings: ws.settings }),
    settings: ws.settings, fakeSonos, fakeRenderer,
    cleanup: async () => {
      await fakeSonos.close();
      await fakeRenderer.close();
      ws.cleanup();
    }
  };
}

test("a discovered device is listed but not a room until somebody says so", async () => {
  /*
   * THE ONE POLICY DECISION IN THE FILE, and deliberately the opposite default
   * from ROWS_OFF_KEY in lib/settings.js: a home row added by an update should
   * appear, and a device that turned up on the network should not silently
   * join the speakers. An SSDP search answers for every renderer there is —
   * the television included, which is what settled this.
   */
  const r = await rig({ sonosPort: 11410, rendererPort: 49170 });
  try {
    /* Settings › Zones sees everything, because a device you cannot see is a
       device you cannot switch on. */
    assert.deepStrictEqual(r.zones.all().map(z => `${z.name}:${z.enabled}`),
      ["Kitchen:true", "WiiM Pro Plus:false"]);

    /* The room picker, the poll loop and the play endpoints see only rooms. */
    assert.deepStrictEqual(r.zones.rooms().map(z => z.name), ["Kitchen"]);
    /* And it cannot be reached by id either — off is off from every direction,
       not merely absent from one list. */
    assert.strictEqual(r.zones.get(WIIM), null);
    assert.strictEqual(r.zones.coordinatorFor(WIIM), null);

    r.zones.setEnabled(WIIM, true);
    assert.deepStrictEqual(r.zones.rooms().map(z => z.name), ["Kitchen", "WiiM Pro Plus"]);
    assert.ok(r.zones.get(WIIM), "and now it can be talked to");
  } finally { await r.cleanup(); }
});

test("a Sonos room has no switch, and asking for one is refused", async () => {
  /*
   * It was a room before this setting existed, and one that could be switched
   * off would be a feature broken by an upgrade. Refused rather than quietly
   * accepted, so a stored "0" for a Sonos uuid is never written — and never
   * read by a later version that has forgotten why.
   */
  const r = await rig({ sonosPort: 11411, rendererPort: 49171 });
  try {
    const kitchen = r.zones.all().find(z => z.uuid === KITCHEN);
    assert.strictEqual(kitchen.enabled, true);
    assert.strictEqual(kitchen.switchable, false);
    assert.throws(() => r.zones.setEnabled(KITCHEN, false), /always available/);
    assert.strictEqual(r.settings.get("zone.enabled." + KITCHEN), null, "nothing was stored");

    /* And a device that is not there at all is refused rather than remembered:
       a key for a room that does not exist is a setting nothing reads again. */
    assert.throws(() => r.zones.setEnabled("uuid:not-here", true), /No such device/);
  } finally { await r.cleanup(); }
});

test("which household owns an id is asked, never inferred from its shape", async () => {
  /*
   * A RINCON_ and a uuid: do not collide today. The code does not lean on
   * that: the day a device ships an id in the other's shape, a rule that
   * guessed would send its commands to the wrong household, and this cannot.
   */
  const r = await rig({ sonosPort: 11412, rendererPort: 49172 });
  try {
    r.zones.setEnabled(WIIM, true);

    const kitchen = r.zones.get(KITCHEN);
    const wiim = r.zones.get(WIIM);
    assert.strictEqual(kitchen.holdsQueue, true, "a Sonos holds its own queue");
    assert.strictEqual(wiim.holdsQueue, false, "and a stock renderer has none");

    /* Grouping is a Sonos idea; the other reports itself alone and in charge. */
    assert.deepStrictEqual(r.zones.membersOf(WIIM).map(m => m.name), ["WiiM Pro Plus"]);
    assert.strictEqual(r.zones.all().find(z => z.uuid === WIIM).grouped, false);
    assert.strictEqual(r.zones.all().find(z => z.uuid === WIIM).isCoordinator, true);

    /* And an id belonging to neither is nobody's. */
    assert.strictEqual(r.zones.ownerOf("uuid:nothing"), null);
  } finally { await r.cleanup(); }
});

test("a renderer that cannot be reached does not cost the Sonos rooms", async () => {
  /*
   * Awaited in sequence, a discovery sweep that hangs would hold up the room
   * list — the first time a television stopped answering, every Sonos room
   * would go with it. They run together and neither is allowed to fail the
   * other.
   */
  const r = await rig({ sonosPort: 11413, rendererPort: 49173 });
  try {
    r.zones.renderers.refresh = async () => { throw new Error("network is on fire"); };
    const rooms = await r.zones.refresh({ force: true });
    assert.deepStrictEqual(rooms.map(z => z.name), ["Kitchen"],
      "the speakers are still listed");
    assert.strictEqual(r.zones.lastError, "", "and nothing is blamed on them");
  } finally { await r.cleanup(); }
});

/* ---------------------------------------------------------------- */
/*  Through the real server                                          */
/* ---------------------------------------------------------------- */

test("a discovered renderer reaches the app, off, and can be switched on", async () => {
  /*
   * THE WIRING, END TO END, because that is the class of bug this project
   * actually ships. 0.4.43 broke Sonos discovery outright and 544 unit tests
   * stayed green, because the wiring between a module and its caller was the
   * one thing nothing drove.
   *
   * So: the real index.js, a real fake speaker, a real fake renderer, and the
   * two endpoints a phone actually calls.
   */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-zones-api-"));
  const music = path.join(root, "music");
  require("./fixtures").buildLibrary(music);

  const fakeSonos = createFakeSonos({
    port: 1400, host: "127.0.0.1",
    zones: [{ uuid: KITCHEN, name: "Kitchen", coordinator: KITCHEN }]
  });
  await fakeSonos.listen();
  const fakeRenderer = createFakeRenderer({ port: 49174, name: "WiiM Pro Plus" });
  await fakeRenderer.listen();

  const PORT = 3400 + Math.floor(Math.random() * 300);
  const server = require("child_process").spawn(
    process.execPath, [path.join(__dirname, "..", "index.js")], {
      env: {
        ...process.env, PORT: String(PORT), DATA_DIR: path.join(root, "data"),
        MUSIC_DIRS: music, SONOS_HOSTS: "127.0.0.1", SERVER_IP: "127.0.0.1",
        UPNP_DEVICES: fakeRenderer.location,
        COVER_LOOKUP: "false", INFO_LOOKUP: "false", WAVEFORM: "false"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
  /* Both streams kept: when this fails it is a WIRING failure, and the
     server's own startup line ("upnp : … (off)") is the fastest thing that
     says whether discovery ran at all. */
  let log = "";
  server.stdout.on("data", d => { log += d; });
  server.stderr.on("data", d => { log += d; });

  const base = `http://127.0.0.1:${PORT}`;
  let passed = false;
  try {
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(base + "/api/status")).ok) break; } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 200));
    }

    const listed = await (await fetch(base + "/api/zones?refresh=1")).json();
    const names = listed.rooms.map(r => r.name);
    assert.ok(names.includes("Kitchen"), "the speaker is a room: " + names.join(", "));
    const wiim = listed.rooms.find(r => r.name === "WiiM Pro Plus");
    assert.ok(wiim, "the renderer was discovered and listed: " + names.join(", "));
    assert.strictEqual(wiim.enabled, false, "off, until somebody says otherwise");
    assert.strictEqual(wiim.switchable, true);
    assert.strictEqual(wiim.can.SetNextAVTransportURI, true,
      "and what it can do came with it, read from the device");

    /* Switch it on the way the room screen does. */
    const on = await (await fetch(base + "/api/zone", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zone: wiim.uuid, enabled: true })
    })).json();
    assert.strictEqual(on.enabled, true, JSON.stringify(on));

    /* It is a room now — the volume control reaches the device. */
    const vol = await (await fetch(base + "/api/volume", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zone: wiim.uuid, level: 42 })
    })).json();
    assert.strictEqual(vol.volume, 42, JSON.stringify(vol));
    assert.strictEqual(fakeRenderer.state.volume, 42, "the device actually heard it");

    /*
     * AND IT PLAYS — the 0.4.47 change. Until then this asked for something
     * the room could not do and was refused in words; now the server holds a
     * queue for it, so the album goes on and the device is pointed at the
     * first track.
     */
    const albums = await (await fetch(base + "/api/albums?row=library&limit=1")).json();
    const played = await fetch(base + "/api/play", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zone: wiim.uuid, albumId: albums.albums[0].id, mode: "play" })
    });
    const result = await played.json();
    assert.strictEqual(played.status, 200, JSON.stringify(result));
    assert.ok(result.queued > 1, "a whole album went on: " + JSON.stringify(result));
    assert.match(fakeRenderer.state.currentUri, /\/stream\//,
      "the device was pointed at the first track");
    assert.strictEqual(fakeRenderer.state.transportState, "PLAYING");

    /* AND THE ONE AFTER IT WAS ARMED, which is the whole of gapless: the
       device pre-buffers it and crosses over without stopping. Armed now,
       while the first track is only just starting. */
    assert.match(fakeRenderer.state.nextUri, /\/stream\//,
      "the next track was handed over before this one ends");
    assert.notStrictEqual(fakeRenderer.state.nextUri, fakeRenderer.state.currentUri);

    /* The queue screen reads it back. */
    const queue = await (await fetch(
      base + "/api/queue?zone=" + encodeURIComponent(wiim.uuid))).json();
    assert.strictEqual(queue.total, result.queued, JSON.stringify(queue).slice(0, 200));

    /* A Sonos room is refused a switch by the endpoint too. */
    const nope = await fetch(base + "/api/zone", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zone: KITCHEN, enabled: false })
    });
    assert.strictEqual(nope.status, 400);
    assert.match((await nope.json()).error, /always available/);
    passed = true;
  } finally {
    server.kill();
    await fakeSonos.close();
    await fakeRenderer.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (!passed) console.error("[server said]\n" + log.trim());
  }
});
