/*
 * MusicD Server — UPnP, the parts that are not anybody's dialect.
 *
 * Everything in here is in the specification: SOAP over HTTP, an SSDP search,
 * the AVTransport time format, the play-mode enum. Nothing in here knows what
 * a Sonos is.
 *
 * WHY THIS FILE EXISTS. lib/sonos.js grew all of this because Sonos was the
 * only thing this server talked to, and most of it was never Sonos-specific —
 * a Sonos player is a UPnP device with extensions, not a different protocol.
 * Splitting it is what lets a second kind of player be added without either
 * one reaching into the other's file, and what stops "generalising" from
 * meaning "editing the code that already works".
 *
 * THE TEST FOR WHETHER SOMETHING BELONGS HERE is whether a device that has
 * never heard of Sonos would still need it. A control URL does not: Sonos
 * publishes a fixed table of them and a stock renderer names its own in its
 * device description, so `soap()` is TOLD the path rather than looking it up.
 * A `RINCON_` anything does not. `Seek` in H:MM:SS does.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const dgram = require("dgram");
const os = require("os");

/* Where SSDP lives. Not configurable: it is the multicast group the
   specification names, and a device that listened anywhere else could not be
   found by anything. */
const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;

/* ------------------------------------------------------------------ */
/*  XML, the small amount of it this needs                             */
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
  /*
   * `answered` is the difference between "the player said no" and "the player
   * said nothing". A refusal is an answer and repeating it just gets the same
   * answer twice; a silence is a player that was busy, and asking again is
   * worth one try. Callers decide with this rather than by reading the
   * message, which is prose and will be reworded one day.
   */
  constructor(message, code, answered = true) {
    super(message);
    this.name = "UPnPError";
    this.code = code;
    this.answered = answered;
  }
}

/*
 * One SOAP action, to one service, on one device.
 *
 * `controlPath` IS A PARAMETER RATHER THAN A LOOKUP, which is the whole
 * difference between this and the version that lived in lib/sonos.js. Sonos
 * publishes a fixed table of control URLs and every player uses it; a stock
 * renderer names its own in its device description and no two makes agree. A
 * table here would therefore be a table of one manufacturer's paths pretending
 * to be the protocol.
 *
 * `port` exists for the tests, not for configuration. A real Sonos always
 * answers on 1400 — it is not user-settable and the README does not mention
 * it — but a fake player cannot bind a fixed port in parallel with another
 * test file that wants the same one, and a suite that fails when two files
 * happen to overlap teaches you to ignore it.
 */
async function soap(ip, service, action, args = {}, { timeoutMs = 6000, port, controlPath } = {}) {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${service}">` +
    Object.entries(args).map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`).join("") +
    `</u:${action}></s:Body></s:Envelope>`;

  const url = `http://${ip}:${port}${controlPath}`;
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
    throw new UPnPError(`${action} to ${ip} failed: ${e.message}`, undefined, false);
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
 * One SSDP search, returning the addresses that answered.
 *
 * `st` is the search target and `keep` decides which replies count — both are
 * the caller's, because what a search is FOR differs by dialect: Sonos asks
 * for ZonePlayer and one answer is enough, since its topology service then
 * names the whole household. A search for stock renderers wants every answer
 * there is.
 *
 * A reply's LOCATION is handed back beside its address. Sonos does not need
 * it; a renderer that names its own control URLs cannot be talked to without
 * it, and re-searching later to find out would be a second round of multicast
 * to learn something the first round already said.
 */
function ssdpSearch({ st, keep = () => true, timeoutMs = 3000, port = SSDP_PORT } = {}) {
  return new Promise((resolve) => {
    const found = new Map();          // ip -> LOCATION (or "" if it sent none)
    let sock;
    try { sock = dgram.createSocket({ type: "udp4", reuseAddr: true }); }
    catch {
      /* No UDP socket to be had — a sandbox with no network, or a host where
         something already owns the port. Discovery simply finds nothing, and
         a seeded list of addresses still works. */
      return resolve([]);
    }

    const finish = () => {
      try { sock.close(); } catch { /* already closed by an error path */ }
      resolve([...found].map(([ip, location]) => ({ ip, location })));
    };

    sock.on("error", () => finish());
    sock.on("message", (msg, rinfo) => {
      const text = msg.toString("utf8");
      if (!keep(text, rinfo.address)) return;
      const m = /^LOCATION:\s*(\S+)/im.exec(text);
      /* First answer per address wins: a device answers a search once per
         service it matches, and they all name the same description. */
      if (!found.has(rinfo.address)) found.set(rinfo.address, m ? m[1] : "");
    });

    sock.bind(() => {
      try { sock.setBroadcast(true); } catch { /* not fatal for unicast replies */ }
      const search = Buffer.from(
        "M-SEARCH * HTTP/1.1\r\n" +
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        "MX: 1\r\n" +
        `ST: ${st}\r\n\r\n`
      );
      /* Sent twice: SSDP is UDP and the first datagram out of a container is
         the one most likely to be dropped while the interface settles. */
      sock.send(search, port, SSDP_ADDR);
      setTimeout(() => { try { sock.send(search, port, SSDP_ADDR); } catch { /* socket closed early */ } }, 300);
      setTimeout(finish, timeoutMs);
    });
  });
}

function ipFromLocation(location) {
  const m = /^https?:\/\/([^:/]+)/.exec(location || "");
  return m ? m[1] : "";
}

/* ------------------------------------------------------------------ */
/*  This server's own address                                          */
/* ------------------------------------------------------------------ */

/* The address this server is reachable at, which has to end up in every track
   URI handed to a speaker. A player fetches the audio itself, so "localhost"
   or a container-internal address is silently unplayable. */
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

/* ------------------------------------------------------------------ */
/*  AVTransport vocabulary                                             */
/* ------------------------------------------------------------------ */

/*
 * Play modes.
 *
 * Shuffle and repeat are two independent switches in the UI, and one enum on
 * the player — a six-cell grid with no obvious naming logic to it: "SHUFFLE"
 * means shuffle AND repeat-all, while shuffle without repeat is
 * "SHUFFLE_NOREPEAT". Toggling one switch has to preserve the other, so both
 * directions of the mapping live here rather than being guessed at the call
 * site.
 */
const PLAY_MODES = {
  NORMAL:             { shuffle: false, repeat: "off" },
  REPEAT_ALL:         { shuffle: false, repeat: "all" },
  REPEAT_ONE:         { shuffle: false, repeat: "one" },
  SHUFFLE_NOREPEAT:   { shuffle: true,  repeat: "off" },
  SHUFFLE:            { shuffle: true,  repeat: "all" },
  SHUFFLE_REPEAT_ONE: { shuffle: true,  repeat: "one" }
};

function parsePlayMode(mode) {
  return PLAY_MODES[String(mode || "").toUpperCase()] || { shuffle: false, repeat: "off" };
}

function playModeFor({ shuffle = false, repeat = "off" } = {}) {
  const want = repeat === "all" || repeat === "one" ? repeat : "off";
  for (const [name, flags] of Object.entries(PLAY_MODES)) {
    if (flags.shuffle === !!shuffle && flags.repeat === want) return name;
  }
  return "NORMAL";        // unreachable: the table covers all six combinations
}

/* AVTransport states time as H:MM:SS, everywhere, in both directions. */
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
  UPnPError, soap,
  ssdpSearch, ipFromLocation, localAddress,
  tagText, attrs, escapeXml, unescapeXml,
  parsePlayMode, playModeFor, PLAY_MODES,
  hmsToSeconds, secondsToHms,
  SSDP_ADDR, SSDP_PORT
};
