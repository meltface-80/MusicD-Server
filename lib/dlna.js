/*
 * MusicD Server — stock UPnP media renderers.
 *
 * A WiiM, a MusicCast amp, a Bluesound node, a Pi running gmrender: anything
 * that advertises as a MediaRenderer and speaks AVTransport. lib/sonos.js is
 * the same protocol in a dialect; this is the plain version, and everything
 * they share lives in lib/upnp.js.
 *
 * THE THREE THINGS THAT MAKE THIS DIFFERENT FROM lib/sonos.js:
 *
 *   - NOTHING IS AT A KNOWN ADDRESS. Sonos publishes a table of control URLs
 *     that every player uses. A stock renderer names its own in its device
 *     description and no two makes agree, so the description is fetched and
 *     read. Guessing "/AVTransport/Control" works on one brand and silently
 *     404s on the rest.
 *   - CAPABILITIES ARE READ, NOT ASSUMED. Half of AVTransport is optional.
 *     `SetNextAVTransportURI` — the one that makes gapless possible at all —
 *     is optional, and so is `Seek`. The SCPD lists what a device actually
 *     implements, so it is read once at discovery and remembered. A feature
 *     switched on for a device that cannot do it is worse than one switched
 *     off, because nobody reports it: it just sounds wrong.
 *   - THERE IS NO QUEUE. None of these devices has one. That is 0.4.46's
 *     problem and deliberately not this file's — a Renderer drives the
 *     transport and the volume, which is all every one of them can do.
 *
 * DISCOVERED IS NOT THE SAME AS WANTED. An SSDP search answers for every
 * renderer on the network, television included. What becomes a room somebody
 * can play to is decided in lib/zones.js, and the answer starts as no.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const { soap: upnpSoap, ssdpSearch, tagText, UPnPError } = require("./upnp");

const MEDIA_RENDERER_ST = "urn:schemas-upnp-org:device:MediaRenderer:1";

const AV_TRANSPORT = "AVTransport";
const RENDERING_CONTROL = "RenderingControl";
/* Not a transport service at all: this is the one a device answers "what can I
   play" through. See sinkMimes(). */
const CONNECTION_MANAGER = "ConnectionManager";

/* A device description is a document, not a control message, and some devices
   serve it slowly while they are busy. Still short: this runs during discovery
   and a device that cannot describe itself promptly is one we cannot use. */
const DESCRIBE_TIMEOUT_MS = 5000;

/* How long a failed discovery is remembered before the next full attempt —
   the same courtesy lib/sonos.js extends, for the same reason: a network with
   no renderers on it should not be swept every time somebody opens a screen. */
const FAILURE_BACKOFF_MS = 30000;

/*
 * Actions worth knowing about before anything depends on them.
 *
 * `SetNextAVTransportURI` is the whole of whether gapless is possible: without
 * it the next track can only be handed over once the current one has STOPPED,
 * which is a gap by construction. `Seek` decides whether the transport bar can
 * be dragged. Neither is required by AVTransport:1 and plenty of devices ship
 * without them.
 */
const NOTABLE_ACTIONS = [
  "SetAVTransportURI", "SetNextAVTransportURI", "Play", "Pause", "Stop",
  "Seek", "Next", "Previous", "GetPositionInfo", "GetTransportInfo", "GetMediaInfo"
];

/*
 * Actions that mean "this is a Sonos wearing a MediaRenderer hat".
 *
 * A Sonos answers a MediaRenderer search perfectly happily — all four of them
 * did, on the network this was written for — so without this every Sonos room
 * would be listed a second time as a stock renderer. Matched on CAPABILITY
 * rather than on the manufacturer string, because branding gets rebranded and
 * a queue is a fact about what the device can do.
 */
const SONOS_QUEUE_ACTIONS = ["AddURIToQueue", "AddMultipleURIsToQueue"];

/* ------------------------------------------------------------------ */
/*  Reading a device description                                       */
/* ------------------------------------------------------------------ */

