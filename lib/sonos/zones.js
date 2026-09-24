"use strict";
/*
 * zones.js — Sonos rooms and groups, presented the way MusicD Remote's
 * interface already thinks about playback.
 *
 * The interface was written for Roon, whose vocabulary maps onto Sonos
 * cleanly:
 *
 *   Roon zone    = a Sonos GROUP, identified by its coordinator's UID. The
 *                  coordinator owns the queue and the transport, so every
 *                  transport command goes there.
 *   Roon output  = a Sonos ROOM (one player, or a bonded pair / home-theatre
 *                  set). Volume and mute belong to the room.
 *
 * THE QUEUE LIVES ON THE SPEAKER. Tracks are loaded into the coordinator's own
 * Sonos queue and Sonos moves between them itself, which is what makes playback
 * gapless and a skip instant — the bridges' "queue mode". The server never
 * keeps a second copy that could disagree: what is queued is read back from the
 * speaker (ContentDirectory Q:0), and each item's URL says which library track
 * it is. Anything added from the Sonos app shows up here too.
 *
 * State is polled rather than evented: a GetTransportInfo + GetPositionInfo
 * pair per group is a few hundred bytes, every second while someone is
 * looking and every few seconds otherwise. Every change bumps a revision, and
 * /api/zone-state can wait on it instead of being asked forty times a minute.
 */
const EventEmitter = require("events");
const { Topology } = require("./topology");
const { SonosDevice, PLAY_MODES, playModeFor } = require("./device");
const DIDL = require("./didl");
const { PhonePlayers } = require("./phones");

const SONOS_STATE = {
  PLAYING: "playing",
  TRANSITIONING: "loading",
  PAUSED_PLAYBACK: "paused",
  STOPPED: "stopped",
  NO_MEDIA_PRESENT: "stopped"
};

