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
 * startAt AND jumpTo ARE NOT THE SAME CALL, however alike they look here.
 * On Sonos, jumpTo is one Seek and startAt has to point the transport at the
 * queue first, because the player may be on something else entirely. A future
 * server-side queue implements both the same way; that it CAN is a fact about
 * that protocol, not a reason to merge them.
 */

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
}

module.exports = { SonosQueue, QUEUE_BATCH };
