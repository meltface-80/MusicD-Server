"use strict";
/*
 * The account and the gate: nothing without signing in, the password never
 * sent, wrong guesses locked out, devices signed out, a forgotten password
 * reset on the server, and Sonos still able to fetch what it's given.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const SRP = require("../public/srp");
const { isLocal, deviceNameFromUA } = require("../lib/server/auth");
const { signIn, post, USER, PASS } = require("./auth-helper");

const PORT = 3600;
const B = "http://127.0.0.1:" + PORT;

async function startServer(dataDir) {
  const music = path.join(dataDir, "..", "music");
  fs.mkdirSync(music, { recursive: true });
  const { createServer } = require("../index.js");
  const srv = createServer({ port: PORT, musicDir: music, dataDir, serverIp: "127.0.0.1", sonosHosts: [] });
  const ctx = await srv.start();
  return { srv, ctx };
}
const get = (p, token, extra) => fetch(B + p, Object.assign({ redirect: "manual", headers: token ? { Authorization: "Bearer " + token } : {} }, extra));

test("home network addresses, and device names from browsers", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "172.31.255.1", "192.168.0.57", "::1", "::ffff:192.168.1.4", "fe80::1", "fd12:3456::1"]) {
    assert.equal(isLocal(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "100.101.102.103", "2a00:1450::1", ""]) assert.equal(isLocal(ip), false, ip);
  assert.equal(deviceNameFromUA("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"), "iPhone · Safari");
  assert.equal(deviceNameFromUA("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"), "Android · Chrome");
});

test("MusicD Server behind its account", { timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-auth-"));
  const dataDir = path.join(tmp, "data");
  let { srv, ctx } = await startServer(dataDir);
  try {
    await t.test("until the account exists, only the sign-in page and health answer", async () => {
      const st = await (await get("/api/auth/status")).json();
      assert.equal(st.setup_required, true);
      assert.equal(st.can_setup, true);
      assert.equal((await get("/api/health")).status, 200);
      const page = await get("/");
      assert.equal(page.status, 302);
      assert.match(page.headers.get("location"), /^\/login\?next=%2F$/);
      const api = await get("/api/status");
      assert.equal(api.status, 401);
      assert.equal((await api.json()).setup_required, true);
      assert.equal((await get("/login.html")).status, 200);
      assert.equal((await get("/srp.js")).status, 200);
    });

    let token;
    await t.test("creating the account sends a verifier, never the password", async () => {
      token = await signIn(B);
      const row = ctx.db.raw.prepare("SELECT * FROM account").get();
      assert.equal(row.username, USER);
      assert.ok(!JSON.stringify(row).includes(PASS));
      const dev = ctx.db.raw.prepare("SELECT * FROM devices").get();
      assert.ok(!JSON.stringify(dev).includes(token), "only the token's hash is stored");
      assert.equal((await get("/api/status", token)).status, 200);
      assert.equal((await post(B, "/api/auth/setup", { username: "again", salt: "ab".repeat(16), verifier: "cd", iterations: 1000 })).status, 409);
    });

    await t.test("a browser signs in with an HttpOnly cookie", async () => {
      const ch = await post(B, "/api/auth/challenge", { username: USER });
      const start = SRP.clientStart();
      const proof = SRP.clientProof(USER, PASS, ch.salt, ch.iterations, start, ch.B);
      const r = await fetch(B + "/api/auth/verify", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: ch.id, A: start.A, M1: proof.M1 }) });
      const j = await r.json();
      assert.equal(j.M2, proof.expectM2, "the server proved it knows the account");
      assert.equal(j.token, undefined, "a browser never sees its token");
      const cookie = r.headers.get("set-cookie");
      assert.match(cookie, /musicd_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=31536000/);
      const page = await fetch(B + "/", { redirect: "manual", headers: { Cookie: cookie.split(";")[0] } });
      assert.equal(page.status, 200);
    });

    await t.test("wrong passwords are refused, then locked out", async () => {
      for (let i = 0; i < 5; i++) {
        const ch = await post(B, "/api/auth/challenge", { username: USER });
        const start = SRP.clientStart();
        const proof = SRP.clientProof(USER, "wrong", ch.salt, ch.iterations, start, ch.B);
        const r = await post(B, "/api/auth/verify", { id: ch.id, A: start.A, M1: proof.M1 });
        assert.equal(r.status, 401);
      }
      assert.equal((await post(B, "/api/auth/challenge", { username: USER })).status, 429);
      // A name that doesn't exist looks like one that does.
    });

    await t.test("devices are listed and can be signed out", async () => {
      const list = await (await get("/api/auth/devices", token)).json();
      assert.ok(list.devices.length >= 2);
      assert.equal(list.devices.filter(d => d.current).length, 1);
      const other = list.devices.find(d => !d.current);
      assert.equal((await post(B, "/api/auth/devices/revoke", { id: other.id }, token)).ok, true);
      const after = await (await get("/api/auth/devices", token)).json();
      assert.equal(after.devices.length, list.devices.length - 1);
    });

    await t.test("Sonos gets signed addresses; unsigned ones are refused", async () => {
      const url = ctx.auth.signUrl(B + "/api/image/al-1-0?size=200");
      assert.match(url, /[?&]s=[A-Za-z0-9_-]{22}$/);
      const unsigned = await get("/api/image/al-1-0?size=200");
      assert.equal(unsigned.status, 401);
      const forged = await get("/api/image/al-1-0?size=200&s=AAAAAAAAAAAAAAAAAAAAAA");
      assert.equal(forged.status, 401);
      assert.equal((await get("/api/image/al-1-0?s=" + encodeURIComponent("é".repeat(22)))).status, 401, "odd input is refused, not a crash");
      const other = await get("/api/image/al-2-0?size=200&s=" + url.split("s=")[1]);
      assert.equal(other.status, 401, "a signature is for its own address only");
      assert.notEqual((await fetch(url)).status, 401);
    });

    await t.test("signing out ends the device", async () => {
      const r = await post(B, "/api/auth/logout", {}, token);
      assert.equal(r.ok, true);
      assert.equal((await get("/api/status", token)).status, 401);
    });
  } finally {
    await srv.stop();
  }

  // Forgotten password: reset on the server, then create the account again.
  const out = execFileSync(process.execPath, [path.join(__dirname, "..", "reset-password.js")], { env: Object.assign({}, process.env, { DATA_DIR: dataDir }) }).toString();
  assert.match(out, /removed/);
  ({ srv, ctx } = await startServer(dataDir));
  // Connections kept alive to the stopped server fail once each; use them up.
  for (let i = 0; i < 10; i++) { try { await fetch(B + "/api/health"); break; } catch (e) { /* next */ } }
  try {
    const st = await (await get("/api/auth/status")).json();
    assert.equal(st.setup_required, true);
    const token = await signIn(B, { password: "a new one" });
    assert.equal((await get("/api/status", token)).status, 200);

    // Changing the password needs the current one first.
    const v = SRP.makeVerifier(USER, "newer still", 1000);
    assert.equal((await post(B, "/api/auth/password", Object.assign({ iterations: 1000 }, v), token)).status, 403);
    const ch = await post(B, "/api/auth/challenge", { username: USER });
    const start = SRP.clientStart();
    const proof = SRP.clientProof(USER, "a new one", ch.salt, ch.iterations, start, ch.B);
    const re = await post(B, "/api/auth/verify", { id: ch.id, A: start.A, M1: proof.M1, purpose: "reauth" }, token);
    assert.equal(re.ok, true);
    assert.equal(re.token, undefined, "re-checking the password doesn't make a new device");
    assert.equal((await post(B, "/api/auth/password", Object.assign({ iterations: 1000 }, v), token)).ok, true);
    await assert.rejects(signIn(B, { password: "a new one", create: false }));
    assert.ok(await signIn(B, { password: "newer still", create: false }));
  } finally {
    await srv.stop();
  }
});

