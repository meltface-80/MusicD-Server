"use strict";
/*
 * Away from home: any request not from the home network — over Tailscale,
 * say — sees and reaches only the Android app's own phone zone. The Sonos
 * rooms aren't listed and can't be played to, paused, grouped or muted, and
 * no one away can reach the phone either except the phone itself. Tracks
 * stream as Opus 256 when asked.
 *
 * The tests run on loopback, so "away" is a proxy on this machine forwarding
 * for a Tailscale address — the one case X-Forwarded-For is believed.
 */
const test = require("node:test");
const assert = require("node:assert");
const { haveFfmpeg, makeLibrary } = require("./fixtures");
const { FakeHousehold } = require("./fake-sonos");
const { signIn, post } = require("./auth-helper");
const { isLocal } = require("../lib/server/auth");
const { awayAddress, inTailnet } = require("../lib/server/tailscale");

const skip = !haveFfmpeg() && "ffmpeg is not installed";
const PORT = 3605;
const B = "http://127.0.0.1:" + PORT;
const TAILNET = "100.101.102.103";

async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise(r => setTimeout(r, 100));
  }
}

test("home and away addresses", () => {
  for (const a of ["192.168.1.20", "10.0.0.5", "172.20.1.1", "127.0.0.1", "::1", "fe80::1", "fd12:3456::1"]) assert.ok(isLocal(a), a);
  for (const a of ["100.101.102.103", "fd7a:115c:a1e0::1", "8.8.8.8", "::ffff:100.64.0.1"]) assert.ok(!isLocal(a), a);
  assert.ok(inTailnet("100.64.0.1") && inTailnet("100.127.255.254") && !inTailnet("100.128.0.1") && !inTailnet("100.63.0.1"));
  const ifaces = { eth0: [{ family: "IPv4", address: "192.168.1.10" }], tailscale0: [{ family: "IPv4", address: "100.90.1.2" }] };
  assert.equal(awayAddress(3500, {}, ifaces), "http://100.90.1.2:3500");
  assert.equal(awayAddress(3500, {}, { eth0: ifaces.eth0 }), null);
  assert.equal(awayAddress(3500, { TAILSCALE_ADDRESS: "musicd.tail1234.ts.net" }, ifaces), "http://musicd.tail1234.ts.net:3500");
  assert.equal(awayAddress(3500, { TAILSCALE_ADDRESS: "https://musicd.tail1234.ts.net/" }, ifaces), "https://musicd.tail1234.ts.net");
});

