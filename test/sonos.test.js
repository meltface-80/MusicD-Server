"use strict";

const test = require("node:test");
const assert = require("node:assert");

const sonos = require("../lib/sonos");
const didl = require("../lib/didl");
const { createFakeSonos } = require("./fake-sonos");

/* ---------------------------------------------------------------- */
/*  Topology                                                         */
/* ---------------------------------------------------------------- */

const TOPOLOGY = `<ZoneGroupState><ZoneGroups>
<ZoneGroup Coordinator="RINCON_A" ID="RINCON_A:11">
  <ZoneGroupMember UUID="RINCON_A" ZoneName="Kitchen"
    Location="http://192.168.1.50:1400/xml/device_description.xml"
    Invisible="0" IsZoneBridge="0" ChannelMapSet=""/>
  <ZoneGroupMember UUID="RINCON_B" ZoneName="Study"
    Location="http://192.168.1.51:1400/xml/device_description.xml"
    Invisible="0" IsZoneBridge="0" ChannelMapSet=""/>
</ZoneGroup>
<ZoneGroup Coordinator="RINCON_C" ID="RINCON_C:12">
  <ZoneGroupMember UUID="RINCON_C" ZoneName="Living Room &amp; Hall"
    Location="http://192.168.1.52:1400/xml/device_description.xml"
    Invisible="0" IsZoneBridge="0" ChannelMapSet="RINCON_C:LF,LF;RINCON_D:RF,RF"/>
  <ZoneGroupMember UUID="RINCON_SUB" ZoneName="Living Room"
    Location="http://192.168.1.53:1400/xml/device_description.xml"
    Invisible="1" IsZoneBridge="0" ChannelMapSet=""/>
</ZoneGroup>
<ZoneGroup Coordinator="RINCON_BR" ID="RINCON_BR:13">
  <ZoneGroupMember UUID="RINCON_BR" ZoneName="BOOST"
    Location="http://192.168.1.54:1400/xml/device_description.xml"
    Invisible="0" IsZoneBridge="1" ChannelMapSet=""/>
</ZoneGroup>
</ZoneGroups></ZoneGroupState>`;

test("the topology yields every member, with its address and its group", () => {
  const zones = sonos.parseZoneGroupState(TOPOLOGY);
  assert.strictEqual(zones.length, 5);

  const kitchen = zones.find(z => z.name === "Kitchen");
  assert.strictEqual(kitchen.ip, "192.168.1.50");
  assert.strictEqual(kitchen.coordinator, "RINCON_A");

  const study = zones.find(z => z.name === "Study");
  assert.strictEqual(study.coordinator, "RINCON_A", "a grouped room follows its coordinator");
});

test("room names are unescaped, not left as entities", () => {
  const zones = sonos.parseZoneGroupState(TOPOLOGY);
  assert.ok(zones.some(z => z.name === "Living Room & Hall"));
});

test("satellites and BRIDGE units are not rooms you can play to", async () => {
  const house = new sonos.Household();
  house.zones = sonos.parseZoneGroupState(TOPOLOGY);
  const names = house.rooms().map(r => r.name);
  assert.ok(!names.includes("BOOST"), "a BRIDGE is not a room");
  assert.strictEqual(names.filter(n => n === "Living Room").length, 0,
    "an invisible bonded player is not a room");
  assert.deepStrictEqual(names, ["Kitchen", "Living Room & Hall", "Study"]);
});

test("INCLUDE_ZONES and EXCLUDE_ZONES filter the room list", () => {
  const only = new sonos.Household({ include: ["kitchen"] });
  only.zones = sonos.parseZoneGroupState(TOPOLOGY);
  assert.deepStrictEqual(only.rooms().map(r => r.name), ["Kitchen"]);

  const without = new sonos.Household({ exclude: ["Study"] });
  without.zones = sonos.parseZoneGroupState(TOPOLOGY);
  assert.ok(!without.rooms().map(r => r.name).includes("Study"));
});

