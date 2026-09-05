/*
 * lib/dlna.js — finding and describing stock UPnP renderers.
 *
 * Driven against test/fake-dlna.js, which refuses the way a real one does:
 * relative control URLs under a path nothing would guess, an action list that
 * can be built with or without the optional actions, and a UPnP fault for
 * anything it does not implement.
 *
 * THE THING THESE TESTS EXIST TO CATCH is a caller that assumes. Sonos
 * publishes a fixed table of control URLs and every player uses it; nothing
 * else does. Half of AVTransport is optional. A device that answers a
 * MediaRenderer search may be a Sonos that is already a room by another route.
 * Every one of those is a wrong assumption that works on one device and fails
 * silently on the next.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const dlna = require("../lib/dlna");
const { createFakeRenderer } = require("./fake-dlna");

/* ---------------------------------------------------------------- */
/*  Reading what a device says it is                                 */
/* ---------------------------------------------------------------- */

test("a service type is matched by name, not by containment", () => {
  /*
   * "RenderingControl" sits inside "GroupRenderingControl", a Sonos service
   * whose actions are GetGroupVolume and friends. A containment test picks the
   * wrong one and reports a speaker as having no volume control at all — which
   * is exactly what the probe written to plan this feature did, on its first
   * run, against four real speakers. A substring is not an identity.
   */
  assert.strictEqual(
    dlna.serviceName("urn:schemas-upnp-org:service:RenderingControl:1"), "RenderingControl");
  assert.strictEqual(
    dlna.serviceName("urn:schemas-sonos-com:service:GroupRenderingControl:1"),
    "GroupRenderingControl");
  assert.strictEqual(dlna.serviceName("nonsense"), "");
  assert.strictEqual(dlna.serviceName(""), "");
  assert.strictEqual(dlna.serviceName(null), "");
});

test("control URLs come from the description, never from a guess", async () => {
  /*
   * The fake serves them RELATIVE, under /ctl/, and 404s anything else — which
   * is what a real renderer does with a path borrowed from another make. A
   * caller that guessed would find nothing here, and nothing on most of the
   * devices this feature exists for.
   */
  const fake = createFakeRenderer({ port: 49160 });
  await fake.listen();
  try {
    const device = await dlna.describe(fake.location);
    assert.ok(device, "the description was readable");
    assert.strictEqual(device.control.AVTransport, "/ctl/avt");
    assert.strictEqual(device.control.RenderingControl, "/ctl/rc");
    assert.strictEqual(device.port, 49160, "and the port comes off the description's own URL");

    /* And driving it actually reaches them. */
    const renderer = new dlna.Renderer(device);
    await renderer.play();
    assert.deepStrictEqual(fake.actions(), ["Play"]);
    assert.strictEqual(fake.state.calls[0].path, "/ctl/avt");
  } finally {
    await fake.close();
  }
});

test("what a device can do is read, not assumed", async () => {
  /*
   * SetNextAVTransportURI is OPTIONAL in AVTransport:1 and it is the whole of
   * whether gapless is possible — without it the next track can only be handed
   * over once this one has stopped. Seek is optional too. Offering either for a
   * device that has neither is worse than not offering it, because nobody
   * reports it: the music just gaps, or the bar just will not drag.
   */
  const gapless = createFakeRenderer({ port: 49161, gapless: true, seekable: true });
  const plain = createFakeRenderer({ port: 49162, gapless: false, seekable: false });
  await gapless.listen();
  await plain.listen();
  try {
    const withIt = await dlna.describe(gapless.location);
    const without = await dlna.describe(plain.location);

    assert.strictEqual(withIt.can.SetNextAVTransportURI, true);
    assert.strictEqual(withIt.can.Seek, true);
    assert.strictEqual(without.can.SetNextAVTransportURI, false,
      "a device that does not implement it must not be reported as able to");
    assert.strictEqual(without.can.Seek, false);

    /* The ones every renderer has are read the same way rather than presumed. */
    for (const device of [withIt, without]) {
      assert.strictEqual(device.can.SetAVTransportURI, true);
      assert.strictEqual(device.can.GetPositionInfo, true);
    }
  } finally {
    await gapless.close();
    await plain.close();
  }
});

