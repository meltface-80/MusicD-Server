/*
 * MusicD Server — ids in URLs.
 *
 * An album or track id is its path relative to the library root, which is
 * readable in a database but full of slashes, spaces and accents. Those
 * survive Express fine and then get mangled by the first reverse proxy that
 * normalises %2F — and a Sonos player fetching a track URL is one more hop
 * that has to agree about it. base64url sidesteps the argument entirely.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

function encodeId(id) { return Buffer.from(String(id), "utf8").toString("base64url"); }

function decodeId(token) {
  try {
    const s = Buffer.from(String(token), "base64url").toString("utf8");
    return s || null;
  } catch {
    /* Not valid base64url. A malformed id in a URL is a 404 at the call
       site, which is exactly what a null produces there. */
    return null;
  }
}

module.exports = { encodeId, decodeId };
