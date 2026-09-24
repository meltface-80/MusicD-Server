"use strict";
/*
 * After a restart (an update, a reboot) the rooms are back in seconds, from
 * the speakers remembered last time — and until then the server says it is
 * still looking, so the page doesn't claim there are no rooms.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FakeHousehold } = require("./fake-sonos");
const { signIn } = require("./auth-helper");

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    // A kept-alive connection to the stopped server fails once; ask again.
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await sleep(100);
  }
}

test("rooms come back straight after a restart, and 'searching' covers the gap", { timeout: 30000 }, async () => {
  const house = new FakeHousehold();
  await house.start();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-sonos-"));
  const music = path.join(tmp, "music");
  fs.mkdirSync(music);
  const { createServer } = require("../index.js");
  const cfg = { port: 3596, musicDir: music, dataDir: path.join(tmp, "data"), serverIp: "127.0.0.1" };
  let auth = {};
  const status = () => fetch("http://127.0.0.1:3596/api/status", { headers: auth }).then(r => r.json());

  let srv = null;
  try {
    // First run: told where one speaker is.
    srv = createServer(Object.assign({}, cfg, { sonosHosts: ["127.0.0.11"] }));
    await srv.start();
    auth = { Authorization: "Bearer " + await signIn("http://127.0.0.1:3596") };
    const first = await status();
    assert.equal(first.sonos.searching, true, "looking, not 'no rooms', right after start");
    await until(async () => (await status()).sonos.rooms === 2, 10000);
    assert.equal((await status()).sonos.searching, false);
    await srv.stop();

    // Second run: told nothing. The remembered speakers answer at once.
    srv = createServer(Object.assign({}, cfg, { sonosHosts: [] }));
    const t0 = Date.now();
    await srv.start();
    await until(async () => (await status()).sonos.rooms === 2, 8000);
    assert.ok(Date.now() - t0 < 8000, "rooms back well inside the old 30-second wait");
    await srv.stop();
    srv = null;
  } finally {
    if (srv) await srv.stop().catch(() => {});
    await house.stop();
  }
});
