"use strict";
/*
 * didl.js — the metadata a Sonos player needs before it will play a URL.
 *
 * Ported from the bridges' didl.py. Sonos rejects a third-party HTTP item whose
 * DIDL-Lite lacks the RINCON_AssociatedZPUDN descriptor, and it matches the MIME
 * type in protocolInfo against what actually arrives — so the type is always
 * stated from what the stream endpoint is going to send, never guessed from a
 * URL.
 */
const XML = require("../xml");

const RINCON_NS = "urn:schemas-rinconnetworks-com:metadata-1-0/";
const CDUDN_SENTINEL = "RINCON_AssociatedZPUDN";
const DEFAULT_CLASS = "object.item.audioItem.musicTrack";

function hms(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function toSeconds(v) {
  const t = String(v || "").trim();
  if (!t || t === "NOT_IMPLEMENTED") return 0;
  const parts = t.split(":").map(Number);
  if (parts.some(n => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/*
 * meta: { title, artist, album, albumArtist, artUri, trackNumber, duration (s),
 *         mime, itemId }
 */
function build(uri, meta = {}) {
  const mime = meta.mime || "audio/flac";
  const res = [`protocolInfo="${XML.escape(`http-get:*:${mime}:*`)}"`];
  if (meta.duration) res.push(`duration="${hms(meta.duration)}"`);
  const out = [
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"',
    ' xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/"',
    ' xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">',
    `<item id="${XML.escape(meta.itemId || "-1")}" parentID="-1" restricted="true">`,
    `<dc:title>${XML.escape(meta.title || "Track")}</dc:title>`
  ];
  if (meta.artist) {
    out.push(`<dc:creator>${XML.escape(meta.artist)}</dc:creator>`);
    out.push(`<upnp:artist>${XML.escape(meta.artist)}</upnp:artist>`);
  }
  if (meta.albumArtist) out.push(`<r:albumArtist>${XML.escape(meta.albumArtist)}</r:albumArtist>`);
  if (meta.album) out.push(`<upnp:album>${XML.escape(meta.album)}</upnp:album>`);
  if (meta.artUri) out.push(`<upnp:albumArtURI>${XML.escape(meta.artUri)}</upnp:albumArtURI>`);
  if (meta.trackNumber) out.push(`<upnp:originalTrackNumber>${XML.escape(meta.trackNumber)}</upnp:originalTrackNumber>`);
  out.push(`<upnp:class>${DEFAULT_CLASS}</upnp:class>`);
  out.push(`<res ${res.join(" ")}>${XML.escape(uri)}</res>`);
  out.push(`<desc id="cdudn" nameSpace="${RINCON_NS}">${CDUDN_SENTINEL}</desc>`);
  out.push("</item></DIDL-Lite>");
  return out.join("");
}

/*
 * Parse a DIDL-Lite document (a Browse result, or a transport's track
 * metadata) into flat items. Never throws: bad metadata is common in the wild
 * and an empty list is always a usable answer.
 */
function parseItems(didl) {
  const doc = XML.parse(didl);
  const root = doc && doc["DIDL-Lite"];
  if (!root) return [];
  const items = XML.list(root.item).concat(XML.list(root.container));
  return items.map(it => {
    const res = XML.list(it.res)[0];
    return {
      id: it["@id"] || "",
      title: XML.text(it.title),
      artist: XML.text(it.creator) || XML.text(it.artist),
      album: XML.text(it.album),
      albumArtist: XML.text(it.albumArtist),
      artUri: XML.text(it.albumArtURI),
      uri: XML.text(res),
      duration: res && typeof res === "object" ? toSeconds(res["@duration"]) : 0,
      streamContent: XML.text(it.streamContent)
    };
  });
}

module.exports = { build, parseItems, hms, toSeconds, CDUDN_SENTINEL };