test("a queue made before the update keeps playing: speakers need no signature", { timeout: 30000 }, async () => {
  const http = require("http");
  const { FakeHousehold } = require("./fake-sonos");
  const house = new FakeHousehold();
  await house.start();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-auth-sonos-"));
  fs.mkdirSync(path.join(tmp, "music"));
  const { createServer } = require("../index.js");
  const srv = createServer({ port: PORT + 1, musicDir: path.join(tmp, "music"), dataDir: path.join(tmp, "data"), serverIp: "127.0.0.1", sonosHosts: ["127.0.0.11"] });
  const ctx = await srv.start();
  const from = (ip) => new Promise((resolve) => {
    const r = http.get({ host: "127.0.0.1", port: PORT + 1, path: "/api/image/al-1-0", localAddress: ip, agent: false }, (x) => { x.resume(); resolve(x.statusCode); });
    r.on("error", (e) => resolve(e.message));
  });
  try {
    for (let i = 0; i < 50 && !ctx.zones.topology.hosts.includes("127.0.0.12"); i++) await new Promise(r => setTimeout(r, 200));
    assert.notEqual(await from("127.0.0.12"), 401, "a speaker gets through unsigned");
    assert.equal(await from("127.0.0.99"), 401, "anything else needs to sign in");
  } finally {
    await srv.stop();
    await house.stop();
  }
});

test("the Android app gets the page without viewport-fit=cover; browsers keep it", { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-ua-"));
  const { srv } = await startServer(path.join(tmp, "data"));
  try {
    const token = await signIn(B);
    const page = async (ua) => (await fetch(B + "/", { headers: { Authorization: "Bearer " + token, "User-Agent": ua } })).text();
    const browser = await page("Mozilla/5.0 (iPhone) Safari/604.1");
    const app = await page("Mozilla/5.0 (Linux; Android 15; wv) Chrome/130 Mobile Safari/537.36 MusicDAndroid/0.2.1");
    assert.match(browser, /viewport-fit=cover/);
    assert.doesNotMatch(app, /content="[^"]*viewport-fit=cover/);
    assert.match(app, /maximum-scale=1,user-scalable=no"/);
  } finally {
    await srv.stop();
  }
});
