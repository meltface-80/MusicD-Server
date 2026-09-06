/*
 * MusicD Server — what a room's queue is, whoever is holding it.
 *
 * WHY THIS EXISTS. Sonos owns its queue: the tracks live on the speaker, it
 * moves between them itself, and reading it back is a Browse. Standard
 * AVTransport has NO QUEUE AT ALL — one URI playing and, on a player that
 * implements it, one URI to play next. A second kind of player therefore does
 * not need a slightly different enqueue; it needs the queue to live somewhere
 * else entirely, and this is the line that decision gets to hide behind.
 *
 * Until that second implementation exists there is exactly one of these, which
 * looks like abstraction for its own sake and is not. The point of doing it
 * FIRST, on its own, is that lib/playback.js also counts plays and drives
 * Random Album Radio — it is the most load-bearing file here, and moving it
 * while nothing else is changing is the difference between a refactor the
 * suite can vouch for and a rewrite nobody can review.
 *
 * WHAT IS NOT HERE: anything about transport. Play, pause, seek-within-a-track
 * and volume are the same actions on any UPnP device and stay on the player.
 * A queue is only the list, and where in it we are.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const didl = require("./didl");

/*
 * How many tracks go onto the queue in one AddMultipleURIsToQueue.
 *
 * The action takes a batch, not a whole library: every URI and every item of
 * metadata travels in one SOAP body, so a large enough batch is a request a
 * player will refuse on size alone. Sixteen is the number the wider Sonos
 * tooling settled on, and it turns a hundred-track selection into seven calls
 * instead of a hundred — which is the whole of the difference between a queue
 * that appears and one that trickles.
 */
const QUEUE_BATCH = 16;

/*
 * THE INTERFACE, stated once so a second implementation has something to be
 * measured against rather than a first implementation to imitate.
 *
 *   list(limit)     -> { items: [{ uri, title, artist }], total }
 *                      What is on the queue, in order, from the top.
 *   length()        -> how many tracks are on it now. Cheaper than list()
 *                      where the protocol offers a count of its own, and it is
 *                      all an append needs in order to know where its first
 *                      track landed.
 *   add(entries)    -> append, in order. An entry is what lib/didl.js needs to
 *                      describe one track: { track, uri, artUri, album,
 *                      albumArtist }. Building that stays with the caller,
 *                      which knows the library; RENDERING it is protocol and
 *                      belongs here.
 *   clear()         -> empty it.
 *   startAt(n, {autoplay}) -> begin playing at 1-based position n, from
 *                      whatever the player was doing before — which may be a
 *                      radio stream rather than this queue at all.
 *   jumpTo(n)       -> move to 1-based position n on a queue already playing.
 *
 * `holds` says whether this queue can be added to at all. A room found by
 * discovery has no queue of its own and none is kept for it here yet, so the
 * honest answer is no — and a caller that asks first gets to say why in a
 * sentence instead of letting a device refuse in UPnP.
 *
 * startAt AND jumpTo ARE NOT THE SAME CALL, however alike they look here.
 * On Sonos, jumpTo is one Seek and startAt has to point the transport at the
 * queue first, because the player may be on something else entirely. A future
 * server-side queue implements both the same way; that it CAN is a fact about
 * that protocol, not a reason to merge them.
 */

/*
 * A ROOM THAT CANNOT BE QUEUED TO YET.
 *
 * Stock UPnP renderers hold no queue, and the server does not hold one for
 * them until 0.4.46. Between discovery arriving and that landing, such a room
 * is real — it is in the picker, its transport and volume work, it reports
 * what it is playing — and asking it to play an album has to fail in words
 * somebody can act on rather than as a UPnP fault from a device that was asked
 * to do something it never claimed it could.
 *
 * It answers list() and length() honestly rather than refusing: "nothing is
 * queued" is true, and a queue screen that says so beats one showing an error.
 */
class NoQueue {
  constructor(player) {
    this.player = player;
  }

  get holds() { return false; }

  async list() { return { items: [], total: 0 }; }
  async length() { return 0; }

