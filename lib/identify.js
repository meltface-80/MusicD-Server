/*
 * MusicD Server — saying WHICH RECORD an album is.
 *
 * The library is still the files, and this changes none of them. What it does
 * is let a person confirm, once, that the folder they are looking at is a
 * particular MusicBrainz release — and it stores that release's id and NOTHING
 * ELSE. No title, no artist, no year, no genre, no tag rewritten anywhere.
 *
 * WHY AN ID IS WORTH HAVING ON ITS OWN. The release id is the only exact
 * identity this app can hold: with one, lib/covers.js asks the Cover Art
 * Archive about THAT release instead of searching by a name, so there is no
 * scoring, no near-miss, and no way to end up with another record's sleeve.
 * The albums that need it most are the ones whose tags are worst, which are
 * exactly the ones a name search cannot rescue.
 *
 * BY HAND, AND ONLY BY HAND. There is no sweep here and nothing on a timer.
 * A search always answers — that is the danger lib/info.js is built around too
 * — and a wrong identification is worse than none because nobody reports it;
 * it just quietly attaches the wrong record. So a person looks at the
 * candidates, with the track count and the year beside each, and taps one.
 * Nothing is written until they do.
 *
 * WHAT IT ASKS. One MusicBrainz request, through lib/covers.js's gate — the
 * one gate this application has, because the rate limit is per application.
 * No key, no account.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const { normalise, artistAgrees, titleRank, splitEdition } = require("./match");
const { albumNames, albumMbid } = require("./db");

const NAME = albumNames("a");
const MBID = albumMbid("a");

/* Lucene escaping, the same as lib/covers.js: an album called "Where Are We
   Now?" is a syntax error otherwise, and "AC/DC Live" is a field query for
   nothing. */
