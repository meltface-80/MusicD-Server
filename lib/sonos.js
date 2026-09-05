/*
 * MusicD Server — talking to Sonos.
 *
 * Sonos players are UPnP devices, but not the ones a stock control point
 * expects: they advertise as ZonePlayer rather than MediaRenderer, put their
 * renderer in a child device, and use control URLs of their own. The endpoint
 * table and the queue handling below are the same ones the Sonos UPnP bridge
 * arrived at, which is the reference implementation for all of this.
 *
 * Playback goes through the Sonos queue rather than straight onto the
 * transport. That is what makes gapless work: the player moves between tracks
 * itself, with no round trip to this server between them.
 *
 * WHAT IS LEFT HERE IS THE DIALECT. The protocol underneath — SOAP, SSDP, the
 * H:MM:SS time format, the play-mode enum — moved to lib/upnp.js, because none
 * of it was ever Sonos-specific and a second kind of player needs all of it.
 * What stays is what only Sonos has: ZoneGroupTopology, the fixed table of
 * control URLs, the queue extensions, and anything spelled `x-rincon`.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const {
  soap: upnpSoap, ssdpSearch, ipFromLocation, tagText, attrs, unescapeXml
} = require("./upnp");

const SONOS_PORT = 1400;

/*
 * How much of the queue is asked for at a time, and how long a Browse is given.
 *
 * A TIMEOUT IS NOT ONE LENGTH: a Play is a message and a Browse is a document
 * the player has to build. Fifty items comes back promptly even from a speaker
 * that is starting a track; two hundred in one request is what aborted.
 */
const BROWSE_PAGE = 50;
const BROWSE_TIMEOUT_MS = 15000;
const ZONE_PLAYER_ST = "urn:schemas-upnp-org:device:ZonePlayer:1";

/* How long a failed discovery is remembered before the next full attempt. */
const FAILURE_BACKOFF_MS = 30000;

const AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1";
const RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1";
const ZONE_GROUP_TOPOLOGY = "urn:schemas-upnp-org:service:ZoneGroupTopology:1";
const CONTENT_DIRECTORY = "urn:schemas-upnp-org:service:ContentDirectory:1";

const CONTROL_PATHS = {
  [AV_TRANSPORT]: "/MediaRenderer/AVTransport/Control",
  [RENDERING_CONTROL]: "/MediaRenderer/RenderingControl/Control",
  [ZONE_GROUP_TOPOLOGY]: "/ZoneGroupTopology/Control",
  [CONTENT_DIRECTORY]: "/MediaServer/ContentDirectory/Control"
};

/* ------------------------------------------------------------------ */
/*  SOAP, with Sonos' control URLs filled in                           */
/* ------------------------------------------------------------------ */

/*
 * The one thing this has to add to lib/upnp.js: WHERE to send the action.
 *
 * Sonos publishes a fixed table of control URLs that every player uses, which
 * is why nothing here reads a device description. A stock renderer names its
 * own in one and no two makes agree — so the path is the caller's business,
 * and this is the caller for Sonos.
 */
function soap(ip, service, action, args = {}, { timeoutMs = 6000, port = SONOS_PORT } = {}) {
  return upnpSoap(ip, service, action, args,
                  { timeoutMs, port, controlPath: CONTROL_PATHS[service] });
}

/* ------------------------------------------------------------------ */
/*  Discovery                                                          */
/* ------------------------------------------------------------------ */

/*
 * The addresses that answered as ZonePlayers.
 *
 * FINDING A SINGLE PLAYER IS ENOUGH: its ZoneGroupTopology service knows the
 * whole household, including rooms that did not answer the multicast. That is
 * also why SONOS_HOSTS only needs one address to work — and why this keeps
 * only the addresses rather than the LOCATION beside them, unlike a search for
 * stock renderers, which cannot be talked to without one.
 */
async function findZonePlayers(opts = {}) {
  const answered = await ssdpSearch({
    st: ZONE_PLAYER_ST,
    /* A reply is only a Sonos if it says so. The search target alone is not
       enough: a device that answers `ssdp:all` style replies to everything. */
    keep: (text) => /ZonePlayer/i.test(text) || /Sonos/i.test(text),
    ...opts
  });
  return answered.map(a => a.ip);
}

/* ------------------------------------------------------------------ */
/*  Topology                                                           */
/* ------------------------------------------------------------------ */

