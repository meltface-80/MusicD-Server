"use strict";
/*
 * share.js — playlists as a text blob you can paste to someone: MusicD
 * Remote's own "MDRP1:" format (gzipped JSPF), so a playlist shared from
 * either app imports into the other.
 */
const zlib = require("zlib");
const VERSION = require("../../package.json").version;

function shareMagic()      { return "MDRP1"; }
function shareTrackMax()   { return 2000; }
// Entries the route will walk. Higher than the output cap so a caller whose
// list contains untitled rows still gets everything it CAN share encoded,
// rather than being refused for entries that were never going to count.
function shareInputMax()   { return 5000; }
function shareTextMax()    { return 500; }
function shareNameMax()    { return 200; }
function shareUriMax()     { return 4; }
function shareNsTrack()    { return "https://musicbrainz.org/doc/jspf#track"; }
function shareNsPlaylist() { return "https://musicbrainz.org/doc/jspf#playlist"; }

// Every value below is built into a FRESH object literal from a known field
// list, never passed through from the caller. Same pattern as sanitizeLibView
// and smartPlaylistRecord, and for the same reason: this data crosses a trust
// boundary in the import direction, so the encoder and the decoder must agree
// on a shape neither of them can be talked out of.
function shareText(v, max) {
  if (typeof v !== "string") return "";
  // Trimmed AFTER the clamp as well as before it: slicing mid-string can leave
  // a trailing space, and in a file that is never re-issued that is a different
  // canonical key from the same title without one.
  return v.replace(/\s+/g, " ").trim().slice(0, max || shareTextMax()).trim();
}

function shareTrackMax()   { return 2000; }
// Entries the route will walk. Higher than the output cap so a caller whose
// list contains untitled rows still gets everything it CAN share encoded,
// rather than being refused for entries that were never going to count.
function shareInputMax()   { return 5000; }
function shareTextMax()    { return 500; }
function shareNameMax()    { return 200; }
function shareUriMax()     { return 4; }
function shareNsTrack()    { return "https://musicbrainz.org/doc/jspf#track"; }
function shareNsPlaylist() { return "https://musicbrainz.org/doc/jspf#playlist"; }

// Every value below is built into a FRESH object literal from a known field
// list, never passed through from the caller. Same pattern as sanitizeLibView
// and smartPlaylistRecord, and for the same reason: this data crosses a trust
// boundary in the import direction, so the encoder and the decoder must agree
// on a shape neither of them can be talked out of.
function shareText(v, max) {
  if (typeof v !== "string") return "";
  // Trimmed AFTER the clamp as well as before it: slicing mid-string can leave
  // a trailing space, and in a file that is never re-issued that is a different
  // canonical key from the same title without one.
  return v.replace(/\s+/g, " ").trim().slice(0, max || shareTextMax()).trim();
}

function shareInputMax()   { return 5000; }
function shareTextMax()    { return 500; }
function shareNameMax()    { return 200; }
function shareUriMax()     { return 4; }
function shareNsTrack()    { return "https://musicbrainz.org/doc/jspf#track"; }
function shareNsPlaylist() { return "https://musicbrainz.org/doc/jspf#playlist"; }

// Every value below is built into a FRESH object literal from a known field
// list, never passed through from the caller. Same pattern as sanitizeLibView
// and smartPlaylistRecord, and for the same reason: this data crosses a trust
// boundary in the import direction, so the encoder and the decoder must agree
// on a shape neither of them can be talked out of.
function shareText(v, max) {
  if (typeof v !== "string") return "";
  // Trimmed AFTER the clamp as well as before it: slicing mid-string can leave
  // a trailing space, and in a file that is never re-issued that is a different
  // canonical key from the same title without one.
  return v.replace(/\s+/g, " ").trim().slice(0, max || shareTextMax()).trim();
}

function shareTextMax()    { return 500; }
function shareNameMax()    { return 200; }
function shareUriMax()     { return 4; }
function shareNsTrack()    { return "https://musicbrainz.org/doc/jspf#track"; }
function shareNsPlaylist() { return "https://musicbrainz.org/doc/jspf#playlist"; }

// Every value below is built into a FRESH object literal from a known field
// list, never passed through from the caller. Same pattern as sanitizeLibView
// and smartPlaylistRecord, and for the same reason: this data crosses a trust
// boundary in the import direction, so the encoder and the decoder must agree
// on a shape neither of them can be talked out of.
function shareText(v, max) {
  if (typeof v !== "string") return "";
  // Trimmed AFTER the clamp as well as before it: slicing mid-string can leave
  // a trailing space, and in a file that is never re-issued that is a different
  // canonical key from the same title without one.
  return v.replace(/\s+/g, " ").trim().slice(0, max || shareTextMax()).trim();
}

function shareNameMax()    { return 200; }
function shareUriMax()     { return 4; }
function shareNsTrack()    { return "https://musicbrainz.org/doc/jspf#track"; }
function shareNsPlaylist() { return "https://musicbrainz.org/doc/jspf#playlist"; }