function quote(s) {
  return String(s || "").replace(/([+\-!(){}[\]^"~*?:\\/])/g, "\\$1");
}

/* A MusicBrainz id and nothing else. A malformed one must never become a URL
   or a stored identity. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* The offered list is held HERE, and the client answers with a position.
   Exactly the rule the cover picker follows: a server that acts on an id a
   client hands it is a server acting on something it never checked. */
const OFFER_TTL_MS = 10 * 60 * 1000;

/* Six: enough to tell a reissue from an original and short enough to read
   without scrolling a dialog. */
const SHOWN = 6;

function createIdentify({ db, covers, available = true }) {
  const offers = new Map();

  function status() {
    return { available: !!available };
  }

  function albumRow(albumId) {
    return db.prepare(
      `SELECT a.id, ${NAME.title} AS title, ${NAME.artist} AS artist,
              a.mbid_chosen AS chosen, ${MBID} AS mbid,
              (SELECT COUNT(*) FROM tracks t
               WHERE t.album_id = a.id AND t.present = 1) AS tracks
       FROM albums a WHERE a.id = ?`).get(albumId) || null;
  }

  /* What this album is currently believed to be, and how that was decided.
     "the tags" and "you confirmed it" are different answers and the dialog
     says which — a person who is about to change one wants to know whether
     they are overruling a file or their own earlier tap. */
  function current(albumId) {
    const row = albumRow(albumId);
    if (!row) return null;
    return {
      mbid: row.mbid || "",
      from: row.chosen ? "chosen" : (row.mbid ? "tags" : ""),
      tracks: row.tracks
    };
  }

  /*
   * How strongly a MusicBrainz release answers "is this the record on disk".
   *
   * The artist and the title are gates rather than points: a release by
   * somebody else, or with no relation to the name asked about, is not a
   * weaker candidate but a wrong one, and offering it at the bottom of a list
   * is how somebody taps it at half past eleven. What is left is ORDERED, and
   * the strongest signal by far is the track count — a name can be shared by a
   * dozen records, and a name plus an exact track count almost never is.
   */
  function score(release, want) {
    const credit = (release["artist-credit"] || [])
      .map(c => (c && (c.name || (c.artist && c.artist.name))) || "").join(" ");
    if (!artistAgrees(credit, want.artist)) return 0;
    const rank = titleRank(release.title || "", want.base);
    if (!rank) return 0;

    let points = rank * 10;
    const tracks = Number(release["track-count"]) || 0;
    if (tracks && want.tracks) {
      if (tracks === want.tracks) points += 8;
      else if (Math.abs(tracks - want.tracks) <= 1) points += 3;
      /* A release with twice the tracks is the box set, not this record. */
      else if (tracks > want.tracks * 1.5) points -= 4;
    }
    /* MusicBrainz's own confidence, worth a little and never enough to
       outrank the library's own facts. */
    points += (Number(release.score) || 0) / 100 * 2;
    /* An official release beats a promo or a bootleg of the same name. */
    if (String(release.status || "").toLowerCase() === "official") points += 1;
    return points;
  }

  /* The line under a candidate's name: the facts a person compares. */
  function describe(release) {
    const bits = [];
    const tracks = Number(release["track-count"]) || 0;
    if (tracks) bits.push(`${tracks} track${tracks === 1 ? "" : "s"}`);
    const year = /^(\d{4})/.exec(String(release.date || ""));
    if (year) bits.push(year[1]);
    const media = (release.media || [])
      .map(m => m && m.format).filter(Boolean);
    if (media.length) bits.push([...new Set(media)].join(", "));
    if (release.country) bits.push(release.country);
    if (release.disambiguation) bits.push(release.disambiguation);
    return bits.join(" · ");
  }

  /*
   * The releases this album might be, best first.
   *
   * The title and artist come from the CALLER, not the database, so a name
   * corrected in the dialog is the name searched with — before it is saved, if
   * that is what the person wants to try. The same rule the cover picker
   * follows, and for the same reason: the albums that need identifying are the
   * ones whose stored names are wrong.
   */
  async function candidatesFor(albumId, title, artist) {
    if (!available) throw new Error("Identifying albums is switched off on this server.");
    const row = albumRow(albumId);
    if (!row) throw new Error("No such album.");

    const name = String(title || row.title || "").trim();
    const who = String(artist || row.artist || "").trim();
    const base = splitEdition(name).base;
    if (!base || !who) {
      throw new Error("Fill in the album and artist first — there is nothing to search on.");
    }

    const query = `release:"${quote(base)}" AND artist:"${quote(who)}"`;
    const body = await covers.searchMusicBrainz("release", query, 25);
    const want = { artist: who, base, tracks: row.tracks };

    const scored = [];
    for (const release of body.releases || []) {
      if (!release || !UUID.test(String(release.id || ""))) continue;
      const points = score(release, want);
      if (points <= 0) continue;
      scored.push({
        points,
        id: release.id,
        title: String(release.title || ""),
        artist: (release["artist-credit"] || [])
          .map(c => (c && (c.name || (c.artist && c.artist.name))) || "").join(", "),
        why: describe(release),
        /* Whether this release has the same number of tracks as the folder,
           called out because it is the one fact a person can check at a
           glance without knowing anything about MusicBrainz. */
        sameLength: (Number(release["track-count"]) || 0) === row.tracks
      });
    }
    scored.sort((a, b) => b.points - a.points);

    /* Identical titles from the same artist are reissues of one record; the
       list is more useful showing six DIFFERENT pressings than six copies of
       the same one, so an exact repeat of a name already offered is dropped
       unless its length differs. */
    const seen = new Set();
    const shown = [];
    for (const c of scored) {
      const key = normalise(c.title) + "|" + c.why;
      if (seen.has(key)) continue;
      seen.add(key);
      shown.push(c);
      if (shown.length >= SHOWN) break;
    }

    offers.set(albumId, { at: Date.now(), list: shown });
    return shown.map((c, i) => ({
      i, title: c.title, artist: c.artist, why: c.why, sameLength: c.sameLength
    }));
  }

  /* Take one of the offers above and make it this album's identity. BY
     POSITION: the id stored is the one the server offered, never one that
     arrived from a phone. */
  function chooseFor(albumId, index) {
    const held = offers.get(albumId);
    if (!held || Date.now() - held.at > OFFER_TTL_MS) {
      throw new Error("Those results have expired — search again.");
    }
    const chosen = held.list[Number(index)];
    if (!chosen) throw new Error("That is not one of the results.");
    db.prepare("UPDATE albums SET mbid_chosen = ? WHERE id = ?").run(chosen.id, albumId);
    offers.delete(albumId);
    return current(albumId);
  }

  /* Undo it. The tag underneath is untouched, so an album whose files carry an
     id falls back to that rather than to nothing. */
  function clearFor(albumId) {
    db.prepare("UPDATE albums SET mbid_chosen = '' WHERE id = ?").run(albumId);
    offers.delete(albumId);
    return current(albumId);
  }

  return { status, current, candidatesFor, chooseFor, clearFor };
}

module.exports = { createIdentify };