test("a transport command for a grouped room goes to its coordinator", () => {
  const house = new sonos.Household();
  house.zones = sonos.parseZoneGroupState(TOPOLOGY);
  assert.strictEqual(house.coordinatorFor("RINCON_B").name, "Kitchen",
    "Study is grouped under Kitchen, so Kitchen takes the command");
  assert.strictEqual(house.coordinatorFor("RINCON_A").name, "Kitchen");
  assert.strictEqual(house.membersOf("RINCON_B").length, 2);
});

test("a malformed topology yields no rooms rather than throwing", () => {
  assert.deepStrictEqual(sonos.parseZoneGroupState(""), []);
  assert.deepStrictEqual(sonos.parseZoneGroupState("<not-xml"), []);
  assert.deepStrictEqual(sonos.parseZoneGroupState("<ZoneGroupState/>"), []);
});



/* ---------------------------------------------------------------- */
/*  DIDL                                                             */
/* ---------------------------------------------------------------- */

const TRACK = {
  id: "t:Talk Talk/Spirit of Eden/01 The Rainbow.flac",
  album_id: "a:Talk Talk/Spirit of Eden",
  title: "The Rainbow", artist: "Talk Talk", no: 1, duration: 342.5, mime: "audio/flac"
};

test("metadata carries the sentinel Sonos requires for a third-party stream", () => {
  const xml = didl.trackItem(TRACK, { uri: "http://192.168.1.9:3400/stream/abc.flac" });
  assert.match(xml, /RINCON_AssociatedZPUDN/,
    "without this the player accepts the call and then refuses to play");
  assert.match(xml, /urn:schemas-rinconnetworks-com:metadata-1-0\//);
});

test("metadata carries a protocolInfo built from the file's own MIME type", () => {
  const xml = didl.trackItem(TRACK, { uri: "http://h/stream/a.flac" });
  assert.match(xml, /protocolInfo="http-get:\*:audio\/flac:\*"/);
});

test("durations are whole seconds in H:MM:SS — fractions upset some firmware", () => {
  const xml = didl.trackItem(TRACK, { uri: "http://h/a.flac" });
  assert.match(xml, /duration="0:05:43"/, "342.5s rounds to 343s");
  assert.ok(!/duration="[^"]*\./.test(xml), "no fractional seconds");
});

test("titles with XML characters are escaped, not injected", () => {
  const xml = didl.trackItem(
    { ...TRACK, title: 'Bob & "Weave" <live>', artist: "A & B" },
    { uri: "http://h/a.flac?x=1&y=2" });
  assert.match(xml, /Bob &amp; &quot;Weave&quot; &lt;live&gt;/);
  assert.match(xml, /x=1&amp;y=2/);
  assert.ok(!/<live>/.test(xml), "the title did not become markup");
});

test("album art is advertised only when there is any", () => {
  const withArt = didl.trackItem(TRACK, { uri: "http://h/a.flac", artUri: "http://h/art/x" });
  assert.match(withArt, /<upnp:albumArtURI>http:\/\/h\/art\/x<\/upnp:albumArtURI>/);
  const without = didl.trackItem(TRACK, { uri: "http://h/a.flac" });
  assert.ok(!/albumArtURI/.test(without));
});

/* ---------------------------------------------------------------- */
/*  Talking to a player                                              */
/* ---------------------------------------------------------------- */

test("a household reads its rooms off a seeded host over SOAP", async () => {
  const fake = createFakeSonos({ port: 11400 });
  await fake.listen();
  try {
    const house = new sonos.Household({ hosts: ["127.0.0.1"], port: 11400 });
    await house.refresh({ force: true });
    assert.deepStrictEqual(house.rooms().map(r => r.name), ["Kitchen", "Study"]);
    assert.strictEqual(house.lastError, "");
  } finally {
    await fake.close();
  }
});

test("a household with nothing to talk to says so instead of throwing", async () => {
  const house = new sonos.Household({ hosts: ["127.0.0.1"], port: 11499 });
  await house.refresh({ force: true });
  assert.deepStrictEqual(house.rooms(), []);
  assert.ok(house.lastError, "the reason is kept for the UI to show");
});