// Every value below is built into a FRESH object literal from a known field
// list, never passed through from the caller. Same pattern as sanitizeLibView
// and smartPlaylistRecord, and for the same reason: this data crosses a trust
// boundary in the import direction, so the encoder and the decoder must agree
// on a shape neither of them can be talked out of.
function shareText(v, max) {
  if (typeof v !== "string") return "";
  // Trimmed AFTER the clamp as well as before it: slicing mid-string can leave
  // a trailing space, and in a file that is never re-issued that is a different
  // canonical key from the same title without one.
  return v.replace(/\s+/g, " ").trim().slice(0, max || shareTextMax()).trim();
}

function shareUriMax()     { return 4; }
function shareNsTrack()    { return "https://musicbrainz.org/doc/jspf#track"; }
function shareNsPlaylist() { return "https://musicbrainz.org/doc/jspf#playlist"; }

// Every value below is built into a FRESH object literal from a known field
// list, never passed through from the caller. Same pattern as sanitizeLibView
// and smartPlaylistRecord, and for the same reason: this data crosses a trust
// boundary in the import direction, so the encoder and the decoder must agree
// on a shape neither of them can be talked out of.
function shareText(v, max) {
  if (typeof v !== "string") return "";
  // Trimmed AFTER the clamp as well as before it: slicing mid-string can leave
  // a trailing space, and in a file that is never re-issued that is a different
  // canonical key from the same title without one.
  return v.replace(/\s+/g, " ").trim().slice(0, max || shareTextMax()).trim();
}

function shareNsTrack()    { return "https://musicbrainz.org/doc/jspf#track"; }
function shareNsPlaylist() { return "https://musicbrainz.org/doc/jspf#playlist"; }

// Every value below is built into a FRESH object literal from a known field
// list, never passed through from the caller. Same pattern as sanitizeLibView
// and smartPlaylistRecord, and for the same reason: this data crosses a trust
// boundary in the import direction, so the encoder and the decoder must agree
// on a shape neither of them can be talked out of.
function shareText(v, max) {
  if (typeof v !== "string") return "";
  // Trimmed AFTER the clamp as well as before it: slicing mid-string can leave
  // a trailing space, and in a file that is never re-issued that is a different
  // canonical key from the same title without one.
  return v.replace(/\s+/g, " ").trim().slice(0, max || shareTextMax()).trim();
}

function shareNsPlaylist() { return "https://musicbrainz.org/doc/jspf#playlist"; }

// Every value below is built into a FRESH object literal from a known field
// list, never passed through from the caller. Same pattern as sanitizeLibView
// and smartPlaylistRecord, and for the same reason: this data crosses a trust
// boundary in the import direction, so the encoder and the decoder must agree
// on a shape neither of them can be talked out of.
function shareText(v, max) {
  if (typeof v !== "string") return "";
  // Trimmed AFTER the clamp as well as before it: slicing mid-string can leave
  // a trailing space, and in a file that is never re-issued that is a different
  // canonical key from the same title without one.
  return v.replace(/\s+/g, " ").trim().slice(0, max || shareTextMax()).trim();
}

function shareText(v, max) {
  if (typeof v !== "string") return "";
  // Trimmed AFTER the clamp as well as before it: slicing mid-string can leave
  // a trailing space, and in a file that is never re-issued that is a different
  // canonical key from the same title without one.
  return v.replace(/\s+/g, " ").trim().slice(0, max || shareTextMax()).trim();
}

function shareInt(v, min, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function shareUriList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const s = item.trim();
    // A scheme is what makes it a URI rather than free text that would be
    // silently mistaken for one by a reader.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) continue;
    if (s.length > shareTextMax()) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= shareUriMax()) break;
  }
  return out;
}

function sharePrune(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) continue;
    out[k] = v;
  }
  return out;
}

function shareTrackEntry(t) {
  if (!t || typeof t !== "object") return null;
  const title = shareText(t.title, shareTextMax());
  if (!title) return null;

  // Identifiers a future exporter fills in; harmless and absent until then.
  const extra = sharePrune({
    isrc:           shareText(t.isrc, 32),
    upc:            shareText(t.upc, 32),
    qobuz_album_id: shareText(t.qobuz_album_id, 64),
    tidal_album_id: shareText(t.tidal_album_id, 64),
    year:           shareInt(t.year, 1000, 2999),
    disc:           shareInt(t.disc, 1, 99),
  });

  const ext = Object.keys(extra).length
    ? { [shareNsTrack()]: { additional_metadata: extra } }
    : null;

  return sharePrune({
    title,
    creator:    shareText(t.artist, shareTextMax()),
    album:      shareText(t.album, shareTextMax()),
    trackNum:   shareInt(t.track_no, 1, 999),
    // JSPF durations are milliseconds. We have none today — Roon's browse API
    // exposes no track length — but the slot is what a duration-gated match
    // will read, and that gate is the cheapest defence against resolving a
    // live version in place of the studio take.
    duration:   shareInt(t.duration_ms, 1, 24 * 60 * 60 * 1000),
    identifier: shareUriList(t.identifier),
    location:   shareUriList(t.location),
    extension:  ext,
  });
}