  refuse() {
    /*
     * 501, NOT a 500. The difference matters twice over: the server has not
     * broken, and a browser logs a 5xx to its console where a person filing a
     * bug will find it and reasonably assume something crashed. This room was
     * asked for something it cannot do yet, which is exactly what "Not
     * Implemented" is for — and index.js's api() wrapper already honours
     * `status`, so saying so is one line.
     */
    const e = new Error(`MusicD cannot queue music to ${this.player.name} yet. ` +
                        `It can control what is already playing there.`);
    e.status = 501;
    throw e;
  }

  add()     { return this.refuse(); }
  clear()   { return this.refuse(); }
  startAt() { return this.refuse(); }
  jumpTo()  { return this.refuse(); }
}

class SonosQueue {
  /*
   * The speaker holds the list; this is a thin wrapper over saying so.
   *
   * Deliberately not given the household or a zone id: it wraps ONE player,
   * already resolved to a group coordinator by the caller. A queue that could
   * re-resolve which speaker it belongs to is a queue that could quietly
   * change speakers between two calls of the same operation.
   */
  constructor(player) {
    this.player = player;
  }

  get holds() { return true; }

  async list(limit = 200) {
    const browsed = await this.player.browseQueue(0, limit);
    return { items: browsed.items, total: browsed.total };
  }

  /* GetMediaInfo rather than a Browse: the count is all that is wanted, and
     the player answers it without building a document to say so. */
  async length() {
    return (await this.player.mediaInfo()).tracks;
  }

  clear() {
    return this.player.clearQueue();
  }

  /*
   * EVERY TRACK ONTO THE QUEUE, IN AS FEW CALLS AS THE SPEAKER ALLOWS.
   *
   * It used to be one AddURIToQueue per track, awaited in turn, so ten albums
   * was a hundred and twelve round trips one after another — which is exactly
   * what a queue filling itself a few tracks at a time over several seconds
   * looks like. AddMultipleURIsToQueue is the action the Sonos app uses for
   * the same job and takes a batch at a time.
   *
   * WITH THE OLD PATH KEPT AS THE FALLBACK, because this cannot be tried
   * against every player that exists: a speaker that will not accept the
   * batched action must still end up with its queue rather than an error, and
   * a partial batch is undone by clearing nothing — Sonos either takes the
   * whole call or refuses it.
   */
  async add(entries) {
    try {
      for (let at = 0; at < entries.length; at += QUEUE_BATCH) {
        const batch = entries.slice(at, at + QUEUE_BATCH);
        await this.player.addManyToQueue(batch.map(e => e.uri), didl.trackItems(batch));
      }
      return;
    } catch (e) {
      /* Not silent: a player that refuses the batch is worth knowing about,
         and the queue is still filled below. */
      console.warn("[queue] batched enqueue refused (" + e.message +
                   "), adding one at a time");
    }
    for (const entry of entries) {
      await this.player.addToQueue(entry.uri, didl.trackItem(entry.track, entry));
    }
  }

  /*
   * Point the transport at the queue, then go to a position in it.
   *
   * The first half is what jumpTo does not need and this does: until
   * SetAVTransportURI names the queue, the player is still on whatever stream
   * or radio station it was on, and Play would resume THAT instead.
   */
  async startAt(position, { autoplay = true, resetPlayMode = false } = {}) {
    await this.player.setAvTransportUri(this.player.queueUri());
    if (resetPlayMode) await this.player.setPlayMode("NORMAL");
    await this.player.seekTrack(Math.max(1, position));
    if (autoplay) await this.player.play();
  }

  jumpTo(position) {
    return this.player.seekTrack(Math.max(1, Number(position) || 1));
  }

  /*
   * Where in the queue the room is, 1-based.
   *
   * The speaker's own answer, because the speaker is what holds the queue: its
   * GetPositionInfo Track IS the queue position, and the poll has already read
   * it.
   */
  position(pos) { return Math.max(1, (pos && pos.track) || 1); }
}