/*
 * The NAME out of urn:<domain>:service:<Name>:<version>.
 *
 * Exact, because the alternative is containment and containment is how
 * `GroupRenderingControl` gets mistaken for `RenderingControl` — a Sonos
 * service whose actions are GetGroupVolume and friends. The same rule
 * `artistAgrees()` learned the hard way: a substring is not an identity.
 */
function serviceName(serviceType) {
  const parts = String(serviceType || "").split(":");
  const at = parts.indexOf("service");
  return at >= 0 && parts[at + 1] ? parts[at + 1] : "";
}

/* Every <service> block, as text, without an XML parser — the same discipline
   lib/upnp.js uses on SOAP bodies. A description is a flat document and the
   elements wanted are leaves. */
function servicesIn(xml) {
  const out = [];
  const re = /<service\b[^>]*>([\s\S]*?)<\/service>/gi;
  let m;
  while ((m = re.exec(xml || ""))) {
    const block = m[1];
    out.push({
      type: tagText(block, "serviceType") || "",
      scpd: tagText(block, "SCPDURL") || "",
      control: tagText(block, "controlURL") || ""
    });
  }
  return out;
}

/*
 * WHAT A DEVICE SAYS IT CAN PLAY, out of ConnectionManager's GetProtocolInfo.
 *
 * `Sink` is a comma-separated list of protocolInfo strings, each four colon-
 * separated fields: protocol, network, CONTENT FORMAT, extra. So
 * "http-get:*:audio/flac:*" is the third field of interest and the first is
 * the filter — a device may also list rtsp or a vendor protocol we have no
 * way to serve.
 *
 * "*" IN THE FORMAT FIELD MEANS ANYTHING, and a few devices answer exactly
 * that. Returning an empty set for it is right rather than lazy: an empty set
 * means "it did not narrow it down", which is the same thing the caller does
 * with a device that refused the question.
 */
function sinkMimes(sink) {
  const out = new Set();
  for (const entry of String(sink || "").split(",")) {
    const parts = entry.trim().split(":");
    if (parts.length < 3) continue;
    if (parts[0].toLowerCase() !== "http-get") continue;
    const mime = parts[2].trim().toLowerCase();
    if (!mime || mime === "*") return new Set();      // it will take anything
    out.add(mime);
  }
  return out;
}

/* A URL in a description may be absolute or relative, and relative is the
   common case. Resolved against the description's own address, which is what
   the specification says and what every control point does. */
function resolve(base, ref) {
  try { return new URL(ref, base).href; } catch { return ""; }
}

async function fetchText(url, timeoutMs = DESCRIBE_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "MusicD-Server" },
      signal: ctl.signal
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/*
 * What one device says it is, and what it says it can do.
 *
 * Returns null rather than throwing for anything that is not a usable
 * renderer: discovery walks a list, and one television that will not describe
 * itself must not cost the rest of the sweep.
 */