function parseZoneGroupState(xml) {
  const zones = [];
  if (!xml) return zones;
  const groupRe = /<ZoneGroup\b([^>]*)>([\s\S]*?)<\/ZoneGroup>/g;
  let g;
  while ((g = groupRe.exec(xml))) {
    const groupAttr = attrs(g[1]);
    const memberRe = /<ZoneGroupMember\b([^>]*?)\/?>/g;
    let m;
    while ((m = memberRe.exec(g[2]))) {
      const a = attrs(m[1]);
      if (!a.UUID) continue;
      zones.push({
        uuid: a.UUID,
        name: a.ZoneName || a.UUID,
        ip: ipFromLocation(a.Location),
        coordinator: groupAttr.Coordinator || a.UUID,
        groupId: groupAttr.ID || "",
        invisible: a.Invisible === "1",
        isBridge: a.IsZoneBridge === "1",
        model: a.ZoneName ? (a.ModelName || "") : "",
        channelMap: a.ChannelMapSet || ""
      });
    }
  }
  return zones;
}

/* ------------------------------------------------------------------ */
/*  A player                                                           */
/* ------------------------------------------------------------------ */

class Player {
  constructor(zone) {
    Object.assign(this, zone);
    this.port = zone.port || SONOS_PORT;
  }

  avt(action, args) {
    return soap(this.ip, AV_TRANSPORT, action, { InstanceID: 0, ...args }, { port: this.port });
  }
  rc(action, args) {
    return soap(this.ip, RENDERING_CONTROL, action, { InstanceID: 0, ...args }, { port: this.port });
  }

  play()      { return this.avt("Play", { Speed: 1 }); }
  pause()     { return this.avt("Pause", {}); }
  stop()      { return this.avt("Stop", {}); }
  next()      { return this.avt("Next", {}); }
  previous()  { return this.avt("Previous", {}); }
  seek(hms)   { return this.avt("Seek", { Unit: "REL_TIME", Target: hms }); }
  seekTrack(n){ return this.avt("Seek", { Unit: "TRACK_NR", Target: n }); }

  setAvTransportUri(uri, metadata = "") {
    return this.avt("SetAVTransportURI", { CurrentURI: uri, CurrentURIMetaData: metadata });
  }
  setPlayMode(mode) { return this.avt("SetPlayMode", { NewPlayMode: mode }); }
  clearQueue()      { return this.avt("RemoveAllTracksFromQueue", {}); }

  addToQueue(uri, metadata, { next = 0, asFirst = 0 } = {}) {
    return this.avt("AddURIToQueue", {
      EnqueuedURI: uri,
      EnqueuedURIMetaData: metadata,
      DesiredFirstTrackNumberEnqueued: next,
      EnqueueAsNext: asFirst
    });
  }

  /*
   * MANY TRACKS IN ONE CALL.
   *
   * AddURIToQueue takes one track, so ten albums was a hundred and twelve
   * round trips to the speaker, done one after another — which is why a
   * queued selection appeared a few tracks at a time over several seconds
   * rather than all at once. This is the action the Sonos app itself uses:
   * the URIs are space separated (ours are percent-encoded http URLs, so they
   * cannot contain one) and the metadata is a single DIDL-Lite document
   * holding an item per URI, in the same order.
   */
  addManyToQueue(uris, metadata, { next = 0, asFirst = 0 } = {}) {
    return this.avt("AddMultipleURIsToQueue", {
      UpdateID: 0,
      NumberOfURIs: uris.length,
      EnqueuedURIs: uris.join(" "),
      EnqueuedURIsMetaData: metadata,
      ContainerURI: "",
      ContainerMetaData: "",
      DesiredFirstTrackNumberEnqueued: next,
      EnqueueAsNext: asFirst
    });
  }

  /* The queue's own URI. Pointing the transport at this is what switches a
     player from "playing one stream" to "playing its queue", and it is the
     step that makes the next track start without us. */
  queueUri() { return `x-rincon-queue:${this.uuid}#0`; }

  async transportInfo() {
    const xml = await this.avt("GetTransportInfo", {});
    return {
      state: tagText(xml, "CurrentTransportState") || "STOPPED",
      status: tagText(xml, "CurrentTransportStatus") || ""
    };
  }

  async positionInfo() {
    const xml = await this.avt("GetPositionInfo", {});
    return {
      track: Number(tagText(xml, "Track") || 0),
      duration: tagText(xml, "TrackDuration") || "0:00:00",
      metadata: tagText(xml, "TrackMetaData") || "",
      uri: tagText(xml, "TrackURI") || "",
      relTime: tagText(xml, "RelTime") || "0:00:00"
    };
  }

  async mediaInfo() {
    const xml = await this.avt("GetMediaInfo", {});
    return { tracks: Number(tagText(xml, "NrTracks") || 0), uri: tagText(xml, "CurrentURI") || "" };
  }