/*
 * A QUEUE THE SERVER HOLDS, for a room that holds none.
 *
 * Everything Sonos does on the speaker, done here instead: the list is rows in
 * `zone_queue`, the position is a row in `zone_queue_at`, and moving between
 * tracks is this server pointing the device at the next URI.
 *
 * GAPLESS IS THE WHOLE REASON THIS IS HARDER THAN IT LOOKS. Standard
 * AVTransport lets a controller name the track AFTER this one —
 * `SetNextAVTransportURI` — and the device pre-buffers it and crosses over with
 * no stop. The rules that follow from that:
 *
 *   - THE NEXT URI IS ARMED WHEN THIS TRACK STARTS, not when it ends. The poll
 *     runs every few seconds; waiting for the transition means the gap has
 *     already happened.
 *   - ARMING IT AGAIN IS THE POLL'S JOB, because the slot EMPTIES when the
 *     device advances into it. lib/playback.js does that on the track change it
 *     is already watching for.
 *   - A DEVICE THAT CANNOT DO IT STILL PLAYS, one track at a time, with a gap.
 *     `can.SetNextAVTransportURI` says which, read from the device's own
 *     service description at discovery — never assumed.
 */
class ServerQueue {
  /*
   * The zone id, not the player, is what identifies this queue — the rows
   * outlive any particular Renderer object, and a device that was rediscovered
   * on a new address is the same room with the same queue.
   */
  constructor(player, { db, zoneId, entryFor }) {
    this.player = player;
    this.db = db;
    this.zoneId = zoneId;
    /*
     * What a track IS — where its audio and its cover are served from, and
     * what record it came off. The library's business, not this file's, for
     * the same reason SonosQueue is handed entries rather than track ids.
     */
    this.entryFor = entryFor;
  }

  /* The URL alone, where that is all a caller wants. */
  uriFor(trackId) {
    const entry = this.entryFor(trackId);
    return entry ? entry.uri : "";
  }

  /*
   * WHAT TO TELL THE DEVICE ABOUT THE TRACK IT IS ABOUT TO PLAY.
   *
   * Without this a renderer is handed a bare URL and shows whatever it makes
   * of one — usually the file name, often nothing. The `dlna` dialect is the
   * point: no Sonos sentinel, which means nothing here, and a protocolInfo
   * that says byte-range seek is supported, without which a certified renderer
   * may refuse to scrub at all.
   */
  metadataFor(trackId) {
    const entry = this.entryFor(trackId);
    return entry ? didl.trackItem(entry.track, { ...entry, dlna: true }) : "";
  }

  get holds() { return true; }

  /* Does this device let us hand it the next track before this one ends? */
  get gapless() { return !!(this.player.can && this.player.can.SetNextAVTransportURI); }

  rows(limit = 200) {
    return this.db.prepare(
      `SELECT q.position, q.track_id FROM zone_queue q
        WHERE q.zone_id = ? ORDER BY q.position LIMIT ?`).all(this.zoneId, limit);
  }

  /*
   * Shaped exactly like what a Browse returns, because lib/playback.js turns
   * both into the same payload. A queue row names a track this library owns,
   * so the URI is rebuilt rather than stored: `baseUrl()` can change between
   * restarts — SERVER_IP, a new address — and a stored URL would then point
   * somewhere the device cannot reach.
   */
  async list(limit = 200) {
    const rows = this.rows(limit);
    const total = this.db.prepare(
      "SELECT COUNT(*) n FROM zone_queue WHERE zone_id = ?").get(this.zoneId).n;
    return { items: rows.map(r => ({ uri: this.uriFor(r.track_id) })), total };
  }

  async length() {
    return this.db.prepare(
      "SELECT COUNT(*) n FROM zone_queue WHERE zone_id = ?").get(this.zoneId).n;
  }

  async clear() {
    this.db.prepare("DELETE FROM zone_queue WHERE zone_id = ?").run(this.zoneId);
    this.db.prepare("DELETE FROM zone_queue_at WHERE zone_id = ?").run(this.zoneId);
  }

  /*
   * Appended after whatever is already there, in one transaction.
   *
   * A half-written queue is worse than none: the room would play the part that
   * landed and stop, with nothing to say the rest never arrived.
   */
  async add(entries) {
    const at = this.db.prepare(
      "SELECT COALESCE(MAX(position), 0) n FROM zone_queue WHERE zone_id = ?").get(this.zoneId).n;
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO zone_queue (zone_id, position, track_id) VALUES (?, ?, ?)");
    this.db.transaction(() => {
      entries.forEach((entry, i) => insert.run(this.zoneId, at + i + 1, entry.track.id));
    })();
  }