async function describe(location) {
  let xml;
  try { xml = await fetchText(location); }
  catch { return null; }               // not describable is not usable

  const services = servicesIn(xml);
  const avt = services.find(s => serviceName(s.type) === AV_TRANSPORT);
  if (!avt || !avt.control) return null;   // no transport: not a renderer we can drive
  const rc = services.find(s => serviceName(s.type) === RENDERING_CONTROL);
  const cm = services.find(s => serviceName(s.type) === CONNECTION_MANAGER);

  const udn = (tagText(xml, "UDN") || "").trim();
  if (!udn) return null;               // nothing stable to remember it by

  /* WHAT IT ACTUALLY IMPLEMENTS, from its own service description. Optional
     actions are the rule rather than the exception in AVTransport, and a
     feature offered for a device that cannot do it just sounds wrong. */
  let actions = new Set();
  if (avt.scpd) {
    try {
      const scpd = await fetchText(resolve(location, avt.scpd));
      actions = new Set([...scpd.matchAll(/<name>\s*([A-Za-z0-9_]+)\s*<\/name>/g)].map(m => m[1]));
    } catch {
      /* A description without a readable SCPD is a device we know less about,
         not one we refuse: every notable action then reads as unavailable,
         which is the safe direction to be wrong in. */
    }
  }

  const can = {};
  for (const name of NOTABLE_ACTIONS) can[name] = actions.has(name);

  /*
   * WHAT IT WILL ACCEPT, asked rather than assumed — the same discipline the
   * SCPD read above follows, and the one thing philippe44's LMS-to-uPnP bridge
   * does that this file did not. Until now every room was filtered through
   * SONOS's format list, which is wrong in both directions on a renderer: it
   * refused a WiiM the Opus and DSD it plays perfectly well, naming Sonos in
   * the error while doing it, and it handed FLAC to anything that could not
   * decode it.
   *
   * ONE ROUND TRIP AT DISCOVERY, beside the two this function already makes,
   * and a device that will not answer is not refused — see plays().
   */
  const url = new URL(location);

  let sink = new Set();
  if (cm && cm.control) {
    try {
      const xml = await upnpSoap(url.hostname, cm.type, "GetProtocolInfo", {}, {
        port: Number(url.port) || 80,
        controlPath: new URL(resolve(location, cm.control)).pathname,
        timeoutMs: DESCRIBE_TIMEOUT_MS
      });
      sink = sinkMimes(tagText(xml, "Sink"));
    } catch {
      /* Silent on purpose and stated here rather than guessed at the call
         site: a device that refuses this, or is too busy to answer, has told
         us nothing about what it plays — which plays() treats as "offer it",
         because a room that refuses everything is worse than one that
         occasionally cannot decode a file. */
    }
  }

  return {
    /* `uuid:` prefixed and stable, which is what settings hang off. Nothing
       like a RINCON_, so the two kinds of id cannot be confused — though
       lib/zones.js does not rely on that. */
    uuid: udn,
    name: (tagText(xml, "friendlyName") || "").trim() || url.hostname,
    maker: (tagText(xml, "manufacturer") || "").trim(),
    model: (tagText(xml, "modelName") || "").trim(),
    ip: url.hostname,
    port: Number(url.port) || 80,
    location,
    control: {
      [AV_TRANSPORT]: new URL(resolve(location, avt.control)).pathname,
      [RENDERING_CONTROL]: rc && rc.control
        ? new URL(resolve(location, rc.control)).pathname : ""
    },
    serviceType: {
      [AV_TRANSPORT]: avt.type,
      [RENDERING_CONTROL]: rc ? rc.type : ""
    },
    can,
    /* Empty means it did not narrow it down — see plays(). */
    sink,
    /* A Sonos answers this search too. Told apart by what it can DO — it has a
       queue and a stock renderer does not — rather than by its badge. */
    isSonos: SONOS_QUEUE_ACTIONS.some(a => actions.has(a))
  };
}

/* ------------------------------------------------------------------ */
/*  One renderer                                                       */
/* ------------------------------------------------------------------ */

/*
 * The transport and the volume, and nothing else.
 *
 * No queue methods, deliberately: these devices have no queue, and a method
 * here that pretended otherwise would be a method lib/playback.js could call.
 * What a room's queue IS lives in lib/queue.js.
 */
class Renderer {
  constructor(device) {
    Object.assign(this, device);
  }

  soap(service, action, args = {}, opts = {}) {
    const controlPath = this.control[service];
    if (!controlPath) {
      /* An answer, not a silence: the device told us it has no such service,
         so asking again would get the same nothing. */
      throw new UPnPError(`${this.name} has no ${service}`, undefined, true);
    }
    return upnpSoap(this.ip, this.serviceType[service], action, args,
                    { ...opts, port: this.port, controlPath });
  }

  avt(action, args) { return this.soap(AV_TRANSPORT, action, { InstanceID: 0, ...args }); }
  rc(action, args)  { return this.soap(RENDERING_CONTROL, action, { InstanceID: 0, ...args }); }