test("away, only this phone plays", { skip, timeout: 90000 }, async (t) => {
  const lib = makeLibrary();
  const house = new FakeHousehold();
  await house.start();
  const { createServer } = require("../index.js");
  const srv = createServer({ port: PORT, musicDir: lib.music, dataDir: lib.data, serverIp: "127.0.0.1", sonosHosts: ["127.0.0.11"] });
  await srv.start();
  const phoneToken = await signIn(B);
  const browserToken = await (async () => {
    const SRP = require("../public/srp");
    const ch = await post(B, "/api/auth/challenge", { username: "tester" });
    const s = SRP.clientStart();
    const p = SRP.clientProof("tester", "correct horse battery staple", ch.salt, ch.iterations, s, ch.B);
    return (await post(B, "/api/auth/verify", { id: ch.id, A: s.A, M1: p.M1, want_token: true, kind: "browser", device_name: "iPhone" })).token;
  })();
  const call = async (token, away, method, p, body) => {
    const headers = { Authorization: "Bearer " + token };
    if (away) headers["X-Forwarded-For"] = TAILNET;
    if (body) headers["Content-Type"] = "application/json";
    const r = await fetch(B + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return Object.assign({ status: r.status }, await r.json().catch(() => ({})));
  };
  const phoneHome = (m, p, b) => call(phoneToken, false, m, p, b);
  const phoneAway = (m, p, b) => call(phoneToken, true, m, p, b);
  const browserAway = (m, p, b) => call(browserToken, true, m, p, b);

  try {
    await until(async () => (await phoneHome("GET", "/api/status")).index_count === 3);
    const rooms = await until(async () => {
      const z = (await phoneHome("GET", "/api/zones")).zones.filter(x => !x.is_phone);
      return z.length === 2 && z;
    });
    const sonos = rooms[0].zone_id;
    const hello = await phoneAway("POST", "/api/phone/hello", { name: "Pixel" });
    const mine = hello.zone_id;
    const album = (await phoneHome("GET", "/api/library/albums?sort=album")).albums.find(a => a.title === "Album One");

    await t.test("at home everything is there, and the server says it's home", async () => {
      const z = await phoneHome("GET", "/api/zones");
      assert.equal(z.away, false);
      assert.equal(z.zones.length, 3);
      assert.equal((await phoneHome("GET", "/api/status")).away, false);
    });

    await t.test("the phone away sees only itself", async () => {
      assert.equal(hello.away, true);
      const z = await phoneAway("GET", "/api/zones");
      assert.equal(z.away, true);
      assert.deepEqual(z.zones.map(x => x.zone_id), [mine]);
      assert.deepEqual((await phoneAway("GET", "/api/shortcut/zones")).zones.map(x => x.zone_id), [mine]);
      assert.deepEqual((await phoneAway("GET", "/api/outputs")).outputs, []);
      const st = await phoneAway("GET", "/api/status");
      assert.equal(st.away, true);
      assert.equal(st.zone_count, 0);
    });

    await t.test("nothing away reaches a Sonos room", async () => {
      const deny = [
        ["GET", "/api/zone-state?zone=" + sonos],
        ["GET", "/api/queue?zone=" + sonos],
        ["POST", "/api/play", { offset: album.offset, zone_or_output_id: sonos, kind: "play_now" }],
        ["POST", "/api/control", { zone_or_output_id: sonos, command: "pause" }],
        ["POST", "/api/volume", { output_id: sonos, value: 10 }],
        ["POST", "/api/transfer-zone", { from: mine, to: sonos }],
        ["POST", "/api/pause-all", {}],
        ["POST", "/api/mute-all", {}],
        ["POST", "/api/group-outputs", { output_ids: [rooms[0].outputs[0].output_id, rooms[1].outputs[0].output_id] }],
        ["POST", "/api/ungroup-outputs", { output_ids: [rooms[0].outputs[0].output_id] }],
        ["GET", "/api/shortcut/play-random?zone=" + sonos]
      ];
      for (const [m, p, b] of deny) {
        const r = await phoneAway(m, p, b);
        assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
      }
    });

    await t.test("but the phone away plays to itself", async () => {
      assert.equal((await phoneAway("GET", "/api/zone-state?zone=" + mine)).zone.zone_id, mine);
      const r = await phoneAway("POST", "/api/play", { offset: album.offset, zone_or_output_id: mine, kind: "play_now" });
      assert.equal(r.status, 200, JSON.stringify(r));
      const got = await phoneAway("GET", `/api/phone/commands?after=${hello.seq}`);
      const load = got.commands.find(c => c.op === "load");
      assert.ok(load && load.items.length === 3);

      // The same signed address, as Opus for mobile data.
      const audio = await fetch(load.items[0].url + "&q=opus", { headers: { "X-Forwarded-For": TAILNET } });
      assert.equal(audio.status, 200);
      assert.equal(audio.headers.get("content-type"), "audio/ogg");
      const bytes = Buffer.from(await audio.arrayBuffer());
      assert.equal(bytes.slice(0, 4).toString(), "OggS");
    });

    await t.test("a browser away sees nothing to play to, not even the phone", async () => {
      const z = await browserAway("GET", "/api/zones");
      assert.equal(z.away, true);
      assert.deepEqual(z.zones, []);
      assert.equal((await browserAway("GET", "/api/zone-state?zone=" + mine)).status, 403);
      assert.equal((await browserAway("POST", "/api/control", { zone_or_output_id: sonos, command: "play" })).status, 403);
      assert.equal((await browserAway("GET", "/api/shortcut/play-random")).status, 503);
      // The library is still there to browse.
      assert.equal((await browserAway("GET", "/api/library/albums?sort=album")).albums.length, 3);
    });

    await t.test("only a proxy on this machine is believed about where a request comes from", async () => {
      // From loopback with no header: home. A remote client can't set it —
      // its own address is used, and loopback is the only proxy trusted.
      const { clientIp } = require("../lib/server/auth");
      const req = (addr, xff) => ({ socket: { remoteAddress: addr }, headers: xff ? { "x-forwarded-for": xff } : {} });
      assert.equal(clientIp(req("127.0.0.1", TAILNET)), TAILNET);
      assert.equal(clientIp(req("::ffff:127.0.0.1", "1.2.3.4, " + TAILNET)), TAILNET);
      assert.equal(clientIp(req("192.168.1.5", "10.0.0.1")), "192.168.1.5");
      assert.equal(clientIp(req("::ffff:100.100.1.1", "192.168.1.9")), "100.100.1.1");
    });
  } finally {
    await srv.stop();
    await house.stop();
  }
});
