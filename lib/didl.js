/*
 * MusicD Server — DIDL-Lite for Sonos.
 *
 * Sonos is stricter than the UPnP specification about the metadata that comes
 * with a third-party HTTP stream. The two things it insists on, both learned
 * the hard way in the Sonos UPnP bridge, are:
 *
 *   - a <desc> element carrying the RINCON_AssociatedZPUDN sentinel, which is
 *     how a player recognises an item that belongs to no Sonos music service;
 *   - a protocolInfo whose MIME type it actually knows. An invented type is
 *     rejected outright rather than ignored.
 *
 * Everything here builds that one shape. There is no parsing side: this server
 * only ever emits metadata for its own files.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const CDUDN_SENTINEL = "RINCON_AssociatedZPUDN";
const TRACK_CLASS = "object.item.audioItem.musicTrack";

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/* Sonos wants H:MM:SS and, on some firmware, chokes on fractional seconds. */
function duration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/*
 * One track, as the item Sonos will accept.
 *
 * `id` is only ever read back by the player, so the track's own id is used —
 * it makes a queue dump in a packet trace readable, which is worth more than
 * the alternative of an opaque counter.
 */
const DIDL_OPEN =
  `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
  `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
  `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ` +
  `xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/">`;
const DIDL_CLOSE = "</DIDL-Lite>";

/*
 * One <item>, without the document around it.
 *
 * Split out so that several can share ONE document: AddMultipleURIsToQueue
 * takes a single DIDL-Lite holding every item, and building it anywhere but
 * here would be a second place metadata is made — which is the one thing this
 * file exists to prevent.
 */
function itemXml(track, { uri, artUri = "", album = "", albumArtist = "" }) {
  const parts = [
    `<item id="${esc(track.id)}" parentID="${esc(track.album_id || "0")}" restricted="1">`,
    `<dc:title>${esc(track.title)}</dc:title>`,
    `<upnp:class>${TRACK_CLASS}</upnp:class>`,
    `<dc:creator>${esc(track.artist || albumArtist)}</dc:creator>`,
    `<upnp:artist>${esc(track.artist || albumArtist)}</upnp:artist>`,
  ];
  if (album) parts.push(`<upnp:album>${esc(album)}</upnp:album>`);
  if (track.no) parts.push(`<upnp:originalTrackNumber>${Number(track.no)}</upnp:originalTrackNumber>`);
  if (artUri) parts.push(`<upnp:albumArtURI>${esc(artUri)}</upnp:albumArtURI>`);
  parts.push(
    `<res protocolInfo="http-get:*:${esc(track.mime || "audio/mpeg")}:*" ` +
      `duration="${duration(track.duration)}">${esc(uri)}</res>`,
    /* The sentinel. Without it the player accepts the SOAP call and then
       refuses to play the item, with no error anywhere the user can see. */
    `<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">` +
      `${CDUDN_SENTINEL}</desc>`,
    `</item>`
  );

  return parts.join("");
}

/* One track, as its own document — what AddURIToQueue takes. */
function trackItem(track, opts) {
  return DIDL_OPEN + itemXml(track, opts) + DIDL_CLOSE;
}

/* Several tracks in one document, in order — what AddMultipleURIsToQueue
   takes, and the reason a hundred tracks is a handful of calls to the speaker
   rather than a hundred of them. */
function trackItems(entries) {
  return DIDL_OPEN + entries.map(e => itemXml(e.track, e)).join("") + DIDL_CLOSE;
}

module.exports = { trackItem, trackItems, duration, esc, CDUDN_SENTINEL };
