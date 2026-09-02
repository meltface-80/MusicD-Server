"use strict";

/*
 * Scrobbling to Last.fm.
 *
 * The fake below VERIFIES THE SIGNATURE on every authenticated call and
 * refuses a wrong one, the way the real service does. A stand-in that accepts
 * whatever it is handed would pass every test here while the real thing
 * answered "Invalid method signature supplied" to all of it — the same shape
 * of hole that let a broken updater ship three times.
 */

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dbLib = require("../lib/db");
const settingsLib = require("../lib/settings");
const { createLastfm, sign } = require("../lib/lastfm");

const KEY = "test-api-key";
const SECRET = "test-shared-secret";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-lastfm-"));
  const db = dbLib.open(path.join(root, "data"));
  return { root, db, settings: settingsLib.open(db), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/* ------------------------------------------------------------------ */
/*  A Last.fm that checks what it is sent                              */
/* ------------------------------------------------------------------ */

function fakeLastfm({ answers = {}, session = "sk-1234", user = "listener" } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const params = options.body
      ? new URLSearchParams(String(options.body))
      : new URL(url).searchParams;

    const all = {};
    for (const [k, v] of params) all[k] = v;
    const method = all.method;
    calls.push({ method, params: all, post: options.method === "POST" });

    const json = (body, ok = true) => ({
      ok, status: ok ? 200 : 400,
      json: async () => body
    });

    if (all.api_key !== KEY) return json({ error: 10, message: "Invalid API key" }, false);

    /* Every authenticated method is signed, and the signature is over every
       parameter EXCEPT format and api_sig. Getting that exclusion wrong is
       the classic Last.fm mistake and it is silent. */
    if (all.api_sig !== undefined) {
      const signable = { ...all };
      delete signable.api_sig;
      delete signable.format;
      const want = crypto.createHash("md5")
        .update(Object.keys(signable).sort().map(k => k + signable[k]).join("") + SECRET, "utf8")
        .digest("hex");
      if (want !== all.api_sig) {
        return json({ error: 13, message: "Invalid method signature supplied" }, false);
      }
    }

    if (answers[method]) {
      const answer = answers[method];
      return json(typeof answer === "function" ? answer(all, calls) : answer,
                  !(answers[method] && answers[method].error));
    }

    if (method === "auth.getToken") return json({ token: "tok-abc" });
    if (method === "auth.getSession") {
      if (!all.api_sig) return json({ error: 13, message: "unsigned" }, false);
      if (all.token !== "tok-abc") return json({ error: 4, message: "Invalid token" }, false);
      return json({ session: { name: user, key: session, subscriber: 0 } });
    }
    if (method === "track.scrobble") {
      if (all.sk !== session) return json({ error: 9, message: "Invalid session key" }, false);
      return json({ scrobbles: { "@attr": { accepted: 1, ignored: 0 } } });
    }
    if (method === "track.updateNowPlaying") {
      if (all.sk !== session) return json({ error: 9, message: "Invalid session key" }, false);
      return json({ nowplaying: { track: { "#text": all.track } } });
    }
    return json({ error: 3, message: "Invalid Method" }, false);
  };
  return { impl, calls };
}

function scrobbler(ws, net, extra = {}) {
  return createLastfm({
    db: ws.db, settings: ws.settings,
    apiKey: KEY, apiSecret: SECRET, fetchImpl: net.impl, ...extra
  });
}

const LISTEN = {
  artist: "Slowdive", track: "Alison", album: "Souvlaki",
  albumArtist: "Slowdive", duration: 227, trackNo: 1, at: 1700000000000
};

/* ------------------------------------------------------------------ */

test("the signature covers every parameter but format, sorted by name", () => {
  const params = { method: "auth.getSession", api_key: "k", token: "t" };
  const expected = crypto.createHash("md5")
    .update("api_keykmethodauth.getSessiontokent" + "sec", "utf8").digest("hex");
  assert.strictEqual(sign(params, "sec"), expected);
});