  /* Where the room is now, and where it will be next. */
  at() {
    const row = this.db.prepare(
      "SELECT position FROM zone_queue_at WHERE zone_id = ?").get(this.zoneId);
    return row ? row.position : 1;
  }

  setAt(position) {
    this.db.prepare(
      `INSERT INTO zone_queue_at (zone_id, position) VALUES (?, ?)
       ON CONFLICT(zone_id) DO UPDATE SET position = excluded.position`)
      .run(this.zoneId, Math.max(1, position));
  }

  /*
   * Where in this queue a track is, searching FORWARD from where the room
   * already was.
   *
   * In SQL rather than by pulling the queue into memory: it is an indexed
   * lookup either way, and a JavaScript scan would need a row limit — which is
   * a number that is either too small for a long queue or pointless.
   *
   * The forward search is what makes a queue holding the same track twice
   * resolve to the copy the room is actually on. Falling back to the first
   * copy covers a jump BACKWARDS, which its own app can do.
   */
  positionOf(trackId, from = 1) {
    const ahead = this.db.prepare(
      `SELECT position FROM zone_queue
        WHERE zone_id = ? AND track_id = ? AND position >= ?
        ORDER BY position LIMIT 1`).get(this.zoneId, trackId, from);
    if (ahead) return ahead.position;
    const anywhere = this.db.prepare(
      `SELECT position FROM zone_queue WHERE zone_id = ? AND track_id = ?
        ORDER BY position LIMIT 1`).get(this.zoneId, trackId);
    return anywhere ? anywhere.position : 0;
  }

  trackAt(position) {
    const row = this.db.prepare(
      "SELECT track_id FROM zone_queue WHERE zone_id = ? AND position = ?")
      .get(this.zoneId, position);
    return row ? row.track_id : null;
  }

  /*
   * Start playing at a position — which for a device with no queue is simply
   * "play this URL", plus arming the one after it.
   *
   * The same call as jumpTo() here, and deliberately still two methods: on
   * Sonos they differ, and that this protocol lets them collapse is a fact
   * about the protocol rather than a licence to merge the interface.
   */
  /*
   * Where in the queue the room is, 1-based — and NOT from the device.
   *
   * A renderer playing one URI at a time reports Track as 1 for ever: it has
   * no queue, so it has no position in one. Reading its answer would tell the
   * radio the room was always on the first track, and the radio would then
   * believe a whole album was still to come and never top up.
   *
   * What this queue has recorded is the answer, and the poll keeps it honest
   * by finding the room's real place from what it is playing.
   */
  position() { return this.at(); }

  async startAt(position, { autoplay = true } = {}) {
    return this.playFrom(position, autoplay);
  }

  async jumpTo(position) {
    return this.playFrom(Math.max(1, Number(position) || 1), true);
  }

  async playFrom(position, autoplay) {
    const trackId = this.trackAt(position);
    if (!trackId) throw new Error("Nothing is queued at that position.");
    this.setAt(position);
    await this.player.setAvTransportUri(this.uriFor(trackId), this.metadataFor(trackId));
    if (autoplay) await this.player.play();
    /* ARMED NOW, while this track is only just starting — a whole track of
       warning rather than the few seconds a poll would give. */
    await this.armNext(position);
  }

  /*
   * Hand the device the track after `position`, so it can cross over without
   * stopping.
   *
   * Silent about a device that cannot: `can` was read from its own description
   * and a refusal here would be an error nobody can act on. It plays with a
   * gap, and the room's screen says so.
   */
  async armNext(position) {
    if (!this.gapless) return false;
    const nextId = this.trackAt(position + 1);
    if (!nextId) return false;
    try {
      await this.player.setNextAvTransportUri(this.uriFor(nextId), this.metadataFor(nextId));
      return true;
    } catch (e) {
      /* Not silent: a device that advertised the action and then refused it is
         worth knowing about, and the track still plays — the next one simply
         waits for the poll to notice the transition. */
      console.warn("[queue] " + this.player.name + " refused the next track (" +
                   e.message + ")");
      return false;
    }
  }
}

module.exports = { SonosQueue, ServerQueue, NoQueue, QUEUE_BATCH };
