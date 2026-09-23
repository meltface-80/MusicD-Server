"use strict";
/*
 * topology.js — finding Sonos players and reading who is grouped with whom.
 *
 * Ported from the bridges' discovery.py. One reachable player can describe the
 * whole household through ZoneGroupTopology, so SSDP only has to find one;
 * the topology supplies the rest, including rooms whose announcements were
 * missed. SONOS_HOSTS seeds it for networks where multicast is unreliable.
 */
const dgram = require("dgram");
const os = require("os");
const XML = require("../xml");
const SOAP = require("./soap");
const { SonosDevice, SONOS_PORT } = require("./device");

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
const ZONE_PLAYER_ST = "urn:schemas-upnp-org:device:ZonePlayer:1";

function parseChannelMap(v) {
  const out = {};
  for (const entry of String(v || "").split(";")) {
    const [uid, chans] = entry.split(":");
    if (!uid || !chans) continue;
    out[uid.trim()] = new Set(chans.split(",").map(s => s.trim().toUpperCase()).filter(Boolean));
  }
  return out;
}

function parseZoneGroupState(xmlText) {
  const doc = XML.parse(String(xmlText || "").trim());
  if (!doc) return [];
  let groupsParent = doc.ZoneGroupState ? doc.ZoneGroupState.ZoneGroups : doc.ZoneGroups;
  if (!groupsParent) return [];
  const zones = [];
  for (const group of XML.list(groupsParent.ZoneGroup)) {
    const coordinator = group["@Coordinator"] || "";
    const groupId = group["@ID"] || "";
    for (const m of XML.list(group.ZoneGroupMember)) {
      const uid = m["@UUID"];
      if (!uid) continue;
      let ip = "";
      try { ip = new URL(m["@Location"] || "").hostname; } catch (e) { /* no location: not addressable */ }
      const channelMap = m["@ChannelMapSet"] || m["@HTSatChanMapSet"] || "";
      const cm = Object.values(parseChannelMap(m["@ChannelMapSet"] || ""));
      zones.push({
        uid,
        name: m["@ZoneName"] || uid,
        ip,
        coordinatorUid: coordinator,
        groupId,
        invisible: m["@Invisible"] === "1",
        isBridge: m["@IsZoneBridge"] === "1",
        softwareVersion: m["@SoftwareVersion"] || "",
        channelMap,
        stereoPair: cm.some(c => c.size === 1 && c.has("LF")) && cm.some(c => c.size === 1 && c.has("RF"))
      });
    }
  }
  return zones;
}

function parseHeaders(buf) {
  const lines = buf.toString("utf8").split(/\r?\n/);
  const h = { "": (lines[0] || "").trim() };
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return h;
}

// The local IPv4 the kernel would route multicast out of: the first
// non-internal IPv4 unless BRIDGE_IP / SERVER_IP pins one.
function localIp(preferred) {
  if (preferred) return preferred;
  const ifs = os.networkInterfaces();
  const cands = [];
  for (const [name, addrs] of Object.entries(ifs)) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) cands.push({ name, address: a.address });
    }
  }
  // Docker's own bridges are never where the speakers are.
  const real = cands.filter(c => !/^(docker|br-|veth|virbr)/.test(c.name));
  return (real[0] || cands[0] || { address: "127.0.0.1" }).address;
}

function msearch(bindIp, { mx = 2, attempts = 3, st = ZONE_PLAYER_ST } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const msg = Buffer.from(
      "M-SEARCH * HTTP/1.1\r\n" +
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
      'MAN: "ssdp:discover"\r\n' +
      `MX: ${mx}\r\n` +
      `ST: ${st}\r\n\r\n`, "ascii");
    sock.on("message", (data, rinfo) => {
      const h = parseHeaders(data);
      if (!/^HTTP\/1\.1 200/i.test(h[""])) return;
      let host = rinfo.address;
      try { host = new URL(h.location).hostname || host; } catch (e) { /* keep the sender's address */ }
      if (/sonos/i.test(h.server || "") || /ZonePlayer/i.test(h.st || "")) found.set(host, h);
    });
    sock.on("error", () => { try { sock.close(); } catch (e) { /* already closed */ } resolve([...found.keys()]); });
    sock.bind(0, bindIp === "127.0.0.1" ? undefined : bindIp, () => {
      try {
        sock.setMulticastTTL(4);
        if (bindIp && bindIp !== "127.0.0.1") sock.setMulticastInterface(bindIp);
      } catch (e) { /* interface selection is best-effort; the default route still works */ }
      let n = 0;
      const send = () => {
        sock.send(msg, SSDP_PORT, SSDP_ADDR, () => {});
        if (++n < attempts) setTimeout(send, 250);
      };
      send();
      setTimeout(() => { try { sock.close(); } catch (e) { /* already closed */ } resolve([...found.keys()]); }, (mx + 1) * 1000);
    });
  });
}

