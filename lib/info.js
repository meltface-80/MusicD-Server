/*
 * MusicD Server — what a record is, and who made it.
 *
 * The second thing in this app that reaches the internet, after lib/covers.js,
 * and it is built to the same rules for the same reasons.
 *
 * WHAT THIS IS NOT. It does not identify albums. Nothing it learns is written
 * back into the library: not a title, not an artist, not a year, and above all
 * not a grouping. lib/duplicates.js decides which folders are one record by
 * looking at the disk, and if Wikipedia disagrees, Wikipedia is wrong here —
 * because a regroup MOVES the demoted copy's play counts onto the primary, and
 * a wrong guess from a website would cost a listening history that no amount
 * of correcting afterwards brings home. This module reads. It never writes to
 * the albums table.
 *
 * WHY WIKIPEDIA. Not preference — permission. Wikipedia's prose is CC BY-SA
 * and may be shown as long as it is credited and linked. AllMusic's is not,
 * which is why an app that wants to print a paragraph either uses an open
 * source or does not print the paragraph. Last.fm's artist and album wikis are
 * CC BY-SA on the same terms, and this project already holds a Last.fm key, so
 * it is the natural second source: Wikipedia is excellent on records that
 * matter and silent on bootlegs, and Last.fm is the other way round.
 *
 * WHY THE OLD URL. Wikipedia has three ways to ask for a summary and two of
 * them carry deprecation notices — /api/rest_v1/ is served by RESTBase, which
 * is being retired, and api.wikimedia.org/core/v1 is itself scheduled for
 * gradual deprecation. /w/api.php, the Action API, is twenty years old, has no
 * notice against it, and is the only one that can run a search AND return the
 * text of every hit in a single request. Releases 0.4.0 to 0.4.3 shipped a
 * broken updater because of a header on the wrong GitHub endpoint; picking an
 * endpoint that is already on its way out would be the same mistake with a
 * longer fuse.
 *
 * A SEARCH ALWAYS ANSWERS. That is the whole danger. Ask Wikipedia about an
 * album it has never heard of and it will hand back the five most plausible
 * pages it has, and the first of them will look like a result. So every
 * candidate is checked against the library's own facts before it is believed —
 * see verify() — and an album with no confident match is recorded as a MISS
 * and shows nothing. A wrong biography is worse than an absent one, because
 * nobody reports it: it just sits there reading plausibly about the wrong band.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const { normalise, artistKey, splitEdition } = require("./match");
const { albumNames, headAlbum } = require("./db");

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKI_PAGE = "https://en.wikipedia.org/wiki/";
const WIKI_LICENCE = "CC BY-SA 4.0";
const LASTFM_LICENCE = "CC BY-SA 3.0";

const REQUEST_TIMEOUT_MS = 15000;

/*
 * A miss is retried after a week; a hit is never retried at all.
 *
 * The asymmetry is the point. An encyclopaedia article about a 1988 record is
 * not going to become a different article, so re-asking for it would spend
 * somebody else's bandwidth to be told the same thing. A miss is the opposite:
 * an album with no article today may have one next year, and a permanent miss
 * would mean never finding out.
 */
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/*
 * Wikipedia's own limit is two hundred requests a second, which this could not
 * approach if it tried — the whole feature is one request when somebody opens
 * a screen. The gate is here anyway, for the same reason covers.js has one: it
 * is what makes the app a polite client rather than one that happens never to
 * have been rude yet.
 */
const GAP_MS = 250;

/* Long enough for an article's opening, short enough that nothing on a phone
   has to scroll for a minute to get past it. Cut at a sentence. */
const MAX_SUMMARY = 1500;
const MAX_REVIEW = 2500;

/*
 * Who is calling.
 *
 * Wikimedia asks every client to identify itself with an application, a
 * version and a way to make contact, and answers a client that does not with a
 * 403. The project's own URL is the contact: this is a program people run at
 * home, and putting an installation's address in here would be publishing it.
 */
function userAgent(version) {
  return `MusicD-Server/${version || "0"} ( https://github.com/meltface-80/MusicD-Server )`;
}

/* ------------------------------------------------------------------ */
/*  Reading what came back                                             */
/* ------------------------------------------------------------------ */

/* Cut to length at a sentence end rather than mid-word. A paragraph that stops
   in the middle of a clause reads as a bug; one that stops at a full stop
   reads as an extract. */
function clamp(text, max) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  return (stop > max * 0.4 ? cut.slice(0, stop + 1) : cut.trimEnd()) + " …";
}