function buildShareDoc(meta, entries) {
  const list = Array.isArray(entries) ? entries : [];
  const track = [];
  let skipped = 0;
  // Set only when the cap actually STOPPED us. Deriving it from the input
  // length instead was wrong in both directions of honesty: 2,100 entries of
  // which 300 were untitled encodes 1,800 tracks with nothing dropped for the
  // cap, yet reported "stopped at the sharing limit" — a false claim of
  // truncation in the one feature whose whole premise is honest accounting.
  let truncated = false;
  for (const e of list) {
    if (track.length >= shareTrackMax()) { truncated = true; break; }
    const one = shareTrackEntry(e);
    if (one) track.push(one);
    else skipped++;
  }
  const playlist = sharePrune({
    title:      shareText(meta && meta.name, shareNameMax()) || "Shared playlist",
    annotation: shareText(meta && meta.annotation, shareTextMax()),
    date:       new Date().toISOString(),
    extension: {
      [shareNsPlaylist()]: {
        additional_metadata: {
          generator: "MusicD Server",
          generator_version: VERSION,
        },
      },
    },
  });
  // Assigned AFTER pruning, because pruning drops empty arrays and JSPF's
  // trackList is the one key that must always be present: an absent trackList
  // means "malformed", an empty one means "a playlist with no tracks". Those
  // are different facts and a reader has to be able to tell them apart.
  playlist.track = track;
  return {
    doc: { playlist },
    track_count: track.length,
    skipped,
    truncated,
  };
}

function encodeSharePayload(doc) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(doc), "utf8"), { level: 9 });
  return shareMagic() + ":" + gz.toString("base64url");
}

function decodeSharePayload(blob) {
  // Deliberately forgiving about everything EXCEPT the payload itself.
  //
  // A blob makes its way here through clipboards, chat apps, mail clients and
  // hand-selection on a phone. All of those wrap lines, and mail in particular
  // inserts newlines mid-string and quote markers at the start of each one. The
  // first version demanded the magic at character zero of a trimmed string, so
  // a paste carrying so much as a leading newline — or the words the sender
  // typed around it — was rejected as "not a MusicD Remote playlist" while
  // holding a perfectly good playlist.
  //
  // So: collapse ALL whitespace, find the magic wherever it sits, and keep only
  // base64url characters after it. None of that can turn a bad blob into a
  // good one — the gzip and JSON steps below are still the real check.
  const compact = String(blob || "").replace(/\s+/g, "");
  // The marker is matched case-INSENSITIVELY because iOS autocorrect lowercases
  // it on paste, and a blob that arrives as "mdrp1:…" is otherwise perfectly
  // good. The payload's own case is left untouched — it is base64url, where
  // case carries meaning, so nothing after the marker may be normalised.
  const at = compact.toUpperCase().indexOf(shareMagic().toUpperCase() + ":");
  if (at < 0) {
    throw new Error(
      `That doesn't look like a MusicD Remote playlist — it should contain "${shareMagic()}:"`);
  }
  const payload = compact.slice(at + shareMagic().length + 1).replace(/[^A-Za-z0-9_-]/g, "");
  if (!payload) throw new Error("That playlist is empty — nothing followed the marker");

  // Trailing prose cannot be separated by inspection: "Enjoy" is as valid a
  // base64url string as the payload is, so stripping non-base64url characters
  // leaves the sender's own words glued to the end. What CAN separate them is
  // gzip's checksum — only the exact right byte sequence passes it. So on
  // failure, shave characters off the end and retry, bounded. A wrong length
  // fails the CRC rather than yielding plausible garbage, which is what makes
  // this safe rather than a guess.
  let json = null;
  for (let cut = 0; cut <= 40 && cut < payload.length; cut++) {
    try {
      json = zlib.gunzipSync(Buffer.from(payload.slice(0, payload.length - cut), "base64url"))
                 .toString("utf8");
      break;
    } catch (e) { /* not this length — try one shorter */ }
  }
  if (json === null) {
    throw new Error("That playlist is damaged — it may have been cut short in transit");
  }
  let doc;
  try { doc = JSON.parse(json); }
  catch (e) { throw new Error("That playlist is damaged — the contents didn't parse"); }
  if (!doc || !doc.playlist || !Array.isArray(doc.playlist.track)) {
    throw new Error("That playlist has no tracks in it");
  }
  return doc;
}
module.exports = { shareText, shareInt, buildShareDoc, encodeSharePayload, decodeSharePayload,
  shareInputMax, shareTextMax, shareTrackMax };