test("a device that refuses an action it never advertised says so", async () => {
  /*
   * The fake faults with UPnP 401 for anything outside its action list, as a
   * real player does. A caller reaching for the optional half has to get an
   * error it can act on rather than a silent nothing.
   */
  const fake = createFakeRenderer({ port: 49163, gapless: false });
  await fake.listen();
  try {
    const renderer = new dlna.Renderer(await dlna.describe(fake.location));
    await assert.rejects(
      () => renderer.setNextAvTransportUri("http://example/next.flac"),
      (e) => {
        assert.strictEqual(e.code, "401", "Invalid Action, which is an ANSWER");
        assert.strictEqual(e.answered, true, "so it is never worth asking twice");
        return true;
      });
  } finally {
    await fake.close();
  }
});

test("a device with no RenderingControl is refused a volume, not sent one", async () => {
  /*
   * Some renderers genuinely publish no RenderingControl. Asking anyway would
   * be a request to a control URL that does not exist — so this fails as an
   * ANSWER (the device told us, in its description) rather than as a silence
   * something would retry.
   */
  const fake = createFakeRenderer({ port: 49164, noRendering: true });
  await fake.listen();
  try {
    const device = await dlna.describe(fake.location);
    assert.strictEqual(device.control.RenderingControl, "", "it has none");
    const renderer = new dlna.Renderer(device);
    await assert.rejects(() => renderer.volume(), /has no RenderingControl/);
    assert.deepStrictEqual(fake.actions(), [], "and nothing was sent");
  } finally {
    await fake.close();
  }
});

test("a device with no play mode reports NORMAL rather than taking a screen down", async () => {
  /*
   * FOUND IN A BROWSER, NOT IN A TEST. Now playing reads the play mode on
   * every poll, and a Renderer without transportSettings() made /api/now a 500
   * every five seconds for a UPnP room — the screen simply never loaded.
   * Nothing in the suite touched it, because nothing in the suite had opened
   * Now playing on a room that was not a Sonos.
   *
   * GetTransportSettings is in AVTransport:1 and plenty of renderers implement
   * it anyway; there is nothing to shuffle when the controller holds the queue.
   * A refusal is one absent field, not a broken screen.
   */
  const fake = createFakeRenderer({ port: 49175 });
  await fake.listen();
  try {
    const renderer = new dlna.Renderer(await dlna.describe(fake.location));
    /* The fake does not implement it — it is not in BASE_ACTIONS — so this is
       the refusing path, driven rather than described. */
    assert.deepStrictEqual(await renderer.transportSettings(), { playMode: "NORMAL" });
    assert.deepStrictEqual(fake.actions(), ["GetTransportSettings"], "it did ask");
  } finally {
    await fake.close();
  }
});

test("a device that says nothing at all is not read as NORMAL", async () => {
  /*
   * The other half. A REFUSAL is an answer — "I have no such action" — and
   * NORMAL is the right reading of it. A SILENCE is a device that was busy or
   * has gone, and answering that with a default would paint a screen as though
   * it had replied.
   */
  const renderer = new dlna.Renderer({
    name: "Gone", ip: "127.0.0.1", port: 49198,
    control: { AVTransport: "/ctl/avt" },
    serviceType: { AVTransport: "urn:schemas-upnp-org:service:AVTransport:1" }
  });
  await assert.rejects(() => renderer.transportSettings(),
    (e) => e.answered === false);
});

test("something that is not a renderer is skipped rather than half-read", async () => {
  /* Discovery walks a list. One device that will not describe itself, or has
     no transport to drive, must cost the sweep nothing but itself. */
  assert.strictEqual(await dlna.describe("http://127.0.0.1:49199/description.xml"), null,
    "nothing answered at all");
});