  /* NO QUEUE. Standard AVTransport has one URI playing and, where the device
     implements it, one to play next — there is no list to add to, browse or
     seek within. Said out loud rather than inferred from a missing method. */
  get holdsQueue() { return false; }

  /*
   * WILL THIS DEVICE TAKE THIS FILE? Its own answer, from the content formats
   * it listed at discovery.
   *
   * A DEVICE THAT SAID NOTHING GETS THE FILE. An empty sink means it refused
   * GetProtocolInfo, was too busy to answer, or answered "*" — none of which
   * is evidence against the file, and refusing everything would turn a working
   * room into a dead one over a question the device declined to answer.
   */
  plays(file) {
    if (!this.sink || !this.sink.size) return true;
    return this.sink.has(String((file && file.mime) || "").toLowerCase());
  }

  /*
   * For the sentence a person reads when nothing on an album will play — the
   * formats the device NAMED, verbatim apart from the `audio/` prefix.
   *
   * Not translated into container names: a device that lists `audio/x-flac`
   * rather than `audio/flac` is exactly the thing somebody diagnosing this
   * needs to see, and inventing a friendlier word for it would hide the one
   * fact that explains the refusal. Empty when it declared nothing, and the
   * caller then leaves the clause out rather than printing an empty list.
   */
  get playsWhat() {
    if (!this.sink || !this.sink.size) return "";
    return [...this.sink].map(m => m.replace(/^audio\//, "")).sort().join(", ");
  }

  play()     { return this.avt("Play", { Speed: 1 }); }
  pause()    { return this.avt("Pause", {}); }
  stop()     { return this.avt("Stop", {}); }
  next()     { return this.avt("Next", {}); }
  previous() { return this.avt("Previous", {}); }
  seek(hms)  { return this.avt("Seek", { Unit: "REL_TIME", Target: hms }); }

  setAvTransportUri(uri, metadata = "") {
    return this.avt("SetAVTransportURI", { CurrentURI: uri, CurrentURIMetaData: metadata });
  }

  /*
   * The next track, handed over BEFORE this one ends.
   *
   * The only route to gapless on a device with no queue of its own, and
   * optional in the specification — `can.SetNextAVTransportURI` says whether
   * this device has it, and 0.4.46 is what will use it.
   */
  setNextAvTransportUri(uri, metadata = "") {
    return this.avt("SetNextAVTransportURI", { NextURI: uri, NextURIMetaData: metadata });
  }

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
      relTime: tagText(xml, "RelTime") || "0:00:00",
      uri: tagText(xml, "TrackURI") || "",
      metadata: tagText(xml, "TrackMetaData") || ""
    };
  }

  /*
   * Shuffle and repeat, which Now playing reads on every poll.
   *
   * GetTransportSettings and SetPlayMode are both in AVTransport:1, but plenty
   * of renderers implement neither — there is nothing to shuffle when the
   * controller holds the queue. A refusal is answered as NORMAL rather than
   * thrown: this is one field of a screen that is mostly about something else,
   * and a device with no play mode must not take Now playing down with it.
   */
  async transportSettings() {
    try {
      const xml = await this.avt("GetTransportSettings", {});
      return { playMode: tagText(xml, "PlayMode") || "NORMAL" };
    } catch (e) {
      /* Only a refusal — the device saying it has no such action. A SILENCE is
         a device that was busy or gone, and swallowing that would paint a
         screen as though it had answered. */
      if (e.answered === false) throw e;
      return { playMode: "NORMAL" };
    }
  }

  setPlayMode(mode) { return this.avt("SetPlayMode", { NewPlayMode: mode }); }

