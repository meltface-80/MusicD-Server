/*
 * MusicD Server — playback.
 *
 * Two jobs, and they are separate on purpose.
 *
 * Sending music out: an album becomes a list of HTTP URLs on this server, each
 * one loaded into the target room's Sonos queue with metadata the player will
 * accept. The audio never passes through here — the speaker fetches the file
 * itself, exactly as the Sonos UPnP bridge has Audirvana's own server do it.
 *
 * Watching what comes back: a poll loop reads each coordinator's transport and
 * turns it into play counts and last-played dates. Counting on the way out
 * would be easier and would be a lie — a queued album that is skipped past has
 * not been played, and the six-month row is only as good as that distinction.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const path = require("path");
const didl = require("./didl");
const { encodeId, decodeId } = require("./ids");
const { hmsToSeconds, secondsToHms, parsePlayMode, playModeFor } = require("./sonos");
const { recordTrackPlay, recordAlbumPlay } = require("./db");
const { playableBySonos } = require("./scanner");
const { tracksForAlbum } = require("./library");

/* A track counts as played once you are half way through it, or four minutes
   in, whichever comes first — the same rule scrobblers have used for twenty
   years, and the reason a skipped track never lands in "recently played". */
const HALF = 0.5;
const CAP_SECONDS = 240;
const MIN_SECONDS = 20;

/* How near the start of a track counts as "started again" rather than "seeked
   backwards". Sonos reports whole seconds, and a poll can land a moment after
   the restart, so this is a couple of ticks wide rather than exactly zero. */
const RESTART_SECONDS = 3;

/* The repeat button cycles rather than toggles, so the order lives in one place. */
function nextRepeat(current) {
  return current === "off" ? "all" : current === "all" ? "one" : "off";
}

class Playback {
  constructor({ db, household, baseUrl, onLibraryChange = () => {} }) {
    this.db = db;
    this.household = household;
    this.baseUrl = baseUrl;              // a function: the speaker-reachable origin
    this.onLibraryChange = onLibraryChange;
    this.watch = new Map();              // coordinator uuid -> what we last saw
    this.timer = null;
    this.running = false;

    /* Prepared once. The queue view resolves up to 200 items and the poll loop
       runs every five seconds, so re-compiling these on every row was the one
       piece of per-item cost in an otherwise cheap path. */
    this.stmt = {
      trackById: db.prepare("SELECT * FROM tracks WHERE id = ?"),
      livingTrackById: db.prepare("SELECT * FROM tracks WHERE id = ? AND present = 1"),
      albumById: db.prepare("SELECT id, title, artist, year, art FROM albums WHERE id = ?")
    };
  }


  /* ---------------------------------------------------------------- */
  /*  URLs a speaker can fetch                                         */
  /* ---------------------------------------------------------------- */

  trackUri(track) {
    /* The extension is on the URL because Sonos looks at it as a second
       opinion on the MIME type, and disagreeing with itself is one of the
       ways a player silently refuses a stream. */
    const ext = path.extname(track.path || track.rel || "").toLowerCase() || ".mp3";
    return `${this.baseUrl()}/stream/${encodeId(track.id)}${ext}`;
  }

  artUri(albumId, hasArt) {
    return hasArt ? `${this.baseUrl()}/art/${encodeId(albumId)}` : "";
  }

