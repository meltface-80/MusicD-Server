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
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const dgram = require("dgram");
const os = require("os");

const SONOS_PORT = 1400;
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
/*  XML, the small amount of it this file needs                        */
/* ------------------------------------------------------------------ */

function unescapeXml(s) {
  return String(s == null ? "" : s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");        // last, so "&amp;lt;" survives as "&lt;"
}

function escapeXml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/* Pull one element's text out of a SOAP body. Responses from a player are
   flat — a handful of leaf elements under the action's response element — so
   a namespace-insensitive match on the tag name is sufficient and avoids
   pulling in an XML parser for it. */
function tagText(xml, name) {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "i").exec(xml || "");
  if (!m) {
    /* Self-closing, which players use for an empty value. */
    return new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?/>`, "i").test(xml || "") ? "" : null;
  }
  return unescapeXml(m[1]);
}

function attrs(tagSource) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tagSource))) out[m[1]] = unescapeXml(m[2]);
  return out;
}

/* ------------------------------------------------------------------ */
/*  SOAP                                                               */
/* ------------------------------------------------------------------ */

class UPnPError extends Error {
  constructor(message, code) { super(message); this.name = "UPnPError"; this.code = code; }
}

/*
 * `port` exists for the tests, not for configuration. A real player always
 * answers on 1400 — it is not user-settable and the README does not mention
 * it — but a fake player cannot bind a privileged-adjacent fixed port in
 * parallel with another test file that wants the same one, and a suite that
 * fails when two files happen to overlap teaches you to ignore it.
 */
async function soap(ip, service, action, args = {}, { timeoutMs = 6000, port = SONOS_PORT } = {}) {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${service}">` +
    Object.entries(args).map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`).join("") +
    `</u:${action}></s:Body></s:Envelope>`;

  const url = `http://${ip}:${port}${CONTROL_PATHS[service]}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res, text;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPACTION": `"${service}#${action}"`
      },
      body,
      signal: ctl.signal
    });
    text = await res.text();
  } catch (e) {
    throw new UPnPError(`${action} to ${ip} failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    /* A UPnP fault carries its real reason in errorCode; the HTTP status is
       always 500 and says nothing useful on its own. */
    const code = tagText(text, "errorCode");
    throw new UPnPError(`${action} to ${ip} refused (UPnP ${code || res.status})`, code);
  }
  return text;
}

/* ------------------------------------------------------------------ */
/*  Discovery                                                          */
/* ------------------------------------------------------------------ */

/*
 * One SSDP search, returning the addresses that answered as ZonePlayers.
 *
 * Finding a single player is enough: its ZoneGroupTopology service knows the
 * whole household, including rooms that did not answer the multicast. That is
 * also why SONOS_HOSTS only needs one address to work.
 */
function ssdpSearch({ timeoutMs = 3000, port = 1900 } = {}) {
  return new Promise((resolve) => {
    const found = new Set();
    let sock;
    try { sock = dgram.createSocket({ type: "udp4", reuseAddr: true }); }
    catch {
      /* No UDP socket to be had — a sandbox with no network, or a host where
         something already owns the port. Discovery simply finds nothing, and
         the seeded SONOS_HOSTS path still works. */
      return resolve([]);
    }

    const finish = () => {
      try { sock.close(); } catch { /* already closed by an error path */ }
      resolve([...found]);
    };

    sock.on("error", () => finish());
    sock.on("message", (msg, rinfo) => {
      const text = msg.toString("utf8");
      if (/ZonePlayer/i.test(text) || /Sonos/i.test(text)) found.add(rinfo.address);
    });

    sock.bind(() => {
      try { sock.setBroadcast(true); } catch { /* not fatal for unicast replies */ }
      const search = Buffer.from(
        "M-SEARCH * HTTP/1.1\r\n" +
        "HOST: 239.255.255.250:1900\r\n" +
        'MAN: "ssdp:discover"\r\n' +
        "MX: 1\r\n" +
        `ST: ${ZONE_PLAYER_ST}\r\n\r\n`
      );
      /* Sent twice: SSDP is UDP and the first datagram out of a container is
         the one most likely to be dropped while the interface settles. */
      sock.send(search, port, "239.255.255.250");
      setTimeout(() => { try { sock.send(search, port, "239.255.255.250"); } catch { /* socket closed early */ } }, 300);
      setTimeout(finish, timeoutMs);
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Topology                                                           */
/* ------------------------------------------------------------------ */

function ipFromLocation(location) {
  const m = /^https?:\/\/([^:/]+)/.exec(location || "");
  return m ? m[1] : "";
}

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
  async browseQueue(start = 0, count = 200) {
    const xml = await soap(this.ip, CONTENT_DIRECTORY, "Browse", {
      ObjectID: "Q:0",
      BrowseFlag: "BrowseDirectChildren",
      Filter: "*",
      StartingIndex: start,
      RequestedCount: count,
      SortCriteria: ""
    }, { port: this.port });
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

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/* The address this server is reachable at, which has to end up in every track
   URI handed to a speaker. Sonos fetches the audio itself, so "localhost" or a
   container-internal address is silently unplayable. */
function localAddress(preferred = "") {
  if (preferred) return preferred;
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family !== "IPv4" && net.family !== 4) continue;
      if (net.internal) continue;
      if (/^(docker|br-|veth|tailscale|zt)/.test(name)) continue;
      candidates.push({ name, address: net.address });
    }
  }
  /* A private LAN address is what a speaker can reach; anything else on the
     host is a worse guess than the first private one. */
  const lan = candidates.find(c => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(c.address));
  return (lan || candidates[0] || { address: "127.0.0.1" }).address;
}

function hmsToSeconds(hms) {
  const parts = String(hms || "0:00:00").split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  while (parts.length < 3) parts.unshift(0);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function secondsToHms(total) {
  const t = Math.max(0, Math.round(Number(total) || 0));
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}` +
         `:${String(t % 60).padStart(2, "0")}`;
}

module.exports = {
  Household, Player, ssdpSearch, parseZoneGroupState, localAddress,
  hmsToSeconds, secondsToHms, tagText, unescapeXml, UPnPError, SONOS_PORT
};
