"use strict";
/*
 * fake-sonos.js — a Sonos household that lives on loopback.
 *
 * Each room is an HTTP server on its own 127.0.0.x address, port 1400 — the
 * same paths and SOAP dialect as a real ZonePlayer — so the real server drives
 * it end to end. Ported in spirit from the bridges' tests/fake_device.py, with
 * one addition that matters here: on Play, a room FETCHES the track it was
 * given, the way a speaker does, and records what came back. That is what
 * proves a hi-res file actually reaches the speaker as 24/48 FLAC.
 */
const http = require("http");
const XML = require("../lib/xml");
const DIDL = require("../lib/sonos/didl");

function envelope(action, service, args) {
  const body = Object.entries(args || {}).map(([k, v]) => `<${k}>${XML.escape(v)}</${k}>`).join("");
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
    `<u:${action}Response xmlns:u="${service}">${body}</u:${action}Response></s:Body></s:Envelope>`;
}
function fault(code) {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>` +
    `<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>` +
    `<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode></UPnPError>` +
    `</detail></s:Fault></s:Body></s:Envelope>`;
}

class Room {
  constructor(house, { uid, name, ip, model = "Sonos Five" }) {
    Object.assign(this, { house, uid, name, ip, model });
    this.queue = [];            // [{ uri, meta }]
    this.currentUri = "";       // x-rincon-queue:… | x-rincon:<coord> | a URL
    this.track = 0;             // 1-based
    this.state = "STOPPED";
    this.position = 0; this.at = Date.now();
    this.volume = 20; this.muted = false;
    this.playMode = "NORMAL";
    this.coordinator = uid;
    this.fetches = [];          // what the speaker pulled when told to play
    this.log = [];
  }

  pos() {
    if (this.state !== "PLAYING") return this.position;
    return this.position + (Date.now() - this.at) / 1000;
  }
  setPos(s) { this.position = s; this.at = Date.now(); }

  current() {
    if (this.currentUri.startsWith("x-rincon-queue:")) return this.queue[this.track - 1] || null;
    return null;
  }

  fetchCurrent() {
    const cur = this.current();
    if (!cur) return;
    const entry = { uri: cur.uri, status: 0, type: "", bytes: 0, chunks: [] };
    this.fetches.push(entry);
    const req = http.get(cur.uri, (res) => {
      entry.status = res.statusCode;
      entry.type = res.headers["content-type"] || "";
      entry.length = res.headers["content-length"] || null;
      res.on("data", c => { entry.bytes += c.length; if (entry.bytes < 4 * 1024 * 1024) entry.chunks.push(c); });
      res.on("end", () => { entry.done = true; entry.body = Buffer.concat(entry.chunks); delete entry.chunks; });
    });
    req.on("error", (e) => { entry.error = e.message; entry.done = true; });
  }

  handle(action, a) {
    this.log.push(action);
    const S = "urn:schemas-upnp-org:service:";
    switch (action) {
      case "GetZoneGroupState": return { ZoneGroupState: this.house.zgs() };
      case "GetTransportInfo": return { CurrentTransportState: this.state, CurrentTransportStatus: "OK", CurrentSpeed: "1" };
      case "GetPositionInfo": {
        const cur = this.current();
        const it = cur ? DIDL.parseItems(cur.meta)[0] || {} : {};
        return {
          Track: String(cur ? this.track : 0), TrackDuration: DIDL.hms(it.duration || 0),
          TrackMetaData: cur ? cur.meta : "", TrackURI: cur ? cur.uri : "",
          RelTime: DIDL.hms(this.pos()), AbsTime: "NOT_IMPLEMENTED", RelCount: "0", AbsCount: "0"
        };
      }
      case "GetMediaInfo": return { NrTracks: String(this.queue.length), CurrentURI: this.currentUri, CurrentURIMetaData: "" };
      case "GetTransportSettings": return { PlayMode: this.playMode, RecQualityMode: "NOT_IMPLEMENTED" };
      case "SetPlayMode": this.playMode = a.NewPlayMode; return {};
      case "RemoveAllTracksFromQueue": this.queue = []; this.track = 0; return {};
      case "AddURIToQueue": {
        const at = Number(a.DesiredFirstTrackNumberEnqueued) || 0;
        const item = { uri: a.EnqueuedURI, meta: a.EnqueuedURIMetaData };
        if (at > 0 && at <= this.queue.length) this.queue.splice(at - 1, 0, item); else this.queue.push(item);
        return { FirstTrackNumberEnqueued: String(at || this.queue.length), NumTracksAdded: "1", NewQueueLength: String(this.queue.length) };
      }
      case "AddMultipleURIsToQueue": {
        const uris = String(a.EnqueuedURIs).split(" ");
        const metas = String(a.EnqueuedURIsMetaData).split(/ (?=<DIDL-Lite)/);
        if (uris.length !== Number(a.NumberOfURIs) || metas.length !== uris.length) throw 402;
        const at = Number(a.DesiredFirstTrackNumberEnqueued) || 0;
        const items = uris.map((u, i) => ({ uri: u, meta: metas[i] }));
        if (at > 0 && at <= this.queue.length) this.queue.splice(at - 1, 0, ...items); else this.queue.push(...items);
        return { FirstTrackNumberEnqueued: String(at || this.queue.length - items.length + 1), NumTracksAdded: String(items.length), NewQueueLength: String(this.queue.length) };
      }
      case "RemoveTrackFromQueue": {
        const n = Number(String(a.ObjectID).split("/")[1]);
        this.queue.splice(n - 1, 1);
        return {};
      }
      case "SetAVTransportURI": {
        this.currentUri = a.CurrentURI;
        const m = /^x-rincon:(.+)$/.exec(a.CurrentURI);
        if (m) { this.coordinator = m[1]; this.state = "PLAYING"; }
        if (this.currentUri.startsWith("x-rincon-queue:")) this.track = this.queue.length ? 1 : 0;
        return {};
      }
      case "BecomeCoordinatorOfStandaloneGroup": this.coordinator = this.uid; this.currentUri = ""; this.state = "STOPPED"; return {};
      case "Seek":
        if (a.Unit === "TRACK_NR") { this.track = Number(a.Target); this.setPos(0); if (this.state === "PLAYING") this.fetchCurrent(); }
        else this.setPos(DIDL.toSeconds(a.Target));
        return {};
      case "Play":
        if (!this.current()) throw 701;
        this.setPos(this.state === "PAUSED_PLAYBACK" ? this.position : this.pos());
        if (this.state !== "PLAYING") { this.state = "PLAYING"; this.at = Date.now(); this.fetchCurrent(); }
        return {};
      case "Pause": this.position = this.pos(); this.state = "PAUSED_PLAYBACK"; return {};
      case "Stop": this.state = "STOPPED"; this.setPos(0); return {};
      case "Next":
        if (this.track >= this.queue.length) throw 711;
        this.track++; this.setPos(0); if (this.state === "PLAYING") this.fetchCurrent(); return {};
      case "Previous":
        if (this.track <= 1) throw 711;
        this.track--; this.setPos(0); if (this.state === "PLAYING") this.fetchCurrent(); return {};
      case "GetVolume": return { CurrentVolume: String(this.volume) };
      case "SetVolume": this.volume = Number(a.DesiredVolume); return {};
      case "GetMute": return { CurrentMute: this.muted ? "1" : "0" };
      case "SetMute": this.muted = a.DesiredMute === "1" || a.DesiredMute === "true"; return {};
      case "Browse": {
        const items = this.queue.map((q, i) => q.meta.replace(/<item id="[^"]*"/, `<item id="Q:0/${i + 1}"`)
          .replace(/^<DIDL-Lite[^>]*>/, "").replace(/<\/DIDL-Lite>$/, ""));
        const didl = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' + items.join("") + "</DIDL-Lite>";
        return { Result: didl, NumberReturned: String(this.queue.length), TotalMatches: String(this.queue.length), UpdateID: "1" };
      }
      default: throw 401;
    }
  }

  start() {
    this.server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/xml/device_description.xml") {
        res.setHeader("Content-Type", "text/xml");
        return res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>` +
          `<deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><roomName>${this.name}</roomName>` +
          `<modelName>${this.model}</modelName><UDN>uuid:${this.uid}</UDN></device></root>`);
      }
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => {
        const doc = XML.parse(body);
        const b = doc && doc.Envelope && doc.Envelope.Body;
        const [actionTag, node] = Object.entries(b || {}).find(([k]) => !k.startsWith("@")) || [];
        const args = {};
        for (const [k, v] of Object.entries(node || {})) if (!k.startsWith("@")) args[k] = XML.text(v);
        const service = (node && node["@xmlns:u"]) || "";
        res.setHeader("Content-Type", 'text/xml; charset="utf-8"');
        try {
          const out = this.handle(actionTag, args);
          res.end(envelope(actionTag, service, out));
        } catch (code) {
          res.statusCode = 500;
          res.end(fault(typeof code === "number" ? code : 501));
        }
      });
    });
    return new Promise((resolve, reject) => {
      this.server.on("error", reject);
      this.server.listen(1400, this.ip, resolve);
    });
  }
  stop() { return new Promise(r => this.server ? this.server.close(() => r()) : r()); }
}

