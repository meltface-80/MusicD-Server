"use strict";
/*
 * phones.js — an Android phone running the MusicD app, as one more zone.
 *
 * The phone plays through its own speaker or headphones (Media3/ExoPlayer in
 * the app), and to everything else — the web interface, the zone picker, the
 * queue tab, history, Random Album Radio — it is simply another room. That is
 * why it lives here beside the Sonos zones rather than anywhere new: every
 * screen that works for a Sonos room works for the phone unchanged, from the
 * phone itself or from any other device.
 *
 * The server keeps the phone's queue and sends it COMMANDS (load, insert,
 * play, pause, seek…) that the app collects with a long poll; the app reports
 * back what it is actually doing (which track, where, playing or not). That
 * report becomes the zone's state, the same shape a Sonos poll produces, and
 * goes through the same hooks: "played" for history, "queue-low" for radio.
 *
 * A phone is a zone only while its app is connected: it disappears ~45 s after
 * the app stops asking for commands (closed, off the network).
 */
const DIDL = require("./didl");

const PRESENT_MS = 45000;
const KEEP_COMMANDS = 200;

class PhonePlayers {
  constructor(zm) {
    this.zm = zm;
    this.map = new Map();   // uid -> { uid, deviceId, name, queue, commands, lastSeen, waiters }
    this.seq = 0;
    this.sweeper = setInterval(() => this.sweep(), 10000);
    this.sweeper.unref();
  }

  static uidFor(deviceId) { return "PHONE_" + deviceId; }

  isPhoneId(id) { return String(id || "").startsWith("PHONE_"); }
  present(p) { return !!p && Date.now() - p.lastSeen < PRESENT_MS; }
  has(id) { return this.present(this.map.get(String(id || ""))); }
  get(id) {
    const p = this.map.get(String(id || ""));
    if (!this.present(p)) { const e = new Error("That phone isn't connected — open the MusicD app on it"); e.status = 409; throw e; }
    return p;
  }

  sweep() {
    let changed = false;
    for (const p of this.map.values()) {
      if (!this.present(p) && !p.gone) { p.gone = true; changed = true; }
    }
    if (changed) this.zm.bump();
  }

  // ------------------------------------------------------------ the app

