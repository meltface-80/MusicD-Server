/*
 * MusicD Server — Random Album Radio.
 *
 * A queue that does not run out. With the radio on, another album is added
 * behind whatever is playing before the last one in the queue is reached, so
 * an evening that started with one record keeps going.
 *
 * WHY THIS IS ON THE SERVER. Everything else the app does is driven by a phone
 * that is awake and looking at it. This is not: the queue has to keep filling
 * while the phone is in a pocket, asleep, or not on the network at all. The
 * poll loop in lib/playback.js is already watching every coordinator every few
 * seconds to credit plays, so the radio rides on that and needs nothing else
 * running. The settings live in the DATABASE for the same reason — this is
 * something the server does, not something a phone looks like.
 *
 * WHAT IT IS NOT. It does not identify anything, ask the internet anything, or
 * generate a playlist. It picks a row out of the library at random. The only
 * cleverness is the genre option, and that is an exact match on the tag the
 * files already carry — not a similarity, not a recommendation, and nothing
 * that needs a model or a service to work out.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const { normalise } = require("./match");
const { albumNames } = require("./db");

const ENABLED_KEY = "radio.enabled";
const GENRE_KEY = "radio.matchGenre";

/*
 * A queue this long stops being topped up.
 *
 * Not a limit anybody should meet: the radio adds one album only when
 * everything after the current track is the album already playing, so it can
 * only add one per album. This is the backstop for the case that reasoning is
 * wrong about — a queue the Sonos app has been editing at the same time, say —
 * because a runaway loop here would fill a speaker's queue with thousands of
 * tracks and there is no undo for that.
 */
const MAX_QUEUE = 500;

function createRadio({ db, settings }) {
  const NAME = albumNames();

  /* Off unless somebody asked for it. A queue that grows on its own is a
     surprise, and a feature that surprises somebody who never turned it on is
     a bug however well it works. */
  let enabled = settings.get(ENABLED_KEY) === "1";
  /* On by default ONCE THE RADIO IS ON: an evening of one genre is what most
     people mean by radio, and the setting is right there to turn off. It has
     no effect at all while the radio is off. */
  let matchGenre = settings.get(GENRE_KEY) !== "0";

  function status() {
    return { enabled, matchGenre };
  }

  function setEnabled(on) {
    enabled = !!on;
    settings.set(ENABLED_KEY, enabled ? "1" : "0");
    return status();
  }

  function setMatchGenre(on) {
    matchGenre = !!on;
    settings.set(GENRE_KEY, matchGenre ? "1" : "0");
    return status();
  }

  /*
   * A random album that is not one of `exclude`.
   *
   * Primaries only, and present only: a deluxe reissue is the same record as
   * the album it sits behind, so offering both would play the same music twice
   * under two names, and an album on a NAS that is not mounted would queue a
   * dozen tracks that cannot be fetched.
   *
   * `genre` narrows it when the option is on. The comparison is the album's
   * genre tag, normalised — "Art Rock" and "art rock" are one genre, and
   * "Art Rock" and "Rock" are two. Matching those loosely would be a guess
   * about what a genre MEANS, which is the kind of thing this project does not
   * do; an exact match is a fact about the tags.
   */
  function pick({ genre = "", exclude = [] } = {}) {
    const holes = exclude.length ? exclude.map(() => "?").join(",") : "''";
    const base =
      `SELECT id, ${NAME.title} AS title, ${NAME.artist} AS artist, genre
       FROM albums
       WHERE present = 1 AND version_of = '' AND track_count > 0
         AND id NOT IN (${holes})`;

    const want = normalise(genre);
    if (want) {
      /* SQLite has no normalise(), so the shortlist is narrowed in SQL by the
         raw tag being non-empty and then matched here. A library's genre
         column is short and this runs once per album, not once per track. */
      const sameGenre = db.prepare(`${base} AND genre <> ''`).all(...exclude)
        .filter(a => normalise(a.genre) === want);
      if (sameGenre.length) return sameGenre[Math.floor(Math.random() * sameGenre.length)];
      /* NOTHING ELSE IN THAT GENRE, so the radio falls through to any album
         rather than stopping. An untagged record, or the only jazz album in
         the house, would otherwise end the evening — and silence is a worse
         answer to "keep playing" than a record from somewhere else. */
    }

    const any = db.prepare(`${base} ORDER BY RANDOM() LIMIT 1`).get(...exclude);
    return any || null;
  }

  /*
   * Is everything left in the queue the album that is playing?
   *
   * That is the moment to add another: the last album has been reached, and
   * without a new one the music stops when it ends. Asked of the tail of the
   * queue rather than the whole of it, and only when a new track starts — see
   * the caller in lib/playback.js.
   *
   * An item this server did not queue counts as a different album, because it
   * is: something added from the Sonos app is music that is still to come, and
   * the radio has nothing to do until it has been heard.
   */
  function atLastAlbum(remaining, albumId) {
    if (!remaining.length) return true;
    return remaining.every(item => item.albumId === albumId);
  }

  /* Whether to bother asking the speaker at all. Keeps the extra SOAP call out
     of the poll loop entirely for anybody who has not turned the radio on. */
  function wanted() { return enabled; }

  return { status, setEnabled, setMatchGenre, pick, atLastAlbum, wanted, MAX_QUEUE };
}

module.exports = { createRadio, ENABLED_KEY, GENRE_KEY, MAX_QUEUE };