test("connecting is two steps, and the password never comes near this app", async () => {
  const ws = workspace();
  const net = fakeLastfm();
  const lastfm = scrobbler(ws, net);

  const begun = await lastfm.start();
  assert.match(begun.url, /^https:\/\/www\.last\.fm\/api\/auth\/\?/);
  assert.match(begun.url, new RegExp("api_key=" + KEY));
  assert.match(begun.url, /token=tok-abc/);
  assert.strictEqual(lastfm.status().connected, false);
  assert.strictEqual(lastfm.status().pending, true);

  const done = await lastfm.finish();
  assert.strictEqual(done.user, "listener");
  assert.strictEqual(lastfm.status().connected, true);
  assert.strictEqual(lastfm.status().user, "listener");

  /* Nothing that could be a password went anywhere. */
  for (const call of net.calls) {
    assert.ok(!("password" in call.params) && !("username" in call.params));
  }
  ws.cleanup();
});

test("the session survives a restart, because it is in the database", async () => {
  const ws = workspace();
  const net = fakeLastfm();
  const first = scrobbler(ws, net);
  await first.start();
  await first.finish();

  /* A second instance over the same database — which is what an update, a
     reboot or a container restart produces. */
  const second = scrobbler(ws, net);
  assert.strictEqual(second.status().connected, true);
  assert.strictEqual(second.status().user, "listener");
  ws.cleanup();
});

test("a listen is written down before it is sent, and deleted once accepted", async () => {
  const ws = workspace();
  const net = fakeLastfm();
  const lastfm = scrobbler(ws, net);
  await lastfm.start(); await lastfm.finish();

  await lastfm.scrobble(LISTEN);
  assert.strictEqual(lastfm.queued(), 0, "accepted, so it is gone from the queue");

  const sent = net.calls.find(c => c.method === "track.scrobble");
  assert.ok(sent, "it was actually sent");
  assert.strictEqual(sent.post, true, "a write goes by POST, as Last.fm requires");
  assert.strictEqual(sent.params["artist[0]"], "Slowdive");
  assert.strictEqual(sent.params["track[0]"], "Alison");
  assert.strictEqual(sent.params["album[0]"], "Souvlaki");
  assert.strictEqual(sent.params["duration[0]"], "227");
  /* Seconds, and the moment it STARTED — a scrobble timestamped when it
     finished lands in the wrong place in a listening history. */
  assert.strictEqual(sent.params["timestamp[0]"], String(LISTEN.at / 1000));
  ws.cleanup();
});

test("a listen that cannot be sent is kept until it can", async () => {
  const ws = workspace();
  const net = fakeLastfm({ answers: { "track.scrobble": { error: 16, message: "temporarily unavailable" } } });
  const lastfm = scrobbler(ws, net);
  await lastfm.start(); await lastfm.finish();

  await lastfm.scrobble(LISTEN);
  assert.strictEqual(lastfm.queued(), 1, "still waiting, not thrown away");
  assert.match(lastfm.status().lastError, /unavailable/);

  /* The queue is in the database, so a restart does not lose it either. */
  const afterRestart = createLastfm({
    db: ws.db, settings: ws.settings, apiKey: KEY, apiSecret: SECRET,
    fetchImpl: fakeLastfm().impl
  });
  assert.strictEqual(afterRestart.queued(), 1);
  const result = await afterRestart.flush();
  assert.strictEqual(result.sent, 1);
  assert.strictEqual(afterRestart.queued(), 0);
  ws.cleanup();
});

test("a weekend offline goes back in batches, not one request per track", async () => {
  const ws = workspace();
  const net = fakeLastfm();
  const lastfm = scrobbler(ws, net);
  await lastfm.start(); await lastfm.finish();

  for (let i = 0; i < 120; i++) {
    lastfm.enqueue({ ...LISTEN, track: "Track " + i, at: LISTEN.at + i * 240000 });
  }
  assert.strictEqual(lastfm.queued(), 120);

  const result = await lastfm.flush();
  assert.strictEqual(result.sent, 120);
  assert.strictEqual(lastfm.queued(), 0);
  const batches = net.calls.filter(c => c.method === "track.scrobble");
  assert.strictEqual(batches.length, 3, "fifty at a time");
  assert.strictEqual(batches[0].params["track[49]"], "Track 49");
  assert.strictEqual(batches[0].params["track[50]"], undefined);
  ws.cleanup();
});

/*
 * A revoked session is not something more tries will fix. Retrying it every
 * fifteen minutes forever is how a well-meaning client becomes a nuisance.
 */
