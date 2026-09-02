/*
 * MusicD Server — telling two albums apart, and telling two copies together.
 *
 * Everything in here is a pure string function over what is already in the
 * library: album titles, artist names, track titles. Nothing here asks the
 * internet anything, and nothing here decides what a record IS — it only
 * decides whether two folders on this disk are two copies of the same one.
 *
 * That distinction is the whole design. Duplicate collapsing and the search
 * for a missing cover both need to say "this album, roughly" rather than
 * "this exact string", and they must say it the SAME way or an album could be
 * folded into a group whose cover was fetched under a different name. One
 * module, one set of rules, two callers.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

/* Accents off, case off. NFKD splits "é" into "e" + a combining accent, and the
   range below is every combining mark — so this folds "Björk" onto "bjork"
   without a lookup table. */
function fold(s) {
  return String(s == null ? "" : s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/*
 * The comparison form of a title: folded, with every run of punctuation turned
 * into one space. Turning punctuation into a SPACE rather than dropping it is
 * what keeps "Rock'n'Roll" and "Rock n Roll" together while leaving
 * "Homework" and "Home Work" apart.
 */
function normalise(s) {
  return fold(s).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/*
 * The comparison form of an ARTIST name, which is a different job.
 *
 * normalise() turns punctuation into a space, so "P!nk" becomes "p nk" and
 * never meets "pink". An artist name is an identity rather than a phrase: the
 * stylised characters stand in for letters, and once they are put back
 * everything else can go, spaces included — which is what makes "AC/DC" and
 * "ACDC" the same act.
 */
function artistKey(s) {
  return fold(s)
    .replace(/(?<=[a-z0-9])!(?=[a-z0-9])/g, "i")   // an in-word ! is an i: P!nk
    .replace(/\$/g, "s")                            // $ is an s: Ke$ha, A$AP
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "");
}

/*
 * The words an edition marker is made of.
 *
 * A trailing "(...)" or "— ..." on an album title counts as an edition marker
 * only when EVERY word in it is in this list. That is the conservative
 * direction on purpose: an unknown word means "this is part of the title",
 * so "(Live at Leeds)", "(Instrumental)" and "(feat. Someone)" are left alone
 * and the albums stay separate — which is right, because a live record and a
 * studio record are two records however similar their names.
 *
 * MARKERS are the words that MAKE something an edition; FILLERS are only
 * allowed to keep them company. A tail made of nothing but fillers — "(The)" —
 * is not a marker.
 */
const MARKERS = new Set([
  "deluxe", "superdeluxe", "expanded", "extended", "special", "collector",
  "collectors", "anniversary", "remaster", "remastered", "remasters",
  "remastering", "reissue", "reissued", "edition", "version", "bonus",
  "mono", "stereo", "definitive", "legacy", "ultimate", "complete",
  "platinum", "gold", "limited", "explicit", "clean", "digital", "hd",
  "japanese", "japan", "international", "import", "standard", "original"
]);

const FILLERS = new Set([
  "the", "a", "an", "and", "with", "plus", "of", "in", "for", "track", "tracks",
  "super", "new", "year", "years", "editions", "versions", "re"
]);

/* A year (1965), an ordinary number (2), or an ordinal (20th). All three turn
   up inside edition markers — "2011 Remaster", "20th Anniversary Edition",
   "Deluxe 2 CD" — and none of them is a word worth listing. */
const NUMBERY = /^(?:\d{1,4}|\d{1,3}(?:st|nd|rd|th))$/;

function isEditionPhrase(text) {
  const words = normalise(text).split(" ").filter(Boolean);
  if (!words.length) return false;
  let markers = 0;
  for (const w of words) {
    if (MARKERS.has(w)) { markers++; continue; }
    if (FILLERS.has(w) || NUMBERY.test(w)) continue;
    return false;                                   // an unknown word: not a marker
  }
  return markers > 0;
}

/*
 * A trailing marker, bracketed or introduced by a dash or colon.
 *
 * The second alternative deliberately stops at the next punctuation, so
 * "Sgt. Pepper — Deluxe Edition" gives up "Deluxe Edition" and not the whole
 * back half of a title that happens to contain a dash earlier on.
 */
const TAIL_RE = /\s*(?:[([{]\s*([^)\]}]*?)\s*[)\]}]|[-–—:,]\s*([^-–—:,()[\]{}]+?))\s*$/;

