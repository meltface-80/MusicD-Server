"use strict";
/*
 * normalize.js — folding names so that two spellings of the same thing meet.
 *
 * "The Beatles" / "Beatles, The" / "the beatles" are one artist; "Kid A" and
 * "KID A (Remastered)" are close enough to find each other when a write-up or
 * a review is looked up by name. Library identity (what an album IS) uses the
 * strict fold; lookups against the outside world use the loose one.
 */

function fold(s) {
  return String(s == null ? "" : s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Library identity: case, accents and punctuation do not make a new album.
function key(s) { return fold(s); }

// "The Beatles" and "Beatles, The" sort as "Beatles".
function sortName(s) {
  const t = String(s || "").trim();
  const m = t.match(/^(.*),\s*(the|a|an)$/i);
  const base = m ? m[1] : t.replace(/^(the|a|an)\s+/i, "");
  return fold(base);
}

// Looser: drops edition noise so a lookup by title finds the record.
const EDITION = /\s*[([][^)\]]*(remaster|deluxe|edition|expanded|anniversary|bonus|mono|stereo|version|reissue|explicit|clean)[^)\]]*[)\]]\s*/gi;
function loose(s) {
  return fold(String(s || "").replace(EDITION, " "));
}

// "A feat. B", "A & B", "A; B" → ["A", "B"]. Used to offer a link per artist.
function splitArtists(credit) {
  const s = String(credit || "").trim();
  if (!s) return [];
  return s
    .split(/\s*(?:;|\/|,(?!\s*(?:the|jr|sr)\b)|\s+feat\.?\s+|\s+featuring\s+|\s+ft\.?\s+|\s+with\s+|\s+&\s+|\s+and\s+|\s+x\s+|\s+vs\.?\s+)\s*/i)
    .map(x => x.trim())
    .filter(Boolean);
}

module.exports = { fold, key, sortName, loose, splitArtists };