const BATCH = 16;               // AddMultipleURIsToQueue ceiling
const QUEUE_MAX = 1000;         // Sonos' own queue limit
const HOT_MS = 15000;           // a zone someone looked at recently polls fast

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class ZoneManager extends EventEmitter {
  /*
   * opts: { seedHosts, bindIp, include, exclude, log,
   *         trackIdFromUri(uri) -> id|null,
   *         artUrlFor(uri, member) -> absolute url for foreign art }
   */
  constructor(opts = {}) {
    super();
    this.log = opts.log || (() => {});
    this.topology = new Topology(opts);
    this.trackIdFromUri = opts.trackIdFromUri || (() => null);
    this.state = new Map();    // coordinator uid -> zone state
    this.volumes = new Map();  // room uid -> { value, muted, at }
    this.revision = 1;
    this.waiters = new Set();
    this.hot = new Map();      // coordinator uid -> last watched at
    this.timers = [];
    this.stopped = false;
    this.discovered = false;
    this.startedAt = 0;
    // Android phones running the app: zones too (phones.js).
    this.phones = new PhonePlayers(this);
  }

  /* Still looking: the first minute after a start, until the rooms are read.
   * "No rooms found" is only true after that. */
  get searching() {
    return !this.topology.lastRefresh && Date.now() - this.startedAt < 60000;
  }

  // ------------------------------------------------------------ lifecycle

  async start() {
    this.startedAt = Date.now();
    this.loop("discover", 60000, async () => {
      await this.topology.discover();
      this.discovered = true;
      // Found players but no rooms yet (a restart, an update): read the rooms
      // now rather than at the next 30-second refresh.
      if (!this.topology.lastRefresh && await this.topology.refresh()) this.bump();
    }, 0);
    this.loop("topology", 30000, async () => {
      if (await this.topology.refresh()) this.bump();
    }, 1500);
    this.loop("poll", 1000, () => this.pollAll(), 2500);
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    clearInterval(this.phones.sweeper);
  }

  loop(name, every, fn, firstDelay) {
    const run = async () => {
      if (this.stopped) return;
      try { await fn(); } catch (e) { this.log(`[sonos] ${name}: ${e.message}`); }
      if (!this.stopped) this.timers.push(setTimeout(run, every));
    };
    this.timers.push(setTimeout(run, firstDelay));
  }

  /* Re-read topology now (after grouping, or when a client asks). */
  async refreshTopology() {
    if (await this.topology.refresh()) this.bump();
  }

  bump() {
    this.revision++;
    for (const w of this.waiters) w();
    this.waiters.clear();
    this.emit("changed", this.revision);
  }

  waitForChange(sinceRevision, timeoutMs) {
    if (this.revision !== Number(sinceRevision)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); };
      const t = setTimeout(done, timeoutMs);
      this.waiters.add(done);
    });
  }

  watch(zoneId) { if (zoneId) this.hot.set(zoneId, Date.now()); }

  // ---------------------------------------------------------------- polling

  pollTick = 0;

  async pollAll() {
    this.pollTick++;
    const groups = this.topology.groups();
    const now = Date.now();
    await Promise.all(groups.map(async (g) => {
      const id = g.coordinator.uid;
      const hot = now - (this.hot.get(id) || 0) < HOT_MS;
      const st = this.state.get(id);
      const playing = st && st.state === "playing";
      // Fast while watched, or while playing (to notice the queue running out
      // and each track change for history); slow for an idle room nobody is
      // looking at.
      if (!hot && !playing && this.pollTick % 5 !== 0) return;
      await this.pollGroup(g);
      if (hot || this.pollTick % 5 === 0) await this.pollVolumes(g.members);
    }));
    // Forget state for groups that no longer exist.
    const live = new Set(groups.map(g => g.coordinator.uid));
    for (const id of [...this.state.keys()]) if (!live.has(id) && !this.phones.isPhoneId(id)) { this.state.delete(id); this.bump(); }
  }

  async pollGroup(g) {
    const c = new SonosDevice(g.coordinator.ip, g.coordinator.uid, g.coordinator.name);
    let transport, position, settings, media;
    try {
      [transport, position, settings, media] = await Promise.all([
        c.getTransportInfo(), c.getPositionInfo(), c.getTransportSettings(), c.getMediaInfo()
      ]);
    } catch (e) {
      const prev = this.state.get(c.uid);
      if (prev && !prev.unreachable) { prev.unreachable = true; this.bump(); }
      return;
    }
    const prev = this.state.get(c.uid) || {};
    const meta = DIDL.parseItems(position.TrackMetaData || "")[0] || {};
    const trackUri = position.TrackURI || "";
    const onQueue = String(media.CurrentURI || "").startsWith("x-rincon-queue:");
    const mode = PLAY_MODES[settings.PlayMode] || PLAY_MODES.NORMAL;
    const next = {
      state: SONOS_STATE[transport.CurrentTransportState] || "stopped",
      trackUri,
      trackId: this.trackIdFromUri(trackUri),
      trackNumber: Number(position.Track) || 0,
      queueLength: onQueue ? (Number(media.NrTracks) || 0) : 0,
      onQueue,
      position: DIDL.toSeconds(position.RelTime),
      duration: DIDL.toSeconds(position.TrackDuration) || meta.duration || 0,
      title: meta.title || "",
      artist: meta.artist || "",
      album: meta.album || "",
      artUri: meta.artUri ? absolutise(meta.artUri, c.baseUrl) : "",
      streamContent: meta.streamContent || "",
      shuffle: mode.shuffle,
      loop: mode.loop,
      playMode: settings.PlayMode || "NORMAL",
      mediaUri: media.CurrentURI || "",
      at: Date.now(),
      unreachable: false
    };
    this.applyState(c.uid, prev, next);
  }

  /*
   * A zone's new state — from a Sonos poll or a phone's report — and what
   * follows from it: a bump when anything visible changed, "track" when a new
   * one starts, "played" once it has been heard, "queue-low" near the end.
   */
  applyState(uid, prev, next) {
    this.state.set(uid, next);

    const changed = prev.state !== next.state || prev.trackUri !== next.trackUri ||
      prev.trackNumber !== next.trackNumber || prev.queueLength !== next.queueLength ||
      prev.shuffle !== next.shuffle || prev.loop !== next.loop || prev.title !== next.title ||
      prev.unreachable !== next.unreachable ||
      JSON.stringify(prev.volume || null) !== JSON.stringify(next.volume || null) ||
      // A seek or a drift of more than a couple of seconds from the clock.
      Math.abs((prev.position || 0) + (prev.state === "playing" ? (next.at - (prev.at || next.at)) / 1000 : 0) - next.position) > 3;
    if (changed) this.bump();

    // History and radio hooks.
    if (prev.trackUri !== next.trackUri || prev.trackNumber !== next.trackNumber) {
      next.playedLogged = false;
      next.lowFired = false;
      if (next.trackUri) this.emit("track", { zoneId: uid, ...next });
    } else {
      next.playedLogged = prev.playedLogged;
      next.lowFired = prev.lowFired;
    }
    if (next.state === "playing" && !next.playedLogged && next.trackUri &&
        next.position >= Math.min(30, Math.max(5, (next.duration || 60) / 2))) {
      next.playedLogged = true;
      this.emit("played", { zoneId: uid, ...next });
    }
    // On the last track of the queue with the end in sight: time to top up.
    if (next.onQueue && next.state === "playing" && next.loop === "disabled" && !next.lowFired &&
        next.trackNumber > 0 && next.trackNumber >= next.queueLength &&
        next.duration > 0 && next.duration - next.position < 25) {
      next.lowFired = true;
      this.emit("queue-low", { zoneId: uid, ...next });
    }
  }

  async pollVolumes(members) {
    await Promise.all(members.map(async (m) => {
      const d = new SonosDevice(m.ip, m.uid, m.name);
      try {
        const [value, muted] = await Promise.all([d.getVolume(), d.getMute()]);
        const prev = this.volumes.get(m.uid);
        this.volumes.set(m.uid, { value, muted, at: Date.now() });
        if (!prev || prev.value !== value || prev.muted !== muted) this.bump();
      } catch (e) { /* an unreachable room keeps its last known volume */ }
    }));
  }

  // --------------------------------------------------------------- reading

  groupOf(zoneOrOutputId) {
    const groups = this.topology.groups();
    return groups.find(g => g.coordinator.uid === zoneOrOutputId) ||
      groups.find(g => g.members.some(m => m.uid === zoneOrOutputId)) || null;
  }

  coordinator(zoneOrOutputId) {
    const g = this.groupOf(zoneOrOutputId);
    if (!g) return null;
    const c = g.coordinator;
    return new SonosDevice(c.ip, c.uid, c.name);
  }

  displayName(g) {
    const names = g.members.map(m => m.name);
    // The coordinator's name first, as the Sonos app writes a group.
    names.sort((a, b) => (a === g.coordinator.name ? -1 : b === g.coordinator.name ? 1 : a.localeCompare(b)));
    if (names.length <= 2) return names.join(" + ");
    return `${names[0]} + ${names.length - 1}`;
  }

  outputJson(m, g) {
    const v = this.volumes.get(m.uid);
    const all = this.topology.rooms().map(r => r.uid);
    return {
      output_id: m.uid,
      zone_id: g ? g.coordinator.uid : null,
      display_name: m.name,
      model: this.topology.models.get(m.uid) || "",
      stereo_pair: !!m.stereoPair,
      is_muted: v ? v.muted : false,
      volume: {
        type: "number", min: 0, max: 100, step: 1,
        value: v ? v.value : null, soft_limit: 100, is_muted: v ? v.muted : false
      },
      can_group_with_output_ids: all,
      source_controls: []
    };
  }

  zones() {
    return this.topology.groups().map(g => {
      const st = this.state.get(g.coordinator.uid) || {};
      return {
        zone_id: g.coordinator.uid,
        display_name: this.displayName(g),
        state: st.state || "stopped",
        settings: { shuffle: !!st.shuffle, loop: st.loop || "disabled", auto_radio: false },
        outputs: g.members.map(m => this.outputJson(m, g)),
        _state: st,
        _group: g
      };
    }).concat(this.phones.zones()).sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  zone(zoneOrOutputId) {
    if (this.phones.has(zoneOrOutputId)) return this.phones.zones().find(z => z.zone_id === zoneOrOutputId) || null;
    const g = zoneOrOutputId ? this.groupOf(zoneOrOutputId) : null;
    if (!g) return null;
    return this.zones().find(z => z.zone_id === g.coordinator.uid) || null;
  }

  outputs() {
    const groups = this.topology.groups();
    return this.topology.rooms().map(m => {
      const g = groups.find(x => x.members.some(y => y.uid === m.uid));
      return Object.assign(this.outputJson(m, g), { zone_name: g ? this.displayName(g) : "" });
    }).sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  /* Position now, not when the speaker was last asked. */
  positionNow(st) {
    if (!st) return 0;
    if (st.state !== "playing") return st.position || 0;
    const p = (st.position || 0) + (Date.now() - st.at) / 1000;
    return st.duration ? Math.min(p, st.duration) : p;
  }

  async queue(zoneId) {
    if (this.phones.isPhoneId(zoneId)) return this.phones.queue(zoneId);
    const c = this.coordinator(zoneId);
    if (!c) return { items: [], total: 0, current: 0 };
    const st = this.state.get(c.uid) || {};
    const r = await c.browseQueue(0, QUEUE_MAX);
    return {
      items: r.items.map((it, i) => ({
        position: i + 1,
        uri: it.uri,
        trackId: this.trackIdFromUri(it.uri),
        title: it.title, artist: it.artist, album: it.album,
        artUri: it.artUri ? absolutise(it.artUri, c.baseUrl) : "",
        duration: it.duration
      })),
      total: r.total,
      current: st.onQueue ? st.trackNumber : 0
    };
  }

  // --------------------------------------------------------------- writing

  async pokeAfter(zoneId) {
    // Read the speaker back promptly so the page sees the result of a command
    // without waiting for the next poll.
    const g = this.groupOf(zoneId);
    if (!g) return;
    await sleep(250);
    await this.pollGroup(g).catch(() => {});
  }

  /*
   * Put tracks on a zone.
   *   items: [{ uri, meta }]
   *   how:   "play_now" (replace the queue and play), "add_next" (after the
   *          current track), "queue" (at the end; starts playback if idle).
   *   startAt: 0-based index into items to start from (play_now only).
   */
  async enqueue(zoneId, items, how = "play_now", { startAt = 0, seconds = 0 } = {}) {
    if (this.phones.isPhoneId(zoneId)) return this.phones.enqueue(zoneId, items, how, { startAt, seconds });
    const c = this.coordinator(zoneId);
    if (!c) throw new Error("That room isn't available");
    if (!items.length) throw new Error("Nothing to play");
    items = items.slice(0, QUEUE_MAX);
    // Where the speaker is NOW, not at the last poll: "play next" straight
    // after "play now" must count from the track that has just started.
    const g = this.groupOf(c.uid);
    if (how !== "play_now" && g) await this.pollGroup(g).catch(() => {});
    const st = this.state.get(c.uid) || {};

    if (how === "play_now") {
      await c.clearQueue();
      // The track that starts goes first on its own so the speaker can begin
      // while the rest load: a 30-track album should not be a visible wait.
      const first = Math.max(0, Math.min(items.length - 1, startAt));
      await this.addBatch(c, items.slice(0, first + 1), 0);
      await c.setAVTransportURI(c.queueUri());
      await c.seekTrack(first + 1);
      if (seconds > 0) await c.seekTime(seconds).catch(() => {});
      await c.play();
      if (items.length > first + 1) await this.addBatch(c, items.slice(first + 1), 0);
    } else if (how === "add_next") {
      const at = st.onQueue && st.trackNumber ? st.trackNumber + 1 : 0;
      await this.addBatch(c, items, at);
      if (!st.onQueue || st.state === "stopped") {
        if (!st.onQueue) await c.setAVTransportURI(c.queueUri());
        if (st.state !== "playing") {
          await c.seekTrack(at || 1).catch(() => {});
          await c.play();
        }
      }
    } else {
      const before = st.onQueue ? st.queueLength : 0;
      if (!st.onQueue) await c.clearQueue();
      await this.addBatch(c, items, 0);
      if (!st.onQueue || st.state === "stopped") {
        await c.setAVTransportURI(c.queueUri());
        await c.seekTrack((st.onQueue ? before : 0) + 1).catch(() => {});
        await c.play();
      }
    }
    this.pokeAfter(c.uid);
    return { queued: items.length };
  }

  async addBatch(c, items, position) {
    let at = position;
    for (let i = 0; i < items.length; i += BATCH) {
      const chunk = items.slice(i, i + BATCH);
      try {
        await c.addMultipleToQueue(chunk, at, false);
      } catch (e) {
        // Older firmware without the batch verb: one at a time.
        for (let j = 0; j < chunk.length; j++) {
          await c.addToQueue(chunk[j].uri, chunk[j].meta, at ? at + j : 0, false);
        }
      }
      if (at) at += chunk.length;
    }
  }

  async control(zoneId, command) {
    if (this.phones.isPhoneId(zoneId)) return this.phones.control(zoneId, command);
    const c = this.coordinator(zoneId);
    if (!c) throw new Error("That room isn't available");
    const st = this.state.get(c.uid) || {};
    switch (command) {
      case "play": await c.play(); break;
      case "pause": await c.pause(); break;
      case "stop": await c.stop(); break;
      case "next": await c.next(); break;
      case "previous":
        // Back to the start of this track first, as every player does.
        if (this.positionNow(st) > 5) await c.seekTime(0);
        else await c.previous();
        break;
      case "playpause":
        if (st.state === "playing" || st.state === "loading") await c.pause(); else await c.play();
        break;
      default: throw new Error("unknown command " + command);
    }
    this.pokeAfter(c.uid);
  }

  async seek(zoneId, how, seconds) {
    if (this.phones.isPhoneId(zoneId)) return this.phones.seek(zoneId, how, seconds);
    const c = this.coordinator(zoneId);
    if (!c) throw new Error("That room isn't available");
    const st = this.state.get(c.uid) || {};
    const target = how === "relative" ? this.positionNow(st) + Number(seconds) : Number(seconds);
    await c.seekTime(Math.max(0, target));
    if (st) { st.position = Math.max(0, target); st.at = Date.now(); }
    this.bump();
    this.pokeAfter(c.uid);
  }

  async playFromHere(zoneId, position) {
    if (this.phones.isPhoneId(zoneId)) return this.phones.playFromHere(zoneId, position);
    const c = this.coordinator(zoneId);
    if (!c) throw new Error("That room isn't available");
    const st = this.state.get(c.uid) || {};
    if (!st.onQueue) await c.setAVTransportURI(c.queueUri());
    await c.seekTrack(position);
    await c.play();
    this.pokeAfter(c.uid);
  }

  async removeFromQueue(zoneId, position) {
    if (this.phones.isPhoneId(zoneId)) return this.phones.removeFromQueue(zoneId, position);
    const c = this.coordinator(zoneId);
    if (!c) throw new Error("That room isn't available");
    await c.removeTrackFromQueue(position);
    this.pokeAfter(c.uid);
  }

  async clearQueue(zoneId) {
    if (this.phones.isPhoneId(zoneId)) return this.phones.clearQueue(zoneId);
    const c = this.coordinator(zoneId);
    if (!c) throw new Error("That room isn't available");
    await c.clearQueue();
    this.pokeAfter(c.uid);
  }

  async setSettings(zoneId, { shuffle, loop }) {
    if (this.phones.isPhoneId(zoneId)) return this.phones.setSettings(zoneId, { shuffle, loop });
    const c = this.coordinator(zoneId);
    if (!c) throw new Error("That room isn't available");
    const st = this.state.get(c.uid) || {};
    const mode = playModeFor(shuffle == null ? st.shuffle : shuffle, loop == null ? (st.loop || "disabled") : loop);
    await c.setPlayMode(mode);
    this.pokeAfter(c.uid);
  }

  async setVolume(outputId, how, value) {
    if (this.phones.isPhoneId(outputId)) return this.phones.setVolume(outputId, how, value);
    const m = this.topology.member(outputId);
    if (!m) throw new Error("That room isn't available");
    const d = new SonosDevice(m.ip, m.uid, m.name);
    const v = this.volumes.get(m.uid) || { value: 0, muted: false };
    let target;
    if (how === "relative" || how === "relative_step") {
      target = Math.max(0, Math.min(100, (v.value || 0) + Number(value)));
    } else {
      target = Math.max(0, Math.min(100, Number(value)));
    }
    await d.setVolume(target);
    this.volumes.set(m.uid, { value: target, muted: v.muted, at: Date.now() });
    this.bump();
  }

  async setMute(outputId, muted) {
    if (this.phones.isPhoneId(outputId)) return this.phones.setMute(outputId, muted);
    const m = this.topology.member(outputId);
    if (!m) throw new Error("That room isn't available");
    await new SonosDevice(m.ip, m.uid, m.name).setMute(!!muted);
    const v = this.volumes.get(m.uid) || { value: null };
    this.volumes.set(m.uid, { value: v.value, muted: !!muted, at: Date.now() });
    this.bump();
  }

  async pauseAll() {
    this.phones.pauseAll();
    await Promise.all(this.topology.groups().map(g =>
      new SonosDevice(g.coordinator.ip, g.coordinator.uid).pause().catch(() => {})));
    this.bump();
  }

  /* The first output becomes (or stays) the coordinator; the rest join it. */
  async group(outputIds) {
    if (outputIds.some(id => this.phones.isPhoneId(id))) throw new Error("A phone plays on its own — it can't be grouped with Sonos rooms");
    const [lead, ...rest] = outputIds;
    const leadMember = this.topology.member(lead);
    if (!leadMember) throw new Error("That room isn't available");
    // If the lead is currently a member of someone else's group, it keeps its
    // audio only by staying where it is — Sonos can only join rooms TO a
    // coordinator — so use its coordinator as the anchor.
    const coord = this.topology.coordinatorOf(lead) || leadMember;
    for (const id of rest) {
      const m = this.topology.member(id);
      if (!m || m.uid === coord.uid) continue;
      await new SonosDevice(m.ip, m.uid, m.name).joinGroup(coord.uid);
    }
    await sleep(500);
    await this.refreshTopology();
  }

  async ungroup(outputIds) {
    outputIds = outputIds.filter(id => !this.phones.isPhoneId(id));
    for (const id of outputIds) {
      const m = this.topology.member(id);
      if (!m) continue;
      await new SonosDevice(m.ip, m.uid, m.name).becomeStandalone().catch(() => {});
    }
    await sleep(500);
    await this.refreshTopology();
  }

  /*
   * Move what is playing to another room: copy the queue, pick up at the same
   * track and second, then stop the old room.
   */
  async transfer(fromZone, toZone) {
    // To or from a phone: the same idea, with the phone's queue on one side.
    if (this.phones.isPhoneId(fromZone) || this.phones.isPhoneId(toZone)) {
      if (fromZone === toZone) return;
      let items, st;
      if (this.phones.isPhoneId(fromZone)) {
        items = this.phones.itemsFor(fromZone);
        st = this.state.get(fromZone) || {};
      } else {
        const from = this.coordinator(fromZone);
        if (!from) throw new Error("That room isn't available");
        st = this.state.get(from.uid) || {};
        const q = await from.browseQueue(0, QUEUE_MAX);
        items = q.items.map(it => ({
          uri: it.uri,
          meta: DIDL.build(it.uri, { title: it.title, artist: it.artist, album: it.album, artUri: it.artUri, duration: it.duration, mime: mimeFromUri(it.uri) })
        }));
      }
      if (!items.length) throw new Error("Nothing is queued there");
      const startAt = Math.max(0, (st.trackNumber || 1) - 1);
      await this.enqueue(toZone, items, "play_now", { startAt, seconds: this.positionNow(st) });
      await this.control(fromZone, "stop").catch(() => {});
      return;
    }
    const from = this.coordinator(fromZone);
    const to = this.coordinator(toZone);
    if (!from || !to) throw new Error("That room isn't available");
    if (from.uid === to.uid) return;
    const st = this.state.get(from.uid) || {};
    const q = await from.browseQueue(0, QUEUE_MAX);
    if (!q.items.length) throw new Error("Nothing is queued in that room");
    // Re-use the DIDL from our own library where we can, so the new room gets
    // the same artwork and metadata.
    const items = q.items.map(it => ({
      uri: it.uri,
      meta: DIDL.build(it.uri, { title: it.title, artist: it.artist, album: it.album, artUri: it.artUri, duration: it.duration, mime: mimeFromUri(it.uri) })
    }));
    const startAt = Math.max(0, (st.trackNumber || 1) - 1);
    await this.enqueue(to.uid, items, "play_now", { startAt, seconds: this.positionNow(st) });
    await from.stop().catch(() => {});
    this.pokeAfter(from.uid);
  }
}

function absolutise(uri, base) {
  if (!uri) return "";
  if (/^https?:\/\//i.test(uri)) return uri;
  return base + (uri.startsWith("/") ? uri : "/" + uri);
}

function mimeFromUri(uri) {
  const ext = (String(uri).split("?")[0].match(/\.([a-z0-9]+)$/i) || [])[1] || "";
  return {
    flac: "audio/flac", mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac",
    wav: "audio/wav", aif: "audio/aiff", aiff: "audio/aiff", ogg: "audio/ogg"
  }[ext.toLowerCase()] || "audio/flac";
}

module.exports = { ZoneManager, absolutise, mimeFromUri, SONOS_STATE };