class FakeHousehold {
  constructor(rooms = [
    { uid: "RINCON_KITCHEN01400", name: "Kitchen", ip: "127.0.0.11" },
    { uid: "RINCON_STUDY001400", name: "Study", ip: "127.0.0.12", model: "Sonos Era 100" }
  ]) {
    this.rooms = rooms.map(r => new Room(this, r));
  }
  room(name) { return this.rooms.find(r => r.name === name); }
  zgs() {
    const groups = new Map();
    for (const r of this.rooms) {
      if (!groups.has(r.coordinator)) groups.set(r.coordinator, []);
      groups.get(r.coordinator).push(r);
    }
    const xml = [...groups.entries()].map(([coord, members]) =>
      `<ZoneGroup Coordinator="${coord}" ID="${coord}:1">` +
      members.map(m => `<ZoneGroupMember UUID="${m.uid}" ZoneName="${m.name}" Location="http://${m.ip}:1400/xml/device_description.xml" SoftwareVersion="80.1"/>`).join("") +
      `</ZoneGroup>`).join("");
    return `<ZoneGroupState><ZoneGroups>${xml}</ZoneGroups><VanishedDevices/></ZoneGroupState>`;
  }
  async start() { for (const r of this.rooms) await r.start(); }
  async stop() { for (const r of this.rooms) await r.stop(); }
}

module.exports = { FakeHousehold };
