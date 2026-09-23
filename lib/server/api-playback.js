"use strict";
/*
 * api-playback.js — rooms, transport, volume, the queue, and putting albums
 * and tracks on a speaker. Shapes follow MusicD Remote's /api, which was
 * written against Roon's zone model; zones.js maps Sonos onto it.
 */
const { normaliseKind } = require("./playback");
const { Artwork } = require("../library/artwork");
const N = require("../library/normalize");

module.exports = function mountPlayback(app, ctx) {
  const { zones, library, playback, features } = ctx;

  const need = (v, msg) => { if (v === undefined || v === null || v === "") { const e = new Error(msg); e.status = 400; throw e; } return v; };
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { res.status(e.status || 500).json({ error: e.message || String(e) }); }
  };

  // What the page draws for a zone's current track.
  function nowPlaying(z) {
    const st = z._state || {};
    if (!st.trackUri && !st.title) return null;
    const t = st.trackId ? library.track(st.trackId) : null;
    const al = t ? library.album(t.album_id) : null;
    const line1 = (t && t.title) || st.title || st.streamContent || "";
    const line2 = (t && t.artist) || st.artist || "";
    const line3 = (al && al.title) || st.album || "";
    const image_key = al ? al.image_key : (st.artUri ? Artwork.foreignKey(st.artUri) : null);
    return {
      line1, line2, line3,
      artists: N.splitArtists(line2).map(name => ({ name, linkable: library.artistKeys.has(N.fold(name)) })),
      image_key,
      length: st.duration || (t && Math.round(t.duration)) || null,
      seek_position: Math.round(zones.positionNow(st)),
      // Not in Roon's shape: what the speaker is actually being sent, for the
      // format line on Now playing.
      track_id: t ? t.id : null,
      album_offset: al ? al.id : null
    };
  }

  function zoneJson(z) {
    const st = z._state || {};
    const onQueue = !!st.onQueue;
    return {
      zone_id: z.zone_id,
      display_name: z.display_name,
      state: st.state || "stopped",
      is_play_allowed: st.state !== "playing",
      is_pause_allowed: st.state === "playing" || st.state === "loading",
      is_next_allowed: onQueue ? (st.trackNumber < st.queueLength || st.loop !== "disabled" || st.shuffle) : false,
      is_previous_allowed: onQueue || !!st.trackUri,
      is_seek_allowed: !!st.duration,
      settings: z.settings,
      outputs: z.outputs.map(o => ({
        output_id: o.output_id, display_name: o.display_name, is_muted: o.is_muted, volume: o.volume
      })),
      now_playing: nowPlaying(z)
    };
  }

  app.get("/api/zones", (req, res) => {
    res.json({
      zones: zones.zones().map(z => ({
        zone_id: z.zone_id, display_name: z.display_name, state: z.state,
        settings: z.settings, outputs: z.outputs
      }))
    });
  });

  app.get("/api/outputs", (req, res) => res.json({ outputs: zones.outputs() }));
  app.get("/api/shortcut/zones", (req, res) => res.json({
    zones: zones.zones().map(z => ({ zone_id: z.zone_id, display_name: z.display_name, state: z.state }))
  }));

  /*
   * Zone state, optionally waited for: with ?wait_for=<revision> it answers the
   * moment something changes (or after ~20s), so a page can hold one request
   * open instead of polling.
   */
  app.get("/api/zone-state", wrap(async (req, res) => {
    const zoneId = String(req.query.zone || "");
    zones.watch(zones.groupOf(zoneId) ? zones.groupOf(zoneId).coordinator.uid : zoneId);
    if (req.query.wait_for !== undefined) {
      const timeout = Math.max(0, Math.min(25000, Number(req.query.timeout) || 20000));
      await zones.waitForChange(Number(req.query.wait_for), timeout);
    }
    const revision = zones.revision;
    const z = zoneId ? zones.zone(zoneId) : null;
    if (!z) return res.json({ zone: null, revision });
    res.json({ revision, zone: zoneJson(z) });
  }));

  app.get("/api/queue", wrap(async (req, res) => {
    const zoneId = need(req.query.zone, "zone required");
    const q = await zones.queue(zoneId);
    const row = (it) => {
      const t = it.trackId ? library.track(it.trackId) : null;
      const al = t ? library.album(t.album_id) : null;
      return {
        queue_item_id: it.position,
        title: (t && t.title) || it.title || "",
        subtitle: (t && t.artist) || it.artist || "",
        album: (al && al.title) || it.album || "",
        image_key: al ? al.image_key : (it.artUri ? Artwork.foreignKey(it.artUri) : null),
        length: Math.round((t && t.duration) || it.duration || 0) || null
      };
    };
    // Sonos keeps played tracks in its queue; they ARE the history. Upcoming
    // starts at the current track, as Roon's queue does.
    const cur = q.current || 1;
    const items = q.current ? q.items.slice(cur - 1).map(row) : q.items.map(row);
    const history = q.current ? q.items.slice(0, cur - 1).reverse().map(it => {
      const r = row(it);
      return {
        track: r.title, artist: r.subtitle, album: r.album, image_key: r.image_key,
        duration: r.length || 0, elapsed: r.length || 0, played: true, queue_item_id: it.position
      };
    }) : [];
    res.json({ items, history });
  }));

  app.post("/api/control", wrap(async (req, res) => {
    const { zone_or_output_id, command } = req.body || {};
    need(zone_or_output_id, "zone_or_output_id required");
    const allowed = ["play", "pause", "playpause", "stop", "previous", "next"];
    if (!allowed.includes(command)) return res.status(400).json({ error: "invalid command, allowed: " + allowed.join(", ") });
    // Play on an idle room with an empty queue: something to play is better
    // than nothing happening, and Random Album Radio is what that means here.
    const z = zones.zone(zone_or_output_id);
    const st = z && z._state;
    if ((command === "play" || command === "playpause") && st && !st.trackUri && !(st.queueLength > 0)) {
      await features.radioTopUp(z.zone_id, true);
      return res.json({ ok: true, started: "random-album" });
    }
    await zones.control(zone_or_output_id, command);
    res.json({ ok: true });
  }));

  app.post("/api/seek", wrap(async (req, res) => {
    const { zone_or_output_id, how, seconds } = req.body || {};
    need(zone_or_output_id, "zone_or_output_id required");
    if (!Number.isFinite(Number(seconds))) return res.status(400).json({ error: "seconds required" });
    await zones.seek(zone_or_output_id, how === "relative" ? "relative" : "absolute", Number(seconds));
    res.json({ ok: true });
  }));

  app.post("/api/volume", wrap(async (req, res) => {
    const b = req.body || {};
    let targets = [];
    if (b.output_id) targets = [b.output_id];
    else {
      const z = zones.zone(need(b.zone_or_output_id, "output_id or zone_or_output_id required"));
      if (!z) return res.status(404).json({ error: "That room isn't available" });
      targets = z.outputs.map(o => o.output_id);
    }
    if (b.mute !== undefined) {
      for (const id of targets) await zones.setMute(id, !!b.mute);
      return res.json({ ok: true });
    }
    const value = Number(b.value);
    if (!Number.isFinite(value)) return res.status(400).json({ error: "value is required" });
    for (const id of targets) await zones.setVolume(id, b.how || "absolute", value);
    res.json({ ok: true });
  }));

  app.post("/api/zone-settings", wrap(async (req, res) => {
    const b = req.body || {};
    need(b.zone_or_output_id, "zone_or_output_id required");
    const patch = {};
    if (b.shuffle !== undefined) patch.shuffle = !!b.shuffle;
    if (b.loop !== undefined) {
      if (!["disabled", "loop", "loop_one"].includes(b.loop)) return res.status(400).json({ error: "loop must be disabled, loop or loop_one" });
      patch.loop = b.loop;
    }
    if (!Object.keys(patch).length && b.auto_radio === undefined) return res.status(400).json({ error: "nothing to change" });
    if (Object.keys(patch).length) await zones.setSettings(b.zone_or_output_id, patch);
    res.json({ ok: true, random_album_radio_stands_down: false });
  }));

  app.post("/api/pause-all", wrap(async (req, res) => { await zones.pauseAll(); res.json({ ok: true }); }));

  app.post("/api/mute-all", wrap(async (req, res) => {
    const how = (req.body && req.body.how) || req.query.how || "mute";
    let n = 0;
    for (const o of zones.outputs()) {
      try { await zones.setMute(o.output_id, how !== "unmute"); n++; } catch (e) { /* unreachable room: skip it */ }
    }
    res.json({ ok: true, outputs: n });
  }));

  app.post("/api/group-outputs", wrap(async (req, res) => {
    const ids = ((req.body || {}).output_ids || []).filter(Boolean);
    if (ids.length < 2) return res.status(400).json({ error: "grouping needs at least two outputs" });
    await zones.group(ids);
    res.json({ ok: true });
  }));

  app.post("/api/ungroup-outputs", wrap(async (req, res) => {
    const ids = ((req.body || {}).output_ids || []).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: "no outputs given" });
    await zones.ungroup(ids);
    res.json({ ok: true });
  }));

  app.post("/api/transfer-zone", wrap(async (req, res) => {
    const { from, to } = req.body || {};
    need(from, "from is required"); need(to, "to is required");
    await zones.transfer(from, to);
    res.json({ ok: true });
  }));

  app.post("/api/play-from-here", wrap(async (req, res) => {
    const { zone_or_output_id, queue_item_id } = req.body || {};
    need(zone_or_output_id, "zone_or_output_id required");
    const n = Number(queue_item_id);
    if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: "queue_item_id is required" });
    await zones.playFromHere(zone_or_output_id, n);
    res.json({ ok: true });
  }));

  // Sonos has no standby a controller may use, and no source switching.
  app.post("/api/output/standby", (req, res) => res.status(501).json({ error: "Sonos rooms have no standby control" }));
  app.post("/api/output/convenience-switch", (req, res) => res.status(501).json({ error: "Sonos rooms have no source switch" }));

  // ------------------------------------------------------------ playing

  app.post("/api/play", wrap(async (req, res) => {
    const { offset, zone_or_output_id, kind } = req.body || {};
    if (!Number.isFinite(Number(offset))) return res.status(400).json({ error: "offset required" });
    need(zone_or_output_id, "zone_or_output_id required");
    need(kind, "kind required");
    if (kind === "radio") {
      await playback.playAlbum(zone_or_output_id, Number(offset), "play_now");
      features.setRadio(zones.zone(zone_or_output_id) ? zones.zone(zone_or_output_id).zone_id : zone_or_output_id, true);
      return res.json({ ok: true, action: "radio", offset: Number(offset) });
    }
    await playback.playAlbum(zone_or_output_id, Number(offset), kind);
    res.json({ ok: true, action: kind, offset: Number(offset) });
  }));

  app.post("/api/play-track", wrap(async (req, res) => {
    const b = req.body || {};
    const offset = Number(b.offset);
    const index = Number(b.track !== undefined ? b.track : b.track_index);
    if (!Number.isFinite(offset)) return res.status(400).json({ error: "offset required" });
    if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: "track index required" });
    need(b.zone_or_output_id, "zone_or_output_id required");
    const kind = b.kind || "play_now";
    const tracks = library.tracks(offset);
    if (!tracks.length) return res.status(404).json({ error: "That album is no longer in the library" });
    const t = tracks[index];
    if (!t) return res.status(409).json({ error: "That track is no longer on the album" });
    if (normaliseKind(kind) === "play_now") {
      // Play from this track, with the rest of the album after it — what
      // tapping a track on an album page means everywhere.
      await playback.playTracks(b.zone_or_output_id, tracks, "play_now", { startAt: index });
    } else {
      await playback.playTracks(b.zone_or_output_id, [t], normaliseKind(kind));
    }
    res.json({ ok: true, action: kind, invoked: kind, track: t.title });
  }));

  const filling = new Set();
  app.post("/api/play-multi", wrap(async (req, res) => {
    const b = req.body || {};
    const list = Array.isArray(b.items) && b.items.length ? b.items.map(i => Number(i.offset))
      : (Array.isArray(b.offsets) ? b.offsets.map(Number) : []);
    const ids = list.filter(Number.isFinite);
    if (!ids.length) return res.status(400).json({ error: "offsets required" });
    need(b.zone_or_output_id, "zone_or_output_id required");
    need(b.kind, "kind required");
    if (ids.length > 400) return res.status(400).json({ error: "at most 400 albums at a time" });
    const z = b.zone_or_output_id;
    if (filling.has(z)) return res.status(409).json({ error: "Still filling this zone's queue — let that finish before starting another" });
    filling.add(z);
    try {
      const tracks = [];
      let failed = 0;
      for (const id of ids) {
        const t = library.tracks(id);
        if (t.length) tracks.push(...t); else failed++;
      }
      await playback.playTracks(z, tracks.slice(0, 1000), normaliseKind(b.kind));
      res.json({ ok: true, queued: ids.length - failed, failed, total: ids.length, first_error: failed ? "Some albums are no longer in the library" : null });
    } finally {
      filling.delete(z);
    }
  }));

  async function playUnheard(zoneId) {
    const { albums } = features.unplayed(1, 12);
    const al = albums[0] || library.random(1).albums[0];
    if (!al) { const e = new Error("The library is empty"); e.status = 503; throw e; }
    await playback.playAlbum(zoneId, al.id, "play_now");
    return al;
  }

  app.post("/api/play-unheard", wrap(async (req, res) => {
    const zone = need((req.body || {}).zone_or_output_id, "zone_or_output_id required");
    const al = await playUnheard(zone);
    res.json({ ok: true, album: library.json(al) });
  }));

  const pickZone = (id) => {
    if (id && zones.zone(id)) return zones.zone(id).zone_id;
    const list = zones.zones();
    const last = ctx.db.setting("lastZone", null);
    if (last && zones.zone(last)) return zones.zone(last).zone_id;
    return (list.find(z => z.state === "playing") || list[0] || {}).zone_id;
  };

  app.get("/api/shortcut/play-random", wrap(async (req, res) => {
    const zone = pickZone(req.query.zone);
    if (!zone) return res.status(503).json({ error: "No Sonos rooms found" });
    const al = library.random(1).albums[0];
    if (!al) return res.status(503).json({ error: "The library is empty" });
    await playback.playAlbum(zone, al.id, "play_now");
    res.json({ ok: true, album: library.json(al) });
  }));
  app.get("/api/shortcut/play-unheard", wrap(async (req, res) => {
    const zone = pickZone(req.query.zone);
    if (!zone) return res.status(503).json({ error: "No Sonos rooms found" });
    const al = await playUnheard(zone);
    res.json({ ok: true, album: library.json(al) });
  }));

  // A played track, back in the queue: found in the library by its names.
  function resolveTrack(h) {
    const al = library.relocate(h.album, h.artist) || library.relocate(h.album, null);
    const want = N.fold(h.track);
    if (al) {
      const t = library.tracks(al.id).find(x => N.fold(x.title) === want);
      if (t) return t;
    }
    const row = ctx.db.raw.prepare("SELECT * FROM tracks WHERE lower(title) = lower(?) LIMIT 5").all(h.track || "");
    return row.find(r => !h.artist || N.fold(r.artist) === N.fold(h.artist)) || row[0] || null;
  }

  app.post("/api/queue/play-history-next", wrap(async (req, res) => {
    const b = req.body || {};
    need(b.zone_or_output_id, "zone_or_output_id required");
    const t = resolveTrack(b);
    if (!t) return res.status(404).json({ error: "Not in your library", unresolved: true });
    await playback.playTracks(b.zone_or_output_id, [t], "add_next");
    res.json({ ok: true, track: t.title });
  }));

  app.post("/api/queue/history-multi", wrap(async (req, res) => {
    const b = req.body || {};
    need(b.zone_or_output_id, "zone_or_output_id required");
    const found = [], unresolved = [];
    for (const h of (b.tracks || []).slice(0, 200)) {
      const t = resolveTrack(h);
      if (t) found.push(t); else unresolved.push(h.track || "?");
    }
    if (found.length) await playback.playTracks(b.zone_or_output_id, found, b.kind === "queue" ? "queue" : "add_next");
    res.json({ ok: true, queued: found.length, unresolved, failed: [] });
  }));

  app.get("/api/radio", (req, res) => {
    const zone = req.query.zone ? (zones.zone(req.query.zone) || {}).zone_id || req.query.zone : null;
    res.json({ enabled: zone ? features.radioEnabled(zone) : false, zones: [...features.radioZones()] });
  });
  app.post("/api/radio", wrap(async (req, res) => {
    const zoneRaw = (req.body || {}).zone;
    need(zoneRaw, "zone required");
    const zone = (zones.zone(zoneRaw) || {}).zone_id || zoneRaw;
    const enabled = !!req.body.enabled;
    features.setRadio(zone, enabled);
    res.json({ ok: true, enabled, radios: { own: enabled, roon: false } });
    // Switching it on in a silent room starts it.
    const st = (zones.zone(zone) || {})._state;
    if (enabled && st && st.state !== "playing") features.radioTopUp(zone, true).catch(() => {});
  }));

  app.get("/api/album/now-playing", wrap(async (req, res) => {
    const z = zones.zone(need(req.query.zone, "zone required"));
    const st = z && z._state;
    if (!st) return res.json({ album: null });
    const t = st.trackId ? library.track(st.trackId) : null;
    const al = t ? library.album(t.album_id) : library.relocate(st.album, st.artist);
    res.json({ album: al ? library.json(al) : null });
  }));
};