/* ---------------------------------------------------------------- */
/*  Discovery                                                        */
/* ---------------------------------------------------------------- */

test("a Sonos answering the renderer search is not listed a second time", async () => {
  /*
   * ALL FOUR of them did, on the network this feature was planned against.
   * Left alone, every Sonos room appears twice — once as itself and once as a
   * stock renderer that cannot be grouped and has no queue.
   *
   * Told apart by CAPABILITY: it has queue actions and a stock renderer does
   * not. Not by the manufacturer string, because branding gets rebranded.
   */
  const sonosish = createFakeRenderer({
    port: 49165, name: "Kitchen", maker: "Sonos, Inc.",
    uuid: "uuid:RINCON_TEST01400",
    queueActions: ["AddURIToQueue", "AddMultipleURIsToQueue"]
  });
  const plain = createFakeRenderer({ port: 49166, name: "WiiM Pro Plus" });
  await sonosish.listen();
  await plain.listen();
  try {
    assert.strictEqual((await dlna.describe(sonosish.location)).isSonos, true);
    assert.strictEqual((await dlna.describe(plain.location)).isSonos, false);

    /* And the sweep drops it. The search is injected for the same reason
       lib/sonos.js's is: multicast cannot be driven from a test, and a path
       only reachable by multicast is a path nothing covers. */
    const renderers = new dlna.Renderers({ seeds: [sonosish.location, plain.location] });
    renderers.search = async () => [];
    const found = await renderers.refresh({ force: true });
    assert.deepStrictEqual(found.map(d => d.name), ["WiiM Pro Plus"],
      "the Sonos is already a room by another route");
  } finally {
    await sonosish.close();
    await plain.close();
  }
});

test("a room the Sonos household already claims is skipped too", async () => {
  /*
   * The belt to the capability check's braces. The window it covers is real:
   * the Sonos topology may not have been read yet when a sweep runs, and a
   * device is only known to be a Sonos once its action list has been fetched.
   */
  const fake = createFakeRenderer({ port: 49167, uuid: "uuid:already-a-room" });
  await fake.listen();
  try {
    const renderers = new dlna.Renderers({
      seeds: [fake.location],
      excludeUuids: (uuid) => uuid === "uuid:already-a-room"
    });
    renderers.search = async () => [];
    assert.deepStrictEqual(await renderers.refresh({ force: true }), []);
  } finally {
    await fake.close();
  }
});

test("one device on two interfaces is one room", async () => {
  /* A device answers a search once per interface it is reachable on, and every
     answer names the same UDN. Listing it twice would put the same speaker in
     the picker twice, with one of them liable to stop answering. */
  const fake = createFakeRenderer({ port: 49168 });
  await fake.listen();
  try {
    const renderers = new dlna.Renderers({ seeds: [fake.location, fake.location] });
    renderers.search = async () => [];
    const found = await renderers.refresh({ force: true });
    assert.strictEqual(found.length, 1);
  } finally {
    await fake.close();
  }
});

test("the sweep asks for MediaRenderers, and lib/dlna.js owns no address of its own", () => {
  /*
   * The 0.4.43 bug in miniature: the shared search takes a target, and a caller
   * that forgets one searches for nothing. Asserted here because this caller
   * was written after that bug and must not repeat it.
   */
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "dlna.js"), "utf8")
                .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(src, /ssdpSearch\(\{\s*st: MEDIA_RENDERER_ST/,
    "the search names what it is looking for");
  assert.deepStrictEqual(src.match(/\bssdpSearch\(\s*\)/g) || [], [],
    "and is never called bare");

  /* Nothing Sonos-shaped leaked in here either — this is the plain side. */
  for (const word of ["RINCON", "ZoneGroup", "x-rincon", "1400"]) {
    assert.ok(!src.includes(word), `lib/dlna.js mentions ${word} in code`);
  }
});