async function fetchModel(ip) {
  try {
    const xml = await SOAP.httpGet(`http://${ip}:${SONOS_PORT}/xml/device_description.xml`, 5000);
    const doc = XML.parse(xml);
    const d = doc && doc.root && doc.root.device;
    if (!d) return "";
    return XML.text(d.modelName) || XML.text(d.displayName) || "";
  } catch (e) {
    return "";
  }
}

class Topology {
  constructor({ seedHosts = [], bindIp, include = [], exclude = [], log = () => {} } = {}) {
    this.seedHosts = [...seedHosts];
    this.bindIp = bindIp;
    this.include = include.map(s => s.toLowerCase());
    this.exclude = exclude.map(s => s.toLowerCase());
    this.log = log;
    this.all = new Map();     // uid -> member
    this.models = new Map();  // uid -> model name
    this.lastRefresh = 0;
    this.lastError = "";
  }

  get hosts() {
    const s = new Set();
    for (const z of this.all.values()) if (z.ip) s.add(z.ip);
    for (const h of this.seedHosts) s.add(h);
    return [...s];
  }

  allowed(name) {
    const n = String(name || "").toLowerCase();
    if (this.include.length && !this.include.includes(n)) return false;
    return !this.exclude.includes(n);
  }

  async discover() {
    const hosts = await msearch(this.bindIp);
    for (const h of hosts) if (!this.seedHosts.includes(h)) this.seedHosts.push(h);
    if (!hosts.length && !this.seedHosts.length) {
      this.lastError = "No Sonos players answered discovery. Use host networking, or set SONOS_HOSTS to a player's IP.";
    }
    return hosts;
  }

  async refresh() {
    let xml = null;
    const errors = [];
    for (const host of this.hosts) {
      try {
        xml = await new SonosDevice(host).getZoneGroupState();
        if (xml) break;
      } catch (e) {
        errors.push(`${host}: ${e.message}`);
      }
    }
    if (!xml) {
      if (errors.length) this.lastError = errors.slice(0, 3).join("; ");
      return false;
    }
    const members = parseZoneGroupState(xml);
    if (!members.length) return false;
    const before = this.signature();
    this.all = new Map(members.map(m => [m.uid, m]));
    for (const m of members) {
      if (!this.models.has(m.uid) && m.ip && !m.invisible) {
        this.models.set(m.uid, "");
        fetchModel(m.ip).then(model => { this.models.set(m.uid, model); });
      }
    }
    this.lastRefresh = Date.now();
    this.lastError = "";
    return before !== this.signature();
  }

  signature() {
    return [...this.all.values()]
      .map(m => `${m.uid}|${m.name}|${m.coordinatorUid}|${m.ip}|${m.invisible}`)
      .sort().join(";");
  }

  // Rooms a person plays to: not satellites, subs, or BOOST/BRIDGE units.
  rooms() {
    return [...this.all.values()].filter(m => !m.invisible && !m.isBridge && m.ip && this.allowed(m.name));
  }

  member(uid) { return this.all.get(uid) || null; }

  coordinatorOf(uid) {
    const m = this.all.get(uid);
    if (!m) return null;
    if (!m.coordinatorUid || m.coordinatorUid === uid) return m;
    return this.all.get(m.coordinatorUid) || m;
  }

  // Groups keyed by coordinator: { coordinator, members[] } — Roon's "zone".
  groups() {
    const out = new Map();
    for (const room of this.rooms()) {
      const coord = this.coordinatorOf(room.uid) || room;
      if (!out.has(coord.uid)) out.set(coord.uid, { coordinator: coord, members: [] });
      out.get(coord.uid).members.push(room);
    }
    // A coordinator hidden by INCLUDE/EXCLUDE still owns its group's queue, so
    // the group stays; it is simply named after the rooms that are visible.
    return [...out.values()];
  }

  device(uid) {
    const m = this.all.get(uid);
    return m && m.ip ? new SonosDevice(m.ip, m.uid, m.name) : null;
  }
}

module.exports = { Topology, parseZoneGroupState, parseChannelMap, msearch, localIp, parseHeaders };