  /* The app has (re)started: a fresh, empty player. */
  hello(deviceId, name) {
    const uid = PhonePlayers.uidFor(deviceId);
    const p = this.map.get(uid) || { uid, deviceId, commands: [], waiters: new Set() };
    p.name = String(name || "Phone").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60) || "Phone";
    p.queue = [];
    p.commands = [];
    p.lastSeen = Date.now();
    p.gone = false;
    this.map.set(uid, p);
    const prev = this.zm.state.get(uid) || {};
    this.zm.state.set(uid, blankState(prev.volume));
    this.zm.bump();
    return { zone_id: uid, seq: this.seq };
  }

  /* Commands after `after`, waiting up to `timeoutMs` for one to arrive. */
  async commands(uid, after, timeoutMs) {
    const p = this.map.get(uid);
    if (!p) { const e = new Error("Say hello first"); e.status = 409; throw e; }
    const wasGone = !this.present(p);
    p.lastSeen = Date.now();
    if (wasGone) { p.gone = false; this.zm.bump(); }
    const pending = () => p.commands.filter(c => c.seq > after);
    if (!pending().length && timeoutMs > 0) {
      await new Promise((resolve) => {
        const t = setTimeout(done, timeoutMs);
        function done() { clearTimeout(t); p.waiters.delete(done); resolve(); }
        p.waiters.add(done);
      });
      p.lastSeen = Date.now();
    }
    // Missed some (the list was trimmed): start again from a full picture.
    if (after > 0 && p.commands.length && p.commands[0].seq > after + 1) {
      return { seq: this.seq, commands: [Object.assign({ seq: this.seq, op: "sync" }, this.snapshot(p))] };
    }
    return { seq: this.seq, commands: pending() };
  }

  /* What the app says it is doing. */
  report(uid, r) {
    const p = this.map.get(uid);
    if (!p) return;
    p.lastSeen = Date.now();
    const count = p.queue.length;
    const index = Number.isInteger(r.index) && r.index >= 0 && r.index < count ? r.index : -1;
    const item = index >= 0 ? p.queue[index] : null;
    const prev = this.zm.state.get(uid) || blankState();
    const next = Object.assign(blankState(), {
      state: ["playing", "paused", "loading", "stopped"].includes(r.state) ? r.state : "stopped",
      trackUri: item ? item.uri : "",
      trackId: item ? item.trackId : null,
      trackNumber: item ? index + 1 : 0,
      queueLength: count,
      onQueue: count > 0,
      position: Math.max(0, Number(r.position) || 0),
      duration: Number(r.duration) || (item ? item.duration : 0) || 0,
      title: item ? item.title : "",
      artist: item ? item.artist : "",
      album: item ? item.album : "",
      artUri: item ? item.artUri : "",
      shuffle: !!r.shuffle,
      loop: ["disabled", "loop", "loop_one"].includes(r.loop) ? r.loop : "disabled",
      volume: {
        value: Number.isFinite(Number(r.volume)) ? Math.max(0, Math.min(100, Math.round(Number(r.volume)))) : (prev.volume || {}).value,
        muted: !!r.muted
      },
      at: Date.now()
    });
    this.zm.applyState(uid, prev, next);
  }

  // ------------------------------------------------------------ zones

  zones() {
    const out = [];
    for (const p of this.map.values()) {
      if (!this.present(p)) continue;
      const st = this.zm.state.get(p.uid) || blankState();
      out.push({
        zone_id: p.uid,
        display_name: p.name,
        state: st.state || "stopped",
        settings: { shuffle: !!st.shuffle, loop: st.loop || "disabled", auto_radio: false },
        outputs: [this.outputJson(p, st)],
        is_phone: true,
        device_id: p.deviceId,
        _state: st,
        _group: null
      });
    }
    return out;
  }

  outputJson(p, st) {
    const v = st.volume || {};
    return {
      output_id: p.uid,
      zone_id: p.uid,
      display_name: p.name,
      model: "Phone",
      stereo_pair: false,
      is_muted: !!v.muted,
      volume: { type: "number", min: 0, max: 100, step: 1, value: v.value == null ? null : v.value, soft_limit: 100, is_muted: !!v.muted },
      can_group_with_output_ids: [p.uid],
      source_controls: []
    };
  }

  queue(uid) {
    const p = this.get(uid);
    const st = this.zm.state.get(uid) || {};
    return {
      items: p.queue.map((it, i) => ({
        position: i + 1, uri: it.uri, trackId: it.trackId, title: it.title, artist: it.artist,
        album: it.album, artUri: it.artUri, duration: it.duration
      })),
      total: p.queue.length,
      current: st.trackNumber || 0
    };
  }

  // ------------------------------------------------------------ commands

  push(p, cmd) {
    cmd.seq = ++this.seq;
    p.commands.push(cmd);
    if (p.commands.length > KEEP_COMMANDS) p.commands.splice(0, p.commands.length - KEEP_COMMANDS);
    for (const w of [...p.waiters]) w();
  }

  // Straight away, before the phone reports back, so the page doesn't lag.
  optimistic(uid, patch) {
    const st = this.zm.state.get(uid);
    if (!st) return;
    Object.assign(st, patch, { at: Date.now() });
    this.zm.bump();
  }

  snapshot(p) {
    const st = this.zm.state.get(p.uid) || {};
    return {
      items: p.queue.map(publicItem),
      index: Math.max(0, (st.trackNumber || 1) - 1),
      seconds: this.zm.positionNow(st),
      play: st.state === "playing"
    };
  }

  // Items arrive as the Sonos code builds them — { uri, meta, track? } — and
  // the phone needs plain fields.
  toItem(it) {
    if (it.phone) return it.phone;
    const m = DIDL.parseItems(it.meta || "")[0] || {};
    const t = it.track;
    return {
      uri: it.uri,
      trackId: t ? t.id : this.zm.trackIdFromUri(it.uri),
      title: m.title || (t && t.title) || "",
      artist: m.artist || (t && t.artist) || "",
      album: m.album || (t && t.album) || "",
      artUri: m.artUri || "",
      duration: m.duration || (t && t.duration) || 0
    };
  }

  enqueue(uid, items, how, { startAt = 0, seconds = 0 } = {}) {
    const p = this.get(uid);
    const list = items.map(it => this.toItem(it));
    if (!list.length) throw new Error("Nothing to play");
    const st = this.zm.state.get(uid) || {};
    const idle = !p.queue.length || st.state === "stopped";
    if (how === "play_now" || (how !== "queue" && idle && !p.queue.length)) {
      p.queue = list;
      const index = Math.max(0, Math.min(list.length - 1, startAt));
      this.push(p, { op: "load", items: list.map(publicItem), index, seconds: Number(seconds) || 0, play: true });
      this.optimistic(uid, { state: "loading", trackNumber: index + 1, queueLength: list.length, onQueue: true,
        trackUri: list[index].uri, trackId: list[index].trackId, title: list[index].title, artist: list[index].artist,
        album: list[index].album, artUri: list[index].artUri, duration: list[index].duration, position: Number(seconds) || 0 });
    } else if (how === "add_next") {
      const at = Math.min(p.queue.length, st.trackNumber || 0);
      p.queue.splice(at, 0, ...list);
      this.push(p, { op: "insert", at, items: list.map(publicItem), play: idle });
      this.optimistic(uid, { queueLength: p.queue.length, onQueue: true });
    } else {
      const at = p.queue.length;
      p.queue.push(...list);
      this.push(p, { op: "insert", at, items: list.map(publicItem), play: idle });
      this.optimistic(uid, { queueLength: p.queue.length, onQueue: true });
    }
    return { queued: list.length };
  }

  control(uid, command) {
    const p = this.get(uid);
    const st = this.zm.state.get(uid) || {};
    let cmd = command;
    if (cmd === "playpause") cmd = (st.state === "playing" || st.state === "loading") ? "pause" : "play";
    if (!["play", "pause", "stop", "next", "previous"].includes(cmd)) throw new Error("unknown command " + command);
    this.push(p, { op: cmd });
    if (cmd === "play") this.optimistic(uid, { state: "playing", position: this.zm.positionNow(st) });
    if (cmd === "pause" || cmd === "stop") this.optimistic(uid, { state: cmd === "stop" ? "stopped" : "paused", position: this.zm.positionNow(st) });
  }

  seek(uid, how, seconds) {
    const p = this.get(uid);
    const st = this.zm.state.get(uid) || {};
    const target = Math.max(0, how === "relative" ? this.zm.positionNow(st) + Number(seconds) : Number(seconds));
    this.push(p, { op: "seek", seconds: target });
    this.optimistic(uid, { position: target });
  }

  playFromHere(uid, position) {
    const p = this.get(uid);
    const index = Math.max(0, Math.min(p.queue.length - 1, Number(position) - 1));
    this.push(p, { op: "jump", index });
    const it = p.queue[index];
    if (it) this.optimistic(uid, { state: "loading", trackNumber: index + 1, trackUri: it.uri, trackId: it.trackId, title: it.title, position: 0 });
  }

  removeFromQueue(uid, position) {
    const p = this.get(uid);
    const index = Number(position) - 1;
    if (index < 0 || index >= p.queue.length) return;
    p.queue.splice(index, 1);
    this.push(p, { op: "remove", index });
    this.optimistic(uid, { queueLength: p.queue.length });
  }

  clearQueue(uid) {
    const p = this.get(uid);
    p.queue = [];
    this.push(p, { op: "clear" });
    this.optimistic(uid, blankState((this.zm.state.get(uid) || {}).volume));
  }

  setSettings(uid, { shuffle, loop }) {
    const p = this.get(uid);
    const st = this.zm.state.get(uid) || {};
    const next = { shuffle: shuffle == null ? !!st.shuffle : !!shuffle, loop: loop == null ? (st.loop || "disabled") : loop };
    this.push(p, { op: "mode", shuffle: next.shuffle, loop: next.loop });
    this.optimistic(uid, next);
  }

  setVolume(uid, how, value) {
    const p = this.get(uid);
    const st = this.zm.state.get(uid) || {};
    const cur = (st.volume && st.volume.value) || 0;
    const target = Math.max(0, Math.min(100, Math.round(how === "relative" || how === "relative_step" ? cur + Number(value) : Number(value))));
    this.push(p, { op: "volume", value: target });
    this.optimistic(uid, { volume: { value: target, muted: !!(st.volume && st.volume.muted) } });
  }

  setMute(uid, muted) {
    const p = this.get(uid);
    const st = this.zm.state.get(uid) || {};
    this.push(p, { op: "mute", muted: !!muted });
    this.optimistic(uid, { volume: { value: st.volume ? st.volume.value : null, muted: !!muted } });
  }

  pauseAll() {
    for (const p of this.map.values()) if (this.present(p)) this.push(p, { op: "pause" });
  }

  /* The queue as Sonos-style items, for moving what's playing elsewhere. */
  itemsFor(uid) {
    const p = this.get(uid);
    return p.queue.map(it => ({
      uri: it.uri, phone: it,
      meta: DIDL.build(it.uri, { title: it.title, artist: it.artist, album: it.album, artUri: it.artUri, duration: it.duration })
    }));
  }
}

function blankState(volume) {
  return {
    state: "stopped", trackUri: "", trackId: null, trackNumber: 0, queueLength: 0, onQueue: false,
    position: 0, duration: 0, title: "", artist: "", album: "", artUri: "", streamContent: "",
    shuffle: false, loop: "disabled", playMode: "NORMAL", mediaUri: "", at: Date.now(), unreachable: false,
    volume: volume || { value: null, muted: false }
  };
}

// What the app is sent for each track.
function publicItem(it) {
  return {
    url: it.uri, track_id: it.trackId, title: it.title, artist: it.artist,
    album: it.album, art_url: it.artUri, duration: it.duration
  };
}

module.exports = { PhonePlayers, PRESENT_MS };