  async transportSettings() {
    const xml = await this.avt("GetTransportSettings", {});
    return { playMode: tagText(xml, "PlayMode") || "NORMAL" };
  }

  async volume() {
    const xml = await this.rc("GetVolume", { Channel: "Master" });
    return Number(tagText(xml, "CurrentVolume") || 0);
  }
  setVolume(v) {
    return this.rc("SetVolume", { Channel: "Master", DesiredVolume: Math.max(0, Math.min(100, Math.round(v))) });
  }
  async muted() {
    const xml = await this.rc("GetMute", { Channel: "Master" });
    return tagText(xml, "CurrentMute") === "1";
  }
  setMute(on) { return this.rc("SetMute", { Channel: "Master", DesiredMute: on ? 1 : 0 }); }

  /*
   * The player's own queue, read back.
   *
   * "Q:0" is Sonos' object id for the current queue. The response is a
   * DIDL-Lite document as an escaped string, and only the <res> URI is really
   * needed — every item in there was put there by this server, so the track it
   * names is the authority on its own title and artist.
   */
  /*
   * ONE PAGE of the queue, which is what the speaker is actually good at.
   *
   * A Browse is not a control call: the player has to build and serialise a
   * DIDL-Lite document with an item for every track asked for, and it does that
   * while it is also starting a track and answering the poll loop. Two hundred
   * items in one request is where it stops managing — the abort that reached a
   * screen as "Browse to 192.168.0.93 failed: This operation was aborted".
   *
   * So it gets a longer patience than a Play or a Seek, and ONE retry, because
   * reading a queue is idempotent and the thing that failed was a player being
   * busy for a moment.
   */
  async browsePage(start, count) {
    const ask = () => soap(this.ip, CONTENT_DIRECTORY, "Browse", {
      ObjectID: "Q:0",
      BrowseFlag: "BrowseDirectChildren",
      Filter: "*",
      StartingIndex: start,
      RequestedCount: count,
      SortCriteria: ""
    }, { port: this.port, timeoutMs: BROWSE_TIMEOUT_MS });

    let xml;
    try {
      xml = await ask();
    } catch (e) {
      /* Only a silence is worth asking again: a refusal is an answer, and
         repeating it would just be the same answer a second time. */
      if (e.answered !== false) throw e;
      xml = await ask();
    }

    const didlText = tagText(xml, "Result") || "";
    const total = Number(tagText(xml, "TotalMatches") || 0);
    const items = [];
    const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(didlText))) {
      const body = m[1];
      const res = /<res\b[^>]*>([\s\S]*?)<\/res>/i.exec(body);
      items.push({
        uri: res ? unescapeXml(res[1]) : "",
        title: tagText(body, "title") || "",
        artist: tagText(body, "creator") || ""
      });
    }
    return { items, total, start };
  }

  /*
   * The player's own queue, read back — in PAGES.
   *
   * "Q:0" is Sonos' object id for the current queue. The response is a
   * DIDL-Lite document as an escaped string, and only the <res> URI is really
   * needed — every item in there was put there by this server, so the track it
   * names is the authority on its own title and artist.
   *
   * Paged because the request that fails is the BIG one, and the queue screen
   * and the radio both want the whole thing: several small Browses each answer
   * in well under a second where one large one times out. `total` is the
   * player's own count, so a caller still learns how long the queue is even
   * when it asked for less than all of it.
   */
  async browseQueue(start = 0, count = 200) {
    const items = [];
    let total = 0;
    let at = start;

    while (items.length < count) {
      const page = await this.browsePage(at, Math.min(BROWSE_PAGE, count - items.length));
      total = page.total;
      items.push(...page.items);
      at += page.items.length;
      /* A short page is the end of the queue — and a page of NOTHING is too,
         which is also what stops this looping on a player that keeps saying
         yes to a start index past the end. */
      if (page.items.length < BROWSE_PAGE || at >= total) break;
    }
    return { items, total, start };
  }

  becomeStandalone() { return this.avt("BecomeCoordinatorOfStandaloneGroup", {}); }

  /* Join another room's group. `x-rincon:` plus a coordinator UUID is Sonos'
     own idiom for "follow that player". */
  joinGroup(coordinatorUuid) { return this.setAvTransportUri(`x-rincon:${coordinatorUuid}`, ""); }
}

/* ------------------------------------------------------------------ */
/*  The household                                                      */
/* ------------------------------------------------------------------ */

class Household {
  constructor(opts = {}) {
    this.seeds = (opts.hosts || []).filter(Boolean);
    this.port = opts.port || SONOS_PORT;
    this.excluded = new Set((opts.exclude || []).map(s => s.toLowerCase()));
    this.included = new Set((opts.include || []).map(s => s.toLowerCase()));
    this.zones = [];
    this.lastRefresh = 0;
    this.lastAttempt = 0;
    this.lastError = "";
    this._refreshing = null;
  }