test("a session Last.fm has revoked is forgotten, and the queue is kept", async () => {
  const ws = workspace();
  const net = fakeLastfm();
  const lastfm = scrobbler(ws, net);
  await lastfm.start(); await lastfm.finish();
  lastfm.enqueue(LISTEN);

  /* The account holder revoked MusicD's access at last.fm. */
  const revoked = fakeLastfm({ session: "a-different-key" });
  const after = createLastfm({
    db: ws.db, settings: ws.settings, apiKey: KEY, apiSecret: SECRET, fetchImpl: revoked.impl
  });
  await after.flush();

  assert.strictEqual(after.status().connected, false, "the dead session is forgotten");
  assert.strictEqual(after.queued(), 1, "but the listen is not thrown away");
  ws.cleanup();
});

test("playing now is never queued and never retried", async () => {
  const ws = workspace();
  const net = fakeLastfm({ answers: { "track.updateNowPlaying": { error: 16, message: "down" } } });
  const lastfm = scrobbler(ws, net);
  await lastfm.start(); await lastfm.finish();

  const ok = await lastfm.nowPlaying(LISTEN);
  assert.strictEqual(ok, false);
  assert.strictEqual(lastfm.queued(), 0,
    "a copy of 'what is on right now' sent ten minutes later would be a lie");
  ws.cleanup();
});

test("with no key configured, nothing is offered and nothing is sent", async () => {
  const ws = workspace();
  const net = fakeLastfm();
  const lastfm = createLastfm({ db: ws.db, settings: ws.settings, fetchImpl: net.impl });

  const status = lastfm.status();
  assert.strictEqual(status.configured, false);
  assert.strictEqual(status.connected, false);
  await assert.rejects(() => lastfm.start(), /not set up/);
  assert.strictEqual(await lastfm.scrobble(LISTEN), false);
  assert.strictEqual(lastfm.queued(), 0, "not even queued — there is nowhere for it to go");
  assert.strictEqual(net.calls.length, 0);
  ws.cleanup();
});

test("nothing is sent before an account is connected, and nothing is lost", async () => {
  const ws = workspace();
  const net = fakeLastfm();
  const lastfm = scrobbler(ws, net);

  assert.strictEqual(await lastfm.scrobble(LISTEN), false);
  assert.strictEqual(net.calls.length, 0, "no account, no request");
  ws.cleanup();
});

test("a listen with no artist is not a listen", async () => {
  const ws = workspace();
  const net = fakeLastfm();
  const lastfm = scrobbler(ws, net);
  await lastfm.start(); await lastfm.finish();

  await lastfm.scrobble({ ...LISTEN, artist: "" });
  assert.strictEqual(lastfm.queued(), 0);
  assert.ok(!net.calls.some(c => c.method === "track.scrobble"));
  ws.cleanup();
});

test("a scrobble Last.fm keeps refusing is eventually left alone", async () => {
  const ws = workspace();
  const net = fakeLastfm({ answers: { "track.scrobble": { error: 6, message: "Invalid parameters" } } });
  const lastfm = scrobbler(ws, net);
  await lastfm.start(); await lastfm.finish();
  lastfm.enqueue(LISTEN);

  for (let i = 0; i < 12; i++) await lastfm.flush();
  const attempts = net.calls.filter(c => c.method === "track.scrobble").length;
  assert.ok(attempts <= 8, `gave up after ${attempts} attempts rather than retrying forever`);
  assert.strictEqual(lastfm.status().stuck, 1, "and it is counted, not hidden");
  ws.cleanup();
});

test("disconnecting forgets the session and keeps what has not been sent", async () => {
  const ws = workspace();
  const net = fakeLastfm({ answers: { "track.scrobble": { error: 16, message: "down" } } });
  const lastfm = scrobbler(ws, net);
  await lastfm.start(); await lastfm.finish();
  await lastfm.scrobble(LISTEN);
  assert.strictEqual(lastfm.queued(), 1);

  lastfm.disconnect();
  assert.strictEqual(lastfm.status().connected, false);
  assert.strictEqual(lastfm.status().user, "");
  assert.strictEqual(lastfm.queued(), 1, "reconnecting should send what was missed");
  ws.cleanup();
});