  async mediaInfo() {
    const xml = await this.avt("GetMediaInfo", {});
    return { tracks: Number(tagText(xml, "NrTracks") || 0), uri: tagText(xml, "CurrentURI") || "" };
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
}

/* ------------------------------------------------------------------ */
/*  Everything on the network that answered                            */
/* ------------------------------------------------------------------ */

/*
 * The renderers, as a flat list.
 *
 * Flat because that is what they are: a stock renderer is one room, itself,
 * always. There is no topology to read and no grouping — which is why this is
 * a much smaller object than lib/sonos.js's Household, and why it answers
 * `coordinatorFor` and `membersOf` with the device itself rather than pretending
 * otherwise.
 */
class Renderers {
  constructor({ seeds = [], excludeUuids = () => false, search = null } = {}) {
    /* Description URLs, not hostnames — a renderer's is wherever it says, and
       there is no port to assume. UPNP_DEVICES is the escape hatch for a
       network where multicast does not survive the switch. */
    this.seeds = seeds;
    /*
     * INJECTABLE ONLY SO THE SWEEP CAN BE DRIVEN BY A TEST, exactly as
     * lib/sonos.js's is — and for exactly the reason that one was added after
     * the fact: multicast cannot be driven from a test, so a sweep reachable
     * only by multicast is a sweep nothing covers. 0.4.43 shipped a broken
     * discovery call into a file with 544 passing tests.
     */
    this.search = search || (() => ssdpSearch({ st: MEDIA_RENDERER_ST }));
    /* Sonos rooms are found by lib/sonos.js and would otherwise be listed
       twice — once as themselves and once as stock renderers. The registry
       passes in what it already knows about; the capability check in
       describe() is the belt to this pair of braces, for the window where the
       Sonos topology has not been read yet. */
    this.excludeUuids = excludeUuids;
    this.devices = [];
    this.lastRefresh = 0;
    this.lastAttempt = 0;
    this.lastError = "";
  }

  rooms() { return this.devices; }

  get(uuid) {
    const device = this.devices.find(d => d.uuid === uuid);
    return device ? new Renderer(device) : null;
  }

  /* Itself, always. A stock renderer has no groups: it plays what it is told
     and nothing follows it. */
  coordinatorFor(uuid) { return this.get(uuid); }
  membersOf(uuid) {
    const device = this.devices.find(d => d.uuid === uuid);
    return device ? [device] : [];
  }

  async refresh({ force = false, maxAgeMs = 30000 } = {}) {
    const fresh = Date.now() - this.lastRefresh < maxAgeMs;
    const recentlyTried = Date.now() - this.lastAttempt < FAILURE_BACKOFF_MS;
    if (!force && (fresh || (!this.devices.length && recentlyTried))) return this.devices;
    this.lastAttempt = Date.now();

    let answered = [];
    try {
      answered = await this.search();
    } catch (e) {
      this.lastError = e.message;
      return this.devices;
    }

    /* Seeded addresses are asked as well, for a network where multicast does
       not survive the switch — the same escape hatch SONOS_HOSTS is. */
    const locations = new Set(answered.map(a => a.location).filter(Boolean));
    for (const seed of this.seeds) locations.add(seed);

    /* Described in parallel: each one is a couple of small HTTP GETs to a
       different device, and doing them in turn makes discovery as slow as the
       slowest television on the network. */
    const described = await Promise.all([...locations].map(loc => describe(loc)));

    const found = [];
    const seen = new Set();
    for (const device of described) {
      if (!device) continue;
      /* A Sonos answers this search too, and is already a room by another
         route. Either test alone would do most of the time; both cover the
         window before the topology has been read. */
      if (device.isSonos || this.excludeUuids(device.uuid)) continue;
      if (seen.has(device.uuid)) continue;   // two interfaces, one device
      seen.add(device.uuid);
      found.push(device);
    }

    this.devices = found;
    this.lastRefresh = Date.now();
    this.lastError = found.length ? "" : this.lastError;
    return this.devices;
  }
}

module.exports = {
  Renderers, Renderer, describe, serviceName, servicesIn, sinkMimes,
  MEDIA_RENDERER_ST, NOTABLE_ACTIONS
};