/*
 * A section out of a plain-text article.
 *
 * TextExtracts renders headings into the plain text, and this is written not
 * to care exactly how: a line that is the heading between equals signs and a
 * line that is only the heading both count. Being tolerant here costs one
 * alternation and saves the whole feature from a formatting change nobody
 * would notice until an album screen went quiet.
 *
 * Everything up to the next heading of any level is the section. A heading is
 * a short line, on its own, that is either wrapped in equals signs or is title
 * case with no sentence punctuation — which is what an article's "Track
 * listing" and "Personnel" look like once the markup is gone.
 */
const EQUALS_HEADING = /^\s*=+\s*(.+?)\s*=+\s*$/;

function isHeading(line) {
  const t = line.trim();
  if (!t) return false;
  if (EQUALS_HEADING.test(t)) return true;
  /* A bare heading: short, no terminal punctuation, no sentence commas. */
  return t.length <= 48 && !/[.!?,;:]$/.test(t) && /^[A-Z]/.test(t) && t.split(/\s+/).length <= 6;
}

function headingText(line) {
  const m = EQUALS_HEADING.exec(line.trim());
  return (m ? m[1] : line).trim().toLowerCase();
}

function section(text, wanted) {
  const lines = String(text || "").split("\n");
  const names = wanted.map(w => w.toLowerCase());
  let out = null;
  for (const line of lines) {
    if (isHeading(line)) {
      const name = headingText(line);
      if (out !== null) break;                       // the next heading ends it
      if (names.includes(name)) { out = []; }
      continue;
    }
    if (out !== null) out.push(line);
  }
  if (!out) return "";
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* Last.fm's wiki text is HTML-ish and ends with its own "Read more" link. The
   link is replaced by our own credit rather than passed through, so every
   source is credited in one place and in one voice. */
function stripHtml(html) {
  return String(html || "")
    .replace(/<a\b[^>]*>\s*Read more[\s\S]*?<\/a>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ------------------------------------------------------------------ */
/*  Believing it                                                       */
/* ------------------------------------------------------------------ */

/* Words that say the subject of an article is a musician. An artist page that
   contains none of them is a page about somebody or something else with the
   same name, which is the ordinary case rather than the exotic one — "Hex",
   "Bark Psychosis" and "Girls" are all pages about several things. */
const MUSIC_WORDS = [
  "band", "singer", "songwriter", "musician", "rapper", "duo", "trio",
  "quartet", "album", "ep", "record", "music", "guitarist", "drummer",
  "bassist", "vocalist", "composer", "producer", "dj", "orchestra", "choir",
  "discography", "recording"
];

function mentionsMusic(text) {
  const words = new Set(normalise(text).split(" "));
  return MUSIC_WORDS.some(w => words.has(w));
}

/*
 * Does this page name the artist?
 *
 * Compared through artistKey(), which is the app's own idea of artist identity
 * — AC/DC and ACDC are one act, P!nk and Pink are one act — so a page that
 * writes the name differently from the tags still counts. The extract is
 * folded the same way and searched for the key as a substring, because the
 * name appears inside sentences rather than as a field.
 */
function namesArtist(text, artist) {
  const key = artistKey(artist);
  /* A one or two character key matches inside half the words in English. An
     artist whose name folds that short cannot be verified this way, so the
     check abstains rather than passing everything. */
  if (key.length < 3) return false;
  return artistKey(text).includes(key);
}

/* A disambiguation page is never the answer. It carries no prose about
   anything and picking one would attach a list of unrelated links to a record. */
function isDisambiguation(page) {
  const props = page.pageprops || {};
  if ("disambiguation" in props) return true;
  return /\bmay refer to\b|\bmay also refer to\b/i.test(page.extract || "");
}

/* ------------------------------------------------------------------ */
/*  The module                                                         */
/* ------------------------------------------------------------------ */

/*
 * deps:
 *   db          the library
 *   version     for the User-Agent
 *   lastfm      the scrobbler, used read-only as a fallback source
 *   available   the container's answer — INFO_LOOKUP
 *   fetchImpl   a stand-in, for the tests
 *   apiRoot     ditto
 */
function createInfo({ db, version, lastfm = null, available = true,
                      fetchImpl = null, apiRoot = WIKI_API, gapMs = GAP_MS } = {}) {
  const http = fetchImpl || ((...args) => fetch(...args));
  const UA = userAgent(version);
  const NAME = albumNames();

  /* One promise per key while a fetch is in flight. Opening an album screen
     twice before the first answer lands must not send a second request — and
     on a phone that is a double tap, not an edge case. */
  const inflight = new Map();

  /* ---------------------------------------------------------------- */
  /*  The rate gate                                                    */
  /* ---------------------------------------------------------------- */

  let chain = Promise.resolve();
  let lastCall = 0;

  function wait() {
    const mine = chain.then(async () => {
      const gap = lastCall + gapMs - Date.now();
      if (gap > 0) await new Promise(r => setTimeout(r, gap));
      lastCall = Date.now();
    });
    /* One caller's rejection must not poison the queue behind it — the chain
       is a turn-taking order, not a dependency. */
    chain = mine.catch(() => {});
    return mine;
  }

  async function ask(params) {
    await wait();
    const query = new URLSearchParams({ format: "json", formatversion: "2", ...params });
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await http(apiRoot + "?" + query.toString(), {
        headers: { "User-Agent": UA, "Accept": "application/json" },
        redirect: "follow",
        signal: control.signal
      });
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new Error("Wikipedia answered " + res.status);
    return await res.json();
  }

  /* ---------------------------------------------------------------- */
  /*  Wikipedia                                                        */
  /* ---------------------------------------------------------------- */

  /*
   * Search and read in ONE request.
   *
   * exlimit is the parameter this turns on. It defaults to 1, so without it
   * the answer is five search results and one extract — which works perfectly
   * until the right page is the second hit, and then fails silently for ever.
   * Multiple extracts are only returned at all when exintro is set, which is
   * why the full article for the chosen page is a second request rather than
   * something that could have come back with the candidates.
   */
  async function search(term, limit = 5) {
    const body = await ask({
      action: "query",
      generator: "search",
      gsrsearch: term,
      gsrlimit: String(limit),
      gsrnamespace: "0",
      prop: "extracts|pageprops",
      exintro: "1",
      explaintext: "1",
      exlimit: String(limit),
      redirects: "1"
    });
    const pages = (body && body.query && body.query.pages) || [];
    /* formatversion 2 gives an array; a server that ignored it gives an object
       keyed by page id. Accept both rather than depend on the parameter. */
    return Array.isArray(pages) ? pages : Object.values(pages);
  }

  async function fullText(title) {
    const body = await ask({
      action: "query",
      titles: title,
      prop: "extracts",
      explaintext: "1",
      redirects: "1"
    });
    const pages = (body && body.query && body.query.pages) || [];
    const list = Array.isArray(pages) ? pages : Object.values(pages);
    return (list[0] && list[0].extract) || "";
  }

  function pageUrl(title) {
    return WIKI_PAGE + encodeURIComponent(String(title).replace(/ /g, "_"));
  }

  /*
   * Which candidate, if any, is the record.
   *
   * Two things have to be true and neither is negotiable: the page must not be
   * a disambiguation, and its opening must name the artist. Beyond that the
   * best page is the one whose title is the album's own — allowing for
   * Wikipedia's habit of disambiguating in the title itself, so "Hex (Bark
   * Psychosis album)" is a better answer for Hex than "Hex" ever was.
   */
  function pickAlbum(pages, { title, artist }) {
    const want = normalise(splitEdition(title).base);
    let best = null;
    for (const page of pages) {
      if (!page || !page.extract || isDisambiguation(page)) continue;
      if (!namesArtist(page.extract, artist)) continue;

      const pageTitle = normalise(page.title || "");
      let score = 1;
      if (pageTitle === want) score += 4;
      else if (pageTitle.startsWith(want + " ")) score += 3;   // "hex bark psychosis album"
      else if (pageTitle.includes(want)) score += 1;
      if (/\balbum\b|\bep\b/i.test(page.title || "")) score += 1;
      if (mentionsMusic(page.extract)) score += 1;

      if (!best || score > best.score) best = { page, score };
    }
    /* Naming the artist is worth 1 on its own, and that alone is not a match:
       an article about the artist mentions the artist. A believable answer has
       to have earned something from its title as well. */
    return best && best.score >= 3 ? best.page : null;
  }

  function pickArtist(pages, { artist }) {
    let best = null;
    for (const page of pages) {
      if (!page || !page.extract || isDisambiguation(page)) continue;
      if (!mentionsMusic(page.extract)) continue;
      if (!namesArtist(page.extract, artist)) continue;

      const pageTitle = normalise(page.title || "");
      const want = normalise(artist);
      let score = 1;
      if (pageTitle === want) score += 4;
      else if (pageTitle.startsWith(want + " ")) score += 3;   // "pixies band"
      else if (pageTitle.includes(want)) score += 1;
      if (!best || score > best.score) best = { page, score };
    }
    return best && best.score >= 3 ? best.page : null;
  }

  async function wikiAlbum({ title, artist }) {
    const base = splitEdition(title).base;
    const pages = await search(`${base} ${artist} album`);
    const page = pickAlbum(pages, { title, artist });
    if (!page) return null;

    /* The reception section needs the whole article, which cannot come back
       with the candidates — see search(). One more request, once, for the one
       page that was believed. */
    let review = "";
    try {
      const body = await fullText(page.title);
      review = clamp(section(body, [
        "critical reception", "reception", "critical response", "critical reaction"
      ]), MAX_REVIEW);
    } catch {
      /* The opening is the part that matters and it is already in hand. An
         album with a summary and no reception is the ordinary case anyway —
         most articles have no such section — so a failure here is the same
         outcome as an article without one, and not worth failing the lookup. */
      review = "";
    }

    return {
      source: "wikipedia",
      title: page.title,
      url: pageUrl(page.title),
      licence: WIKI_LICENCE,
      summary: clamp(page.extract, MAX_SUMMARY),
      review
    };
  }

  async function wikiArtist(artist) {
    const pages = await search(artist);
    const page = pickArtist(pages, { artist });
    if (!page) return null;
    return {
      source: "wikipedia",
      title: page.title,
      url: pageUrl(page.title),
      licence: WIKI_LICENCE,
      summary: clamp(page.extract, MAX_SUMMARY),
      review: ""
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Last.fm, for everything Wikipedia has never heard of             */
  /* ---------------------------------------------------------------- */

  /*
   * Only the fallback, and only ever read.
   *
   * Wikipedia covers records that matter and almost no bootlegs, small
   * pressings or self-released work; Last.fm is the other way about. Their
   * artist and album wikis are CC BY-SA and their terms want a link back, which
   * is stored beside the text like Wikipedia's. No new credential: the key
   * this uses is the developer registration lib/lastfm.js already reads for
   * scrobbling, and these two calls need no signature because they change
   * nothing.
   */
  async function lastfmAlbum({ title, artist }) {
    if (!lastfm || !lastfm.describeAlbum) return null;
    const body = await lastfm.describeAlbum(splitEdition(title).base, artist);
    const album = body && body.album;
    const text = album && album.wiki && (album.wiki.content || album.wiki.summary);
    if (!album || !text) return null;
    /* Last.fm autocorrects, so what came back may be a different record than
       the one asked about. The same guard as Wikipedia's, for the same reason. */
    if (!namesArtist(String(album.artist || ""), artist)) return null;
    return {
      source: "lastfm",
      title: `${album.name} — ${album.artist}`,
      url: album.url || "",
      licence: LASTFM_LICENCE,
      summary: clamp(stripHtml(text), MAX_SUMMARY),
      review: ""
    };
  }

  async function lastfmArtist(artist) {
    if (!lastfm || !lastfm.describeArtist) return null;
    const body = await lastfm.describeArtist(artist);
    const found = body && body.artist;
    const text = found && found.bio && (found.bio.content || found.bio.summary);
    if (!found || !text) return null;
    if (!namesArtist(String(found.name || ""), artist)) return null;
    return {
      source: "lastfm",
      title: found.name,
      url: found.url || "",
      licence: LASTFM_LICENCE,
      summary: clamp(stripHtml(text), MAX_SUMMARY),
      review: ""
    };
  }

  /* ---------------------------------------------------------------- */
  /*  The store                                                        */
  /* ---------------------------------------------------------------- */

  const readRow = db.prepare("SELECT * FROM info WHERE kind = ? AND key = ?");
  const writeRow = db.prepare(
    `INSERT INTO info (kind, key, source, title, url, licence, summary, review,
                       fetched_at, ok, note)
     VALUES (@kind, @key, @source, @title, @url, @licence, @summary, @review,
             @fetched_at, @ok, @note)
     ON CONFLICT(kind, key) DO UPDATE SET
       source = excluded.source, title = excluded.title, url = excluded.url,
       licence = excluded.licence, summary = excluded.summary,
       review = excluded.review, fetched_at = excluded.fetched_at,
       ok = excluded.ok, note = excluded.note`);

  function shape(row) {
    if (!row || !row.ok) return null;
    return {
      source: row.source,
      title: row.title,
      url: row.url,
      licence: row.licence,
      summary: row.summary,
      review: row.review || ""
    };
  }

  function remember(kind, key, found, note = "") {
    writeRow.run({
      kind, key,
      source: (found && found.source) || "",
      title: (found && found.title) || "",
      url: (found && found.url) || "",
      licence: (found && found.licence) || "",
      summary: (found && found.summary) || "",
      review: (found && found.review) || "",
      fetched_at: Date.now(),
      ok: found ? 1 : 0,
      note
    });
    return found || null;
  }

  /* A stored answer, or nothing. A hit is final; a miss is only final for a
     week. Anything already known is returned without touching the network,
     which is what makes the second open of a screen free. */
  function stored(kind, key) {
    const row = readRow.get(kind, key);
    if (!row) return undefined;
    if (row.ok) return shape(row);
    return Date.now() - row.fetched_at < MISS_TTL_MS ? null : undefined;
  }

  /* One in-flight request per key, so two taps are one fetch. */
  function once(cacheKey, run) {
    const running = inflight.get(cacheKey);
    if (running) return running;
    const started = run().finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, started);
    return started;
  }

  /* ---------------------------------------------------------------- */
  /*  What the routes call                                             */
  /* ---------------------------------------------------------------- */

  /*
   * An album's write-up.
   *
   * Keyed on the PRIMARY album, whichever version was on screen, for the same
   * reason the heart and the typed name are: a deluxe reissue is the same
   * record, and looking it up twice would ask the same question about the same
   * album under two keys.
   */
  async function album(albumId) {
    const id = headAlbum(db, albumId);
    const row = db.prepare(
      `SELECT ${NAME.title} AS title, ${NAME.artist} AS artist FROM albums WHERE id = ?`).get(id);
    if (!row) return null;
    /* No artist means nothing to verify a page against, and verification is
       the only thing keeping a wrong article off the screen. Better to show
       nothing than to search on a title alone and believe the first hit. */
    if (!row.artist || !row.title) return null;

    const known = stored("album", id);
    if (known !== undefined) return known;
    if (!available) return null;

    return once("album:" + id, async () => {
      /* Checked again inside the lock: two taps can both get past the read
         above before either has written, and the second should find the first
         one's answer rather than send a second request. */
      const again = stored("album", id);
      if (again !== undefined) return again;
      try {
        /*
         * Last.fm is reached only when Wikipedia ANSWERED and had nothing —
         * not when it failed, which is why a throw above skips the fallback
         * entirely rather than falling through to it.
         *
         * That looks like an omission and is the opposite. A hit here is kept
         * for ever, so a Wikipedia outage lasting one minute must not be able
         * to write a permanent Last.fm answer over the better one nobody was
         * able to ask for. A failure leaves no row at all and the next open
         * asks again.
         */
        const found = await wikiAlbum(row) || await lastfmAlbum(row).catch(() => null);
        return remember("album", id, found, found ? "" : "no confident match");
      } catch (e) {
        /* Not written down as a miss: a network failure is not an answer about
           this album, and recording it would mean waiting a week to ask again
           because the router was rebooting. */
        console.warn("[info] album lookup failed: " + e.message);
        return null;
      }
    });
  }

  /*
   * An artist's biography.
   *
   * Keyed on the folded artist identity rather than the name as typed, so
   * "AC/DC" and "ACDC" — which the library already treats as one act — ask
   * once between them.
   */
  async function artist(name) {
    const clean = String(name || "").trim();
    if (!clean) return null;
    const key = artistKey(clean);
    if (!key) return null;

    const known = stored("artist", key);
    if (known !== undefined) return known;
    if (!available) return null;

    return once("artist:" + key, async () => {
      const again = stored("artist", key);
      if (again !== undefined) return again;
      try {
        /* Wikipedia answering with nothing, not Wikipedia failing — see the
           note in album() above. */
        const found = await wikiArtist(clean) || await lastfmArtist(clean).catch(() => null);
        return remember("artist", key, found, found ? "" : "no confident match");
      } catch (e) {
        console.warn("[info] artist lookup failed: " + e.message);
        return null;
      }
    });
  }

  /* An album whose name the user has just corrected is a different question
     from the one that was asked, so the old answer stops being an answer. */
  function forget(kind, key) {
    db.prepare("DELETE FROM info WHERE kind = ? AND key = ?").run(kind, key);
  }

  function status() {
    const n = db.prepare("SELECT COUNT(*) n FROM info WHERE ok = 1").get().n;
    return { available: !!available, known: n };
  }

  return { album, artist, forget, status };
}

module.exports = {
  createInfo, userAgent, clamp, section, stripHtml,
  namesArtist, mentionsMusic, isDisambiguation, isHeading,
  MISS_TTL_MS, MAX_SUMMARY, MAX_REVIEW, WIKI_API, WIKI_LICENCE, LASTFM_LICENCE
};
