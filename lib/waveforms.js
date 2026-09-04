"use strict";
/*
 * waveforms.js — the store in front of the decoder.
 *
 * lib/waveform.js turns PCM into numbers and lib/waveform-decode.js gets the
 * PCM out of a file. This is the part that decides whether a decode is needed
 * at all, makes sure only one runs at a time, and writes the answer down.
 *
 * LOCAL FILES ONLY. There is nothing to add for streaming because this server
 * has no streaming to add it for — it plays the user's own files and that is
 * the whole library.
 *
 * WHAT IS DIFFERENT FROM COVERS AND WRITE-UPS: nothing here touches the
 * network. A waveform is a measurement of a file the user already owns, so
 * there is no rate gate, no User-Agent, no terms to honour and no account. The
 * only cost is a CPU core for a fraction of a second, which is why the one
 * thing this DOES guard is how many decodes run at once.
 */

const WF = require("./waveform");
const { decodeWaveform, DECODE_RATE, lastDecodeError } = require("./waveform-decode");

/**
 * @param {object}   deps
 * @param {object}   deps.db
 * @param {boolean}  [deps.available]  false turns the feature off entirely
 * @param {function} [deps.decodeImpl] injected for tests
 */
function createWaveforms({ db, available = true, decodeImpl = null } = {}) {
  const decode = decodeImpl || decodeWaveform;

  const stmt = {
    get:   db.prepare("SELECT peaks, n, rate, size, mtime FROM waveforms WHERE track_id = ?"),
    put:   db.prepare(`INSERT INTO waveforms (track_id, peaks, n, rate, size, mtime, ts)
                       VALUES (?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(track_id) DO UPDATE SET
                         peaks = excluded.peaks, n = excluded.n, rate = excluded.rate,
                         size = excluded.size, mtime = excluded.mtime, ts = excluded.ts`),
    track: db.prepare("SELECT id, path, size, mtime, album_id, disc, no FROM tracks WHERE id = ? AND present = 1"),
    /* The next track on the same record, in the order it was sequenced. This is
       the whole of the look-ahead — see warm() for why that is enough here. */
    next:  db.prepare(`SELECT id FROM tracks
                       WHERE album_id = ? AND present = 1
                         AND (disc > ? OR (disc = ? AND no > ?))
                       ORDER BY disc, no LIMIT 1`)
  };

  /* One promise per track while a decode is in flight. Opening Now playing
     twice before the first answer lands must not spawn ffmpeg twice — and on a
     phone that is a double tap, not an edge case. */
  const inflight = new Map();

  function once(key, run) {
    const running = inflight.get(key);
    if (running) return running;
    const started = run().finally(() => inflight.delete(key));
    inflight.set(key, started);
    return started;
  }

  /*
   * Is a stored row still about this file?
   *
   * Three ways it might not be, and all three are silent unless checked:
   * the decode rate moved (the shape itself would be different), or the file
   * was replaced at the same path — a re-rip, a re-tag, a repaired download —
   * which the size and mtime catch between them. Believing a stale row draws a
   * confident picture of audio that is no longer there.
   */
  function fresh(row, track) {
    return !!row && row.rate === DECODE_RATE &&
           row.size === (track.size || 0) && row.mtime === (track.mtime || 0);
  }

  function store(track, u8) {
    stmt.put.run(track.id, u8 ? WF.encode(u8) : "", u8 ? u8.length : 0,
                 DECODE_RATE, track.size || 0, track.mtime || 0, Date.now());
  }

  /*
   * The waveform for one track.
   *
   * Resolves { peaks, n, cached } with peaks as base64, or { peaks: null } with
   * a reason. NEVER throws: every way this can fail is a track that keeps the
   * plain bar, which is exactly what the screen looked like before the feature
   * existed.
   */
  async function forTrack(trackId) {
    if (!available) return { peaks: null, reason: "off" };
    const track = stmt.track.get(String(trackId || ""));
    if (!track) return { peaks: null, reason: "unknown-track" };

    const row = stmt.get.get(track.id);
    if (fresh(row, track)) {
      /* A remembered MISS is an answer, and a fast one. Without this a file
         ffmpeg cannot read would be attempted again on every visit. */
      if (!row.n) return { peaks: null, reason: "undecodable", cached: true };
      return { peaks: row.peaks, n: row.n, cached: true };
    }

    return once(track.id, async () => {
      const u8 = await decode(track.path);
      /* The miss is written down too — see the schema note. */
      store(track, u8);
      if (!u8 || !u8.length) {
        const why = lastDecodeError();
        console.warn("[waveform] could not decode " + track.path + (why ? ": " + why : ""));
        return { peaks: null, reason: "undecodable", cached: false };
      }
      return { peaks: WF.encode(u8), n: u8.length, cached: false };
    });
  }

  /*
   * Decode the NEXT track on the same album, in the background.
   *
   * The look-ahead is the album, not the speaker's queue, and that is a
   * deliberate trade. Reading the real queue back off Sonos is a SOAP call —
   * the rule the radio's poll loop already lives under — and this app is built
   * around listening to a record in the order it was sequenced, with no shuffle
   * and no repeat by design. So the next track on the album is the right guess
   * almost every time, and it costs a database read instead of network traffic
   * to a speaker.
   *
   * Fire and forget. Nothing waits for it and a failure is not reported: the
   * worst case is that the next track decodes on demand like the first one did.
   */
  function warm(trackId) {
    if (!available) return null;
    const track = stmt.track.get(String(trackId || ""));
    if (!track) return null;
    const next = stmt.next.get(track.album_id, track.disc, track.disc, track.no);
    if (!next) return null;
    const row = stmt.get.get(next.id);
    const nextTrack = stmt.track.get(next.id);
    if (!nextTrack || fresh(row, nextTrack)) return null;   // already known
    /* Returned so a test can await it. Callers in the server ignore it on
       purpose — this must never delay the answer it is riding along with. */
    return forTrack(next.id).catch(() => null);
  }

  return { forTrack, warm, DECODE_RATE, available };
}

module.exports = { createWaveforms };