  metadataFor(track, album) {
    return didl.trackItem(track, {
      uri: this.trackUri(track),
      artUri: this.artUri(album.id, !!album.art),
      album: album.title,
      albumArtist: album.artist
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Sending music out                                                */
  /* ---------------------------------------------------------------- */

  /* Everything that plays goes through here. `replace` clears the room's queue
     first (Play); leaving it false appends (Queue).

     `startTrackId` names the track to start on, rather than a position. It has
     to: the caller counts positions in the FULL track list, unplayable files
     included — they are deliberately listed and badged — and this method drops
     those before building the queue. Passing an index across that boundary
     started the album one track late for every file skipped above it. */
  async enqueue(zoneUuid, tracks, { replace = true, startTrackId = null, autoplay = true } = {}) {
    await this.household.refresh();
    const player = this.household.coordinatorFor(zoneUuid);
    if (!player) throw new Error("That room is not on the network right now.");

    const playable = tracks.filter(t => playableBySonos(path.extname(t.path || t.rel || "").toLowerCase()));
    if (!playable.length) {
      throw new Error("Sonos cannot play any of these files. It handles FLAC, ALAC, " +
                      "WAV, AIFF, MP3, AAC and Ogg Vorbis — but not DSD, WMA or Opus.");
    }

    const albums = new Map();
    for (const t of playable) {
      if (albums.has(t.album_id)) continue;
      albums.set(t.album_id, this.stmt.albumById.get(t.album_id) || {});
    }

    if (replace) await player.clearQueue();

    /* The first track's position, needed to start playback at the right place
       when the queue was empty and when it was not. */
    const before = replace ? 0 : (await player.mediaInfo()).tracks;

    for (const t of playable) {
      await player.addToQueue(this.trackUri(t), this.metadataFor(t, albums.get(t.album_id) || {}));
    }

    if (replace || autoplay) {
      /* Point the transport at the queue itself. Until this is done the player
         is still on whatever stream or radio it was on, and Play would resume
         that instead. */
      await player.setAvTransportUri(player.queueUri());
      if (replace) await player.setPlayMode("NORMAL");
      /* A named track that Sonos cannot play was dropped above; starting at the
         next one that survived is the closest thing to what was asked for. */
      const at = startTrackId ? playable.findIndex(t => t.id === startTrackId) : 0;
      await player.seekTrack(before + Math.max(0, at) + 1);
      if (autoplay) await player.play();
    }

    return { queued: playable.length, skipped: tracks.length - playable.length, room: player.name };
  }

  /* `startIndex` is a position in the album's full track list, which is what
     the album screen shows and therefore what it can count. It is turned into a
     track id here, while both lists are still in view. */
  async playAlbum(zoneUuid, albumId, startIndex = 0) {
    const tracks = tracksForAlbum(this.db, albumId);
    if (!tracks.length) throw new Error("That album has no playable files.");
    const start = tracks[Math.max(0, Math.min(startIndex, tracks.length - 1))];
    return this.enqueue(zoneUuid, tracks, { replace: true, startTrackId: start.id });
  }

  async queueAlbum(zoneUuid, albumId) {
    const tracks = tracksForAlbum(this.db, albumId);
    if (!tracks.length) throw new Error("That album has no playable files.");
    return this.enqueue(zoneUuid, tracks, { replace: false, autoplay: false });
  }

  async playTracks(zoneUuid, trackIds, { replace = true } = {}) {
    const rows = trackIds.map(id => this.stmt.livingTrackById.get(id)).filter(Boolean);
    if (!rows.length) throw new Error("Those tracks are no longer in the library.");
    return this.enqueue(zoneUuid, rows, {
      replace, autoplay: replace, startTrackId: rows[0].id
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Transport                                                        */
  /* ---------------------------------------------------------------- */

  /* off → all → one → off, which is the order the one button cycles through. */
  async command(zoneUuid, action, value) {
    await this.household.refresh();
    const coord = this.household.coordinatorFor(zoneUuid);
    if (!coord) throw new Error("That room is not on the network right now.");

    switch (action) {
      case "play":   return coord.play();
      case "pause":  return coord.pause();
      case "stop":   return coord.stop();
      case "next":   return coord.next();
      case "previous": return coord.previous();
      case "seek":   return coord.seek(secondsToHms(value));
      /* Jump to a position in the queue. Sonos numbers its queue from 1, and
         the queue view hands back the index it was given, so no adjustment. */
      case "seek_track": return coord.seekTrack(Math.max(1, Number(value) || 1));
      case "playmode": return coord.setPlayMode(String(value || "NORMAL"));

      /* Shuffle and repeat are read back before they are written, because the
         player holds them as one enum: setting shuffle without knowing the
         current repeat state would silently turn repeat off. */
      case "shuffle": case "repeat": {
        const current = parsePlayMode((await coord.transportSettings()).playMode);
        const next = action === "shuffle"
          ? { ...current, shuffle: value === undefined ? !current.shuffle : !!value }
          : { ...current, repeat: value || nextRepeat(current.repeat) };
        return coord.setPlayMode(playModeFor(next));
      }
      case "clear":  return coord.clearQueue();
      default: throw new Error("Unknown transport command: " + action);
    }
  }

  /* Volume and mute stay with the speaker you named, never its coordinator —
     turning down a grouped room should turn down that room. */
  async volume(zoneUuid, level) {
    await this.household.refresh();
    const player = this.household.get(zoneUuid);
    if (!player) throw new Error("That room is not on the network right now.");
    if (level === undefined) return { volume: await player.volume(), muted: await player.muted() };
    await player.setVolume(level);
    return { volume: Math.max(0, Math.min(100, Math.round(level))) };
  }

  async mute(zoneUuid, on) {
    await this.household.refresh();
    const player = this.household.get(zoneUuid);
    if (!player) throw new Error("That room is not on the network right now.");
    await player.setMute(on);
    return { muted: !!on };
  }

  /* ---------------------------------------------------------------- */
  /*  What is playing                                                  */
  /* ---------------------------------------------------------------- */

  /* Read a URL a speaker is playing back into the track it came from. Anything
     that is not one of ours — radio, a Sonos service, another app — returns
     null and is simply reported as-is. */
  trackFromUri(uri) {
    const m = /\/stream\/([A-Za-z0-9_-]+)(?:\.[a-z0-9]+)?(?:\?|$)/.exec(uri || "");
    if (!m) return null;
    const id = decodeId(m[1]);
    if (!id) return null;
    return this.stmt.trackById.get(id) || null;
  }

  async nowPlaying(zoneUuid) {
    await this.household.refresh();
    const zone = this.household.zones.find(z => z.uuid === zoneUuid);
    if (!zone) return null;
    const coord = this.household.coordinatorFor(zoneUuid);

    const [pos, transport, settings] = await Promise.all([
      coord.positionInfo(), coord.transportInfo(), coord.transportSettings()
    ]);

    const track = this.trackFromUri(pos.uri);
    const album = track ? this.stmt.albumById.get(track.album_id) : null;

    let volume = null, muted = false;
    try {
      const player = this.household.get(zoneUuid);
      volume = await player.volume();
      muted = await player.muted();
    } catch { /* a room that dropped off mid-poll still has a valid transport */ }

    const members = this.household.membersOf(zoneUuid);
    return {
      zone: { uuid: zone.uuid, name: zone.name },
      coordinator: { uuid: coord.uuid, name: coord.name },
      grouped: members.length > 1,
      members: members.map(m => ({ uuid: m.uuid, name: m.name })),
      state: transport.state,
      playMode: settings.playMode,
      /* Split out for the two buttons that drive them — the client should not
         have to know the six-cell enum. */
      ...parsePlayMode(settings.playMode),
      position: hmsToSeconds(pos.relTime),
      duration: hmsToSeconds(pos.duration) || (track ? track.duration : 0),
      queueIndex: pos.track,
      volume, muted,
      track: track ? {
        id: track.id, title: track.title, artist: track.artist,
        no: track.no, disc: track.disc, duration: track.duration,
        bitdepth: track.bitdepth || null, sampleRate: track.samplerate || null
      } : null,
      album: album ? {
        id: album.id, title: album.title, artist: album.artist, year: album.year || null,
        art: album.art ? `/art/${encodeId(album.id)}` : ""
      } : null,
      /* Something is playing that did not come from this library. Saying so is
         more useful than showing an empty Now Playing screen. */
      foreign: !track && !!pos.uri
    };
  }

  /* The room's real queue, read back off the player rather than remembered
     here — the Sonos app can change it, and a queue view that disagrees with
     the speaker is worse than none. */
  async queue(zoneUuid, limit = 200) {
    await this.household.refresh();
    const coord = this.household.coordinatorFor(zoneUuid);
    if (!coord) return { items: [], index: 0, total: 0 };

    const [pos, browsed] = await Promise.all([
      coord.positionInfo(), coord.browseQueue(0, limit)
    ]);

    const items = browsed.items.map((it, i) => {
      const track = this.trackFromUri(it.uri);
      const album = track ? this.stmt.albumById.get(track.album_id) : null;
      return {
        index: i + 1,
        title: track ? track.title : it.title,
        artist: track ? track.artist : it.artist,
        duration: track ? track.duration : 0,
        trackId: track ? track.id : null,
        albumId: album ? album.id : null,
        album: album ? album.title : "",
        art: album && album.art ? `/art/${encodeId(album.id)}` : ""
      };
    });

    return { items, index: pos.track, total: browsed.total };
  }

  /* ---------------------------------------------------------------- */
  /*  Counting plays                                                   */
  /* ---------------------------------------------------------------- */

  start(intervalMs = 5000) {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      try { await this.poll(); }
      catch { /* a poll that fails is a speaker that was busy answering the
                 Sonos app; the next one will pick up where this left off */ }
      /* Checked AFTER the await, not before: a tick suspended inside poll() —
         which is most of the time when discovery is slow — would otherwise
         re-arm the timer that stop() had just cleared, and SIGTERM would never
         actually stop the loop. */
      if (this.running) this.timer = setTimeout(tick, intervalMs);
    };
    this.timer = setTimeout(tick, intervalMs);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /*
   * One pass over every group coordinator.
   *
   * Coordinators only: a grouped room reports the same transport as the room
   * driving it, and polling both would count every play twice.
   */
  async poll() {
    await this.household.refresh({ maxAgeMs: 60000 });
    const coordinators = new Map();
    for (const zone of this.household.rooms()) {
      const coord = this.household.coordinatorFor(zone.uuid);
      if (coord) coordinators.set(coord.uuid, coord);
    }

    for (const [uuid, coord] of coordinators) {
      let transport, pos;
      try {
        transport = await coord.transportInfo();
        /* NOT cleared when the player is paused, stopped, or unreachable.
           Forgetting what was already credited is how a pause and a resume
           came to count the same track twice: on resume the position is still
           past the halfway mark, so it qualifies all over again. One dropped
           SOAP call did the same. The entry is keyed by coordinator, so the
           map is bounded by the number of rooms and never needs pruning. */
        if (transport.state !== "PLAYING") continue;
        pos = await coord.positionInfo();
      } catch {
        /* The room stopped answering mid-poll. Its watch state is deliberately
           left intact — see the note above — and the next poll picks it up. */
        continue;
      }

      const track = this.trackFromUri(pos.uri);
      if (!track) continue;                  // radio, a Sonos service, another app

      const seen = this.watch.get(uuid);
      /* A new track resets the credit, but the album it belongs to is
         remembered across the whole run — that is what stops a twelve-track
         album counting as twelve album plays. */
      if (!seen || seen.trackId !== track.id) {
        this.watch.set(uuid, {
          trackId: track.id,
          credited: false,
          elapsed: 0,
          albumCredited: seen && seen.albumCredited === track.album_id ? track.album_id : null
        });
      }
      const state = this.watch.get(uuid);

      const elapsed = hmsToSeconds(pos.relTime);
      const duration = hmsToSeconds(pos.duration) || track.duration || 0;
      const threshold = Math.max(MIN_SECONDS, Math.min(CAP_SECONDS, duration * HALF));

      /* Back at the beginning of a track that had already been credited: the
         listener started it again, which is a second play and should count as
         one. Only a jump right back to the top counts — seeking about inside a
         track is not replaying it. */
      if (state.credited && elapsed <= RESTART_SECONDS && state.elapsed > elapsed) {
        state.credited = false;
      }
      state.elapsed = elapsed;

      if (state.credited || elapsed < threshold) continue;

      state.credited = true;
      recordTrackPlay(this.db, track.id, track.album_id);
      if (state.albumCredited !== track.album_id) {
        state.albumCredited = track.album_id;
        recordAlbumPlay(this.db, track.album_id);
      }
      /* Recently played and Smart Picks both just changed. */
      this.onLibraryChange();
    }
  }
}

module.exports = { Playback };