  /* Every playable room, one entry each. Satellites, subs and BRIDGE units are
     hardware inside a room rather than rooms you can play to, so they are not
     listed — the bridge draws the same line, for the same reason. */
  rooms() {
    return this.zones
      .filter(z => !z.invisible && !z.isBridge)
      .filter(z => !this.included.size || this.included.has(z.name.toLowerCase()))
      .filter(z => !this.excluded.has(z.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(uuid) {
    const z = this.zones.find(x => x.uuid === uuid);
    return z ? new Player({ ...z, port: this.port }) : null;
  }

  /*
   * The player a transport command must go to.
   *
   * Playing to a grouped room plays to the whole group, which is how Sonos
   * itself behaves — sending Play to a member instead of its coordinator is
   * accepted and then does nothing audible. Volume deliberately does NOT go
   * through here: that stays with the individual speaker.
   */
  coordinatorFor(uuid) {
    const zone = this.zones.find(z => z.uuid === uuid);
    if (!zone) return null;
    const coord = this.zones.find(z => z.uuid === zone.coordinator);
    return new Player({ ...(coord || zone), port: this.port });
  }

  membersOf(uuid) {
    const zone = this.zones.find(z => z.uuid === uuid);
    if (!zone) return [];
    return this.zones.filter(z => z.coordinator === zone.coordinator && !z.invisible && !z.isBridge);
  }

  /*
   * `maxAgeMs` caches a SUCCESSFUL lookup. FAILURE_BACKOFF_MS caches a failed
   * one, and it is the more important of the two: a full attempt is a SOAP
   * timeout per seed plus an SSDP search — around nine seconds — and without a
   * negative cache every request that touched the household paid it again.
   * With no speakers on the network that meant the status endpoint outlived
   * the container's own health check, and the poll loop never got a gap.
   */
  async refresh({ force = false, maxAgeMs = 30000 } = {}) {
    /* Joining an in-flight refresh comes FIRST, before either cache check. A
       caller that arrives while the very first attempt is still running would
       otherwise be waved through by the failure backoff — which that attempt
       had already stamped — and get an empty room list with no reason attached
       to explain it. */
    if (this._refreshing) return this._refreshing;

    const now = Date.now();
    if (!force) {
      if (this.zones.length && now - this.lastRefresh < maxAgeMs) return this.zones;
      if (this.lastAttempt && now - this.lastAttempt < FAILURE_BACKOFF_MS) return this.zones;
    }
    this._refreshing = this._doRefresh().finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  async _doRefresh() {
    this.lastAttempt = Date.now();
    /* Known-good addresses first — a container that has been running for a
       week should not depend on multicast still working to keep its rooms. */
    const candidates = [...new Set([...this.zones.map(z => z.ip).filter(Boolean), ...this.seeds])];
    let zones = await this._topologyFromAny(candidates);

    if (!zones.length) {
      const discovered = await ssdpSearch();
      zones = await this._topologyFromAny(discovered);
    }

    if (zones.length) {
      this.zones = zones;
      this.lastRefresh = Date.now();
      this.lastError = "";
    } else if (!this.lastError) {
      this.lastError = "No Sonos players answered. Check that the container " +
                       "is on host networking, or set SONOS_HOSTS.";
    }
    return this.zones;
  }

  async _topologyFromAny(ips) {
    for (const ip of ips) {
      try {
        /* A short timeout on purpose: this is a probe, and an address that does
           not answer promptly is an address with no player on it. The full
           six seconds is for a player that has accepted the connection and is
           thinking about it. */
        const xml = await soap(ip, ZONE_GROUP_TOPOLOGY, "GetZoneGroupState", {},
                               { port: this.port, timeoutMs: 2500 });
        const state = tagText(xml, "ZoneGroupState");
        const zones = parseZoneGroupState(state);
        if (zones.length) return zones;
      } catch (e) {
        this.lastError = e.message;
      }
    }
    return [];
  }
}

/*
 * ONLY WHAT IS SONOS. Nothing generic is re-exported from here.
 *
 * A re-export would have been the smaller diff and it is exactly how a partial
 * migration hides: two import paths for one function, and the day somebody
 * changes the H:MM:SS parser they change it for whichever half of the tree
 * they happened to grep. Callers that want the protocol ask lib/upnp.js.
 */
module.exports = {
  Household, Player, parseZoneGroupState, findZonePlayers, SONOS_PORT
};
