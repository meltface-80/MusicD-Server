/*
 * MusicD Server — scrobbling to Last.fm.
 *
 * A CONSTRAINT WORTH WRITING DOWN, because it is the one thing about this
 * feature that could not be built the way the rest of the project is:
 *
 *   Last.fm has no OAuth 2 and no anonymous mode. Every single call carries an
 *   `api_key`, and every authenticated one carries an `api_sig` made with a
 *   shared secret. There is no keyless path — not a slower one, not a smaller
 *   one. A scrobbler without a key would be a scrobbler using somebody else's,
 *   which is what their terms exist to forbid.
 *
 * So the key here is a DEVELOPER registration rather than anything a listener
 * types: it is read from LASTFM_API_KEY and LASTFM_API_SECRET in the
 * container's environment, exactly as every scrobbler on every platform ships
 * one, and without it the feature says so and does nothing. What the person
 * using the app does is the browser flow they expected: they approve MusicD on
 * last.fm's own page, and what comes back — a session key, which never
 * expires and is not a password — is what this stores.
 *
 * WHAT COUNTS AS A PLAY is not decided here. lib/playback.js already watches
 * the speaker and credits a track at the half-way mark or four minutes,
 * whichever comes first, which happens to be Last.fm's own rule to the second
 * — so a scrobble and a play count are the same event, and the two can never
 * disagree about what was listened to.
 *
 * NOTHING IS LOST TO A BAD NETWORK. A scrobble is written to the database
 * first and sent afterwards; the row survives a restart, a router reboot and
 * an update, and is only deleted once Last.fm has accepted it.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const crypto = require("crypto");

const API_ROOT = "https://ws.audioscrobbler.com/2.0/";
const AUTH_PAGE = "https://www.last.fm/api/auth/";

const REQUEST_TIMEOUT_MS = 15000;

/* Last.fm accepts up to fifty scrobbles in one call. A queue that built up
   over a weekend offline should go back in a handful of requests, not one per
   track. */
const BATCH = 50;

/* A scrobble that has been refused this many times is refused for a reason
   this will not fix — a track with no artist, a timestamp Last.fm considers
   too old. Keeping it forever would mean retrying it on every play, forever. */
const MAX_TRIES = 8;

/* Session-shaped failures. 9 is "invalid session key": the user revoked
   MusicD's access at last.fm, and the honest response is to forget the session
   rather than retry with it every few minutes for ever. */
const ERROR_INVALID_SESSION = 9;

const SESSION_KEY = "lastfm.session";
const USER_KEY = "lastfm.user";

/* Every call is signed the same way: every parameter except the signature
   itself, sorted by name, concatenated as name+value, then the shared secret,
   then MD5. `format` is deliberately NOT in the parameters that get signed —
   it is added to the URL afterwards, and including it produces a signature
   Last.fm rejects with no explanation. */
function sign(params, secret) {
  const body = Object.keys(params).sort()
    .map(k => k + params[k]).join("");
  return crypto.createHash("md5").update(body + secret, "utf8").digest("hex");
}