/* Two markers on one title is normal — "(Deluxe Edition) (2011 Remaster)" —
   so the loop peels rather than matching once. Four is far past anything real
   and stops a pathological title spinning. */
const MAX_MARKERS = 4;

/*
 * Split an album title into the record's name and the edition it is.
 *
 * Returns { base, editions } where `editions` is in the order the title wrote
 * them and `base` is what is left. A title that is ONLY an edition marker
 * keeps its own name: "Deluxe" is a real album by Better Than Ezra, and
 * emptying it would fold it into every other untitled thing.
 */
function splitEdition(title) {
  let rest = String(title == null ? "" : title).trim();
  const editions = [];
  for (let i = 0; i < MAX_MARKERS; i++) {
    const m = TAIL_RE.exec(rest);
    if (!m) break;
    const inner = (m[1] !== undefined ? m[1] : m[2]) || "";
    if (!isEditionPhrase(inner)) break;
    const shorter = rest.slice(0, m.index).trim();
    if (!shorter) break;                            // the marker IS the title
    editions.unshift(inner.trim());
    rest = shorter;
  }
  return { base: rest || String(title || "").trim(), editions };
}

/* What the tab on the album screen is called. An album with no marker is the
   "Standard" one — the word is only ever shown next to at least one edition
   tab, so it reads as a contrast rather than a claim. */
function editionLabel(title) {
  const { editions } = splitEdition(title);
  return editions.length ? editions.join(" · ") : "Standard";
}

/*
 * The key two copies of one record share.
 *
 * Artist identity plus the title with its edition marker taken off. An empty
 * key means "do not group this" — a blank artist or a title that normalises to
 * nothing cannot be matched against anything without matching everything.
 */
function groupKey(artist, title) {
  const a = artistKey(artist);
  const t = normalise(splitEdition(title).base);
  if (!a || t.length < 2) return "";
  return a + "|" + t;
}

/*
 * The comparison form of a TRACK title.
 *
 * A leading track number comes off. The scanner falls back to the filename
 * when a file carries no title tag, so an untagged rip yields "01 Wasting the
 * Dawn" where the tagged copy of the same record yields "Wasting the Dawn" —
 * and two rips from different sources is exactly the case duplicate folding
 * exists for. Compared literally they share nothing, and the pair stays on the
 * shelf as two albums.
 *
 * "99 Problems" loses its number too, and that is fine: this key is only ever
 * used to compare two albums that ALREADY agree about their artist and title,
 * so the only thing it can do is make a real pair easier to recognise. It
 * cannot introduce a match on its own — Weezer's Blue and Green albums share
 * no track names with or without their numbers.
 */
const LEADING_INDEX_RE = /^\d{1,3} (?=.*[a-z])/;
function trackTitleKey(title) {
  let key = normalise(title);
  /* Twice at most: "1-01 Title" normalises to "1 01 title", which is a disc
     and a track and both are numbering rather than name. */
  for (let i = 0; i < 2 && LEADING_INDEX_RE.test(key); i++) {
    key = key.replace(LEADING_INDEX_RE, "");
  }
  return key;
}

/*
 * How much two track lists agree, 0 to 1, measured against the SHORTER one.
 *
 * Against the shorter is the point: a deluxe edition is the standard edition
 * plus extras, so it can never overlap more than a fraction of itself, and
 * measuring against the union would push every genuine pair below any useful
 * threshold. Against the shorter, a standard edition fully contained in a
 * deluxe scores 1.
 */
function tracklistOverlap(a, b) {
  const left = new Set(a.map(trackTitleKey).filter(Boolean));
  const right = new Set(b.map(trackTitleKey).filter(Boolean));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const t of left) if (right.has(t)) shared++;
  return shared / Math.min(left.size, right.size);
}

/*
 * The evidence a shared name is not enough on its own.
 *
 * "Weezer" by Weezer is four different albums; so is every self-titled record
 * an artist made twice. Name matching alone folds them into one, which loses
 * three albums and is far worse than missing a duplicate — so a group is only
 * a group when most of the shorter track list is in the longer one too.
 */
const SAME_RECORD = 0.6;

function sameRecord(tracksA, tracksB) {
  return tracklistOverlap(tracksA, tracksB) >= SAME_RECORD;
}

module.exports = {
  fold, normalise, artistKey,
  splitEdition, editionLabel, isEditionPhrase,
  groupKey, trackTitleKey, tracklistOverlap, sameRecord, SAME_RECORD
};