function createLastfm({ db, settings, apiKey = "", apiSecret = "", fetchImpl = null }) {
  const http = fetchImpl || ((...args) => fetch(...args));
  const configured = !!(apiKey && apiSecret);

  /* A token taken from auth.getToken and not yet exchanged. It lives for
     sixty minutes at Last.fm's end and only matters between the tap that
     starts the flow and the tap that finishes it, so it is in memory: a
     restart in between means starting again, which is one tap. */
  let pending = null;

  const state = { flushing: false, lastError: "", lastAt: 0 };

  /* ---------------------------------------------------------------- */
  /*  Talking to Last.fm                                               */
  /* ---------------------------------------------------------------- */

  async function call(method, params, { signed = false, post = false } = {}) {
    if (!configured) throw new Error("Last.fm is not set up on this server.");
    const all = { ...params, method, api_key: apiKey };
    if (signed) all.api_sig = sign(all, apiSecret);

    const form = new URLSearchParams(all);
    form.set("format", "json");

    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = post
        ? await http(API_ROOT, {
            method: "POST", signal: control.signal,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString()
          })
        : await http(API_ROOT + "?" + form.toString(), { signal: control.signal });
    } finally { clearTimeout(timer); }

    const body = await res.json().catch(() => ({}));
    if (body && body.error) {
      const err = new Error(body.message || ("Last.fm error " + body.error));
      err.lastfm = Number(body.error);
      throw err;
    }
    if (!res.ok) throw new Error("Last.fm answered " + res.status);
    return body;
  }

  /* ---------------------------------------------------------------- */
  /*  Connecting                                                       */
  /* ---------------------------------------------------------------- */

  function session() { return settings.get(SESSION_KEY) || ""; }
  function user() { return settings.get(USER_KEY) || ""; }

  /*
   * Step one: ask for a token and hand back the page to approve it on.
   *
   * This is Last.fm's own approval page on last.fm's own domain — MusicD never
   * sees the password, and there is nothing to type into this app.
   */
  async function start() {
    const body = await call("auth.getToken", {});
    if (!body.token) throw new Error("Last.fm did not give a token back.");
    pending = { token: body.token, at: Date.now() };
    return {
      token: body.token,
      url: `${AUTH_PAGE}?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(body.token)}`
    };
  }

  /* Step two, once they have approved it. The token is only good after the
     approval, which is why this cannot be done in one step. */
  async function finish(token) {
    const use = token || (pending && pending.token);
    if (!use) throw new Error("Start the Last.fm connection first.");
    const body = await call("auth.getSession", { token: use }, { signed: true });
    const got = body && body.session;
    if (!got || !got.key) throw new Error("Last.fm did not give a session back.");
    settings.set(SESSION_KEY, got.key);
    settings.set(USER_KEY, got.name || "");
    pending = null;
    state.lastError = "";
    return { user: got.name || "" };
  }

  /* Forgetting the session is the whole of disconnecting: it is not a password
     and Last.fm's own settings page is where access is revoked properly. The
     queue is kept — reconnecting should send what was missed, not throw it
     away. */
  function disconnect() {
    settings.set(SESSION_KEY, "");
    settings.set(USER_KEY, "");
    pending = null;
    return true;
  }

  /* ---------------------------------------------------------------- */
  /*  The queue                                                        */
  /* ---------------------------------------------------------------- */

  /* Written down BEFORE it is sent. A scrobble that only existed in memory
     would be lost to the restart an update performs, which is the moment a
     listener is least likely to notice it went missing. */
  function enqueue(play) {
    if (!play || !play.artist || !play.track) return null;
    const info = db.prepare(
      `INSERT INTO scrobbles (artist, track, album, album_artist, duration, track_no, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(String(play.artist), String(play.track), String(play.album || ""),
           String(play.albumArtist || ""), Math.round(play.duration || 0),
           Math.round(play.trackNo || 0), Math.floor(play.at / 1000));
    return info.lastInsertRowid;
  }

  function queued() {
    return db.prepare("SELECT COUNT(*) n FROM scrobbles").get().n;
  }

  /*
   * Send what is waiting, oldest first.
   *
   * A row is deleted only once Last.fm has accepted the batch. A batch that
   * fails leaves every row in place with its try count raised, so the next
   * flush picks up exactly where this one stopped.
   */
  async function flush() {
    if (!configured || !session() || state.flushing) return { sent: 0, left: queued() };
    state.flushing = true;
    let sent = 0;
    try {
      for (;;) {
        const rows = db.prepare(
          `SELECT * FROM scrobbles WHERE tries < ? ORDER BY ts LIMIT ?`).all(MAX_TRIES, BATCH);
        if (!rows.length) break;

        const params = { sk: session() };
        rows.forEach((row, i) => {
          params[`artist[${i}]`] = row.artist;
          params[`track[${i}]`] = row.track;
          params[`timestamp[${i}]`] = String(row.ts);
          if (row.album) params[`album[${i}]`] = row.album;
          if (row.album_artist) params[`albumArtist[${i}]`] = row.album_artist;
          if (row.duration) params[`duration[${i}]`] = String(row.duration);
          if (row.track_no) params[`trackNumber[${i}]`] = String(row.track_no);
        });

        try {
          await call("track.scrobble", params, { signed: true, post: true });
        } catch (e) {
          note(rows, e);
          return { sent, left: queued(), error: e.message };
        }
        const drop = db.prepare("DELETE FROM scrobbles WHERE id = ?");
        const clear = db.transaction(() => { for (const row of rows) drop.run(row.id); });
        clear();
        sent += rows.length;
        state.lastError = "";
        state.lastAt = Date.now();
        if (rows.length < BATCH) break;
      }
    } finally { state.flushing = false; }
    return { sent, left: queued() };
  }

  /* What a failure does to the rows it was carrying. A revoked session is not
     something more tries will fix, so it forgets the session and leaves the
     queue alone for whenever it is reconnected. */
  function note(rows, error) {
    state.lastError = error.message;
    state.lastAt = Date.now();
    if (error.lastfm === ERROR_INVALID_SESSION) {
      console.warn("[lastfm] the session was rejected — reconnect from the side menu");
      disconnect();
      return;
    }
    const bump = db.prepare("UPDATE scrobbles SET tries = tries + 1, last_error = ? WHERE id = ?");
    const all = db.transaction(() => { for (const row of rows) bump.run(error.message.slice(0, 200), row.id); });
    all();
  }

  /* ---------------------------------------------------------------- */
  /*  What playback calls                                              */
  /* ---------------------------------------------------------------- */

  /*
   * "Playing now", which is not a scrobble.
   *
   * It is not queued and it is never retried: it says what is on RIGHT NOW,
   * so a copy of it sent ten minutes later would be a lie. A failure here is
   * silent by design.
   */
  function nowPlaying(play) {
    if (!configured || !session() || !play || !play.artist || !play.track) return Promise.resolve(false);
    const params = { sk: session(), artist: play.artist, track: play.track };
    if (play.album) params.album = play.album;
    if (play.albumArtist) params.albumArtist = play.albumArtist;
    if (play.duration) params.duration = String(Math.round(play.duration));
    if (play.trackNo) params.trackNumber = String(Math.round(play.trackNo));
    return call("track.updateNowPlaying", params, { signed: true, post: true })
      .then(() => true)
      .catch((e) => {
        /* Deliberately quiet. This is a courtesy update about something that
           is happening now; the scrobble that follows it is the record, and it
           has a queue of its own. */
        state.lastError = e.message;
        return false;
      });
  }

  /* A finished listen: written down, then sent. */
  function scrobble(play) {
    if (!configured || !session()) return Promise.resolve(false);
    if (!enqueue(play)) return Promise.resolve(false);
    return flush().then(r => !r.error).catch(() => false);
  }

  function status() {
    const stuck = db.prepare("SELECT COUNT(*) n FROM scrobbles WHERE tries >= ?").get(MAX_TRIES).n;
    return {
      configured,
      connected: !!session(),
      user: user(),
      pending: !!pending,
      queued: queued(),
      stuck,
      lastError: state.lastError,
      lastAt: state.lastAt
    };
  }

  return {
    start, finish, disconnect, status,
    nowPlaying, scrobble, flush, enqueue, queued,
    /* For the tests, and for anyone reading a signature by hand. */
    _sign: (params) => sign(params, apiSecret)
  };
}

module.exports = { createLastfm, sign, API_ROOT, AUTH_PAGE, BATCH, MAX_TRIES };
