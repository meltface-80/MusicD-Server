"use strict";
/*
 * meta.js — what the library does not say about a record: its release year,
 * a write-up, the artist's story, and what Pitchfork made of it.
 *
 * Lifted from MusicD Remote's index.js with its sources intact — MusicBrainz
 * for years, Pitchfork (score, Best New Music, and a LINK — never the review
 * text), Qobuz's public editorial pages (no account involved) and Wikipedia —
 * and with the same guards against landing on the wrong act. Nothing here
 * needs a key or a login.
 */
const wikiMatch = require("./wiki-match");
const DEBUG = !!process.env.DEBUG;

const MB_USER_AGENT = process.env.MB_USER_AGENT ||
  "MusicDServer/0.1 ( https://github.com/meltface-80/MusicD-Server )";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const mbCache        = new Map();
const qobuzCache     = new Map();
const pitchforkCache = new Map();
const wikiCache      = new Map();
let mbLastReq = 0, pitchforkLastReq = 0, qobuzLastReq = 0;

// Bounded: these are per-process memo caches in front of a persistent one.
function trim(map) { while (map.size > 2000) map.delete(map.keys().next().value); }

async function mbWait() {
  const elapsed = Date.now() - mbLastReq;
  if (elapsed < 1100) await new Promise(r => setTimeout(r, 1100 - elapsed));
  mbLastReq = Date.now();
}

async function pitchforkWait() {
  const elapsed = Date.now() - pitchforkLastReq;
  if (elapsed < 1000) await new Promise(r => setTimeout(r, 1000 - elapsed));
  pitchforkLastReq = Date.now();
}
function slugifyForPitchfork(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/['']/g, "")           // drop apostrophes before stripping
    .replace(/[^a-z0-9\s-]/g, " ")  // non-alphanumeric → space
    .replace(/\s+/g, "-")           // spaces → hyphens
    .replace(/-+/g, "-")            // collapse multiple hyphens
    .replace(/^-+|-+$/g, "");       // trim hyphens
}

async function qobuzWait() {
  const elapsed = Date.now() - qobuzLastReq;
  if (elapsed < 700) await new Promise(r => setTimeout(r, 700 - elapsed));
  qobuzLastReq = Date.now();
}

async function httpJson(url, headers, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
async function httpText(url, headers, timeoutMs = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function normalize(s) {
  return String(s || "").toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
// Decode HTML entities — named (incl. &copy; &reg; &trade;) and numeric
// (&#169; / &#xA9;), with or without the trailing semicolon. Unknown entities
// are left untouched. NOTE: "&copy" reached a share card before because the old
// stripHtml decoded a handful of entities by hand but not this one.
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  copy: "\u00A9", reg: "\u00AE", trade: "\u2122",
  nbsp: " ", hellip: "...", mdash: "\u2014", ndash: "\u2013",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D",
  deg: "\u00B0"
};
function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ""; }
}
function decodeEntities(input) {
  if (!input) return "";
  return String(input)
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g,        (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);?/gi, (m, name) => {
      const v = NAMED_ENTITIES[name.toLowerCase()];
      return v !== undefined ? v : m;
    });
}

// --- artist guard ----------------------------------------------------------
// Why this exists: a review/page was matched to the WRONG act because the only
// check was "the slug contains the artist's first token" — and the first token
// of "The Who" is "the", which matches almost any slug (e.g.
// "greatest-hits-the-guess-who"). These helpers verify that the text we got
// back actually belongs to the requested artist. Failing safe = drop the bio.

function escapeReg(s) { return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// First significant token, skipping a leading article ("the who" -> "who").
function firstSignificantToken(s) {
  const toks = normalize(s).split(" ").filter(Boolean);
  if (toks.length > 1 && /^(the|a|an)$/.test(toks[0])) return toks[1];
  return toks[0] || "";
}

// Whole-phrase overlap in either direction, tolerant of a leading "the".
// "the who" vs "the guess who" -> false (correctly rejects the mismatch);
// "jay z" vs "jay z feat alicia keys" -> true (keeps a correct match).
function namesOverlap(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return false;
  const pad = s => " " + s + " ";
  if (pad(a).includes(pad(b)) || pad(b).includes(pad(a))) return true;
  const strip = s => s.replace(/^the /, "");
  return strip(a) === strip(b);
}

// Pull the artist out of a leading "Artist - Album …" dateline, if present.
function leadArtistOf(text) {
  const m = String(text || "").trim().match(/^(.{2,60}?)\s[-\u2013\u2014]\s/);
  return m ? m[1].trim() : null;
}

function stripHtml(html) {
  const s = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/?p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s)            // named + numeric, semicolon optional
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// MusicBrainz: release year
function mbQuote(s) {
  return String(s).replace(/[+\-&|!(){}\[\]^"~*?:\\\/]/g, "\\$&");
}
async function fetchAlbumYear(title, artist) {
  if (!title) return null;
  const key = normalize(title) + "||" + normalize(artist || "");
  if (mbCache.has(key)) return mbCache.get(key);
  await mbWait();
  let q = `release:"${mbQuote(title)}"`;
  if (artist) q += ` AND artist:"${mbQuote(artist)}"`;
  const url = `https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
  try {
    const json = await httpJson(url, { "User-Agent": MB_USER_AGENT });
    const rgs = json["release-groups"] || [];
    rgs.sort((a, b) =>
      (a["first-release-date"] || "9999").localeCompare(b["first-release-date"] || "9999"));
    const date = rgs[0] && rgs[0]["first-release-date"] || null;
    const year = date ? date.slice(0, 4) : null;
    mbCache.set(key, year);
    return year;
  } catch (e) {
    if (DEBUG) console.error("[mb]", e.message);
    mbCache.set(key, null);
    return null;
  }
}

// Qobuz: search the public site, scrape the editorial review off the album page.
async function fetchQobuz(title, artist) {
  if (!title) return null;
  const key = normalize(title) + "||" + normalize(artist || "");
  if (qobuzCache.has(key)) return qobuzCache.get(key);

  let out = null;
  try {
    // 1) Search
    const q = `${title} ${artist || ""}`.trim();
    await qobuzWait();
    const searchHtml = await httpText(
      `https://www.qobuz.com/us-en/search?q=${encodeURIComponent(q)}`,
      { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" }
    );

    // 2) Find first album link whose URL slug contains both the album title
    //    word AND the artist word. Slug shape: /us-en/album/{slug}/{id}
    const linkRe = /\/(?:us-en\/)?album\/([^"'\/\s]+)\/([a-z0-9]+)/g;
    const seen = new Map();
    let m;
    while ((m = linkRe.exec(searchHtml)) !== null) {
      if (!seen.has(m[2])) seen.set(m[2], m[1]);
    }
    if (seen.size === 0) { qobuzCache.set(key, null); return null; }

    const artistFirst = firstSignificantToken(artist || "");
    // Score each candidate by how many title words (> 3 chars) appear in its slug.
    // Taking only the first token was too loose: "songs" matched both
    // "songs-about-new-york-…" and "songs-of-peace-praise-…" for Various Artists.
    // Scoring all tokens picks the best match; short-title fallback uses firstSignificantToken.
    const titleTokens = normalize(title).split(" ").filter(w => w.length > 3);
    const titleCheck  = titleTokens.length > 0 ? titleTokens : [firstSignificantToken(title)].filter(Boolean);
    let bestScore = -1, chosenSlug = null, chosenId = null;
    for (const [id, slug] of seen) {
      const sn = slug.toLowerCase();
      if (artistFirst && !sn.includes(artistFirst)) continue;
      const score = titleCheck.filter(tok => sn.includes(tok)).length;
      if (score > bestScore) { bestScore = score; chosenSlug = slug; chosenId = id; }
    }
    // Require all tokens to match for short titles (1-2 tokens); at least 2 for longer titles.
    // Math.max(1,...) ensures the floor is 1 even when titleCheck is empty (all words ≤3 chars),
    // so a zero-score slug is never accepted regardless of title length.
    const minScore = Math.max(1, Math.min(titleCheck.length, 2));
    if (!chosenSlug || bestScore < minScore) { qobuzCache.set(key, null); return null; }

    // 3) Fetch the album page
    await qobuzWait();
    const albumUrl = `https://www.qobuz.com/us-en/album/${chosenSlug}/${chosenId}`;
    const albumHtml = await httpText(albumUrl, {
      "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9"
    });

    // 4) Editorial review.  Page has "Album Review: ..." heading, then the
    //    body, ending around "About the album" or "Improve album information".
    let review = null;
    const startMatch = /Album Review[:\s]/i.exec(albumHtml);
    if (startMatch) {
      const start = startMatch.index;
      const ends = [
        albumHtml.indexOf("About the album",          start),
        albumHtml.indexOf("Improve album information", start),
        albumHtml.indexOf("Why buy on Qobuz",          start),
        start + 8000
      ].filter(n => n > start);
      const end = Math.min(...ends);
      let text = stripHtml(albumHtml.substring(start, end));

      // Qobuz's heading reads "Album Review: <Artist> - <Album>". Capture it
      // for an artist sanity-check before stripping it off.
      const headingMatch = text.match(/^Album Review[:\s]+([^\n]+)/i);
      const headingLine  = headingMatch ? headingMatch[1].trim() : "";
      text = text.replace(/^Album Review[^\n]*\n?/i, "").trim();

      // Drop a trailing attribution line: "© Author /TiVo", "… /AllMusic",
      // "… /Qobuz", or "Review by Author". Entities are already decoded, so a
      // raw "&copy" is now "©". The old code only matched "/Qobuz", which is
      // why "&copy … /TiVo" survived onto the card.
      text = text.replace(/\s*©\s*[^\n]*\/(?:tivo|rovi|allmusic|qobuz)\s*$/i, "").trim();
      text = text.replace(/\s*Review by\s+[^\n]+$/i, "").trim();

      // VERIFY THE ARTIST. The search/scrape can land on the wrong act — e.g.
      // "Greatest Hits / The Who" matching The Guess Who. Trust Qobuz's own
      // heading artist, falling back to the "Artist - Album" dateline the
      // review body opens with. On a mismatch, discard the whole Qobuz result
      // so the caller cleanly falls back to Wikipedia (or to no bio).
      const leadArtist = leadArtistOf(headingLine) || leadArtistOf(text);
      if (artist && leadArtist && !namesOverlap(leadArtist, artist)) {
        if (DEBUG) console.error(`[qobuz] artist mismatch: wanted "${artist}", got "${leadArtist}" — discarding`);
        qobuzCache.set(key, null);
        return null;
      }

      // Tidy: AllMusic reviews open with an "<Artist> - <Album>" dateline. Now
      // that the artist is confirmed, strip that exact prefix so the card opens
      // with the prose rather than a repeated title line.
      if (leadArtist) {
        const dateline = new RegExp(
          "^\\s*" + escapeReg(leadArtist) + "\\s*[-\\u2013\\u2014]\\s*" + escapeReg(title) + "\\s*",
          "i"
        );
        text = text.replace(dateline, "").trim();
      }

      if (text.length > 60) review = text;
    }

    // 5) Year + label
    let year = null, label = null;
    const rel = albumHtml.match(/Released\s+on\s+([\d\/]+)\s*by\s*<[^>]*>([^<]+)</i);
    if (rel) {
      const parts = rel[1].split("/");
      const yp = parts[parts.length - 1];
      if (yp.length === 2) {
        // Qobuz sometimes renders a 2-digit year. Pivot on the current year so
        // "80" -> 1980 (not 2080) while recent reissues like "08" -> 2008.
        const n = parseInt(yp, 10);
        const cur2 = new Date().getFullYear() % 100;
        year = String(n <= cur2 ? 2000 + n : 1900 + n);
      } else {
        year = yp;
      }
      label = rel[2].trim();
    }

    if (review || year || label) {
      out = {
        description: review,
        year, label,
        url: albumUrl,
        source: "Qobuz"
      };
    }
  } catch (e) {
    if (DEBUG) console.error("[qobuz]", e.message);
  }

  qobuzCache.set(key, out);

  return out;
}

// Wikipedia: search + first-paragraph extract via the MediaWiki API.
async function wikiSearch(query, limit = 5) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`;
  const data = await httpJson(url, { "User-Agent": MB_USER_AGENT });
  return (data && data.query && data.query.search) || [];
}
async function wikiExtract(pageTitle) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|info` +
    `&exintro=true&explaintext=true&redirects=1&inprop=url` +
    `&titles=${encodeURIComponent(pageTitle)}&format=json&origin=*`;
  const data = await httpJson(url, { "User-Agent": MB_USER_AGENT });
  const pages = (data && data.query && data.query.pages) || {};
  const page = pages[Object.keys(pages)[0]];
  if (!page || !page.extract) return null;
  return {
    title:       page.title,
    description: page.extract,
    url:         page.fullurl ||
                 `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title).replace(/ /g, "_"))}`
  };
}

async function fetchWikiAlbum(title, artist) {
  if (!title) return null;
  const artistFirst = normalize(artist || "").split(" ")[0];
  const candidates  = await wikiSearch(`${title} ${artist || ""} album`);

  for (const c of candidates) {
    const ext = await wikiExtract(c.title);
    if (!ext) continue;

    const lead     = ext.description.slice(0, 400);
    const headNorm = normalize(ext.description.slice(0, 800));

    // (1) The article must actually be about THIS album: its Wikipedia title
    //     must name the album, as whole words, BEFORE the disambiguator (see
    //     lib/wiki-match.js). Reading the disambiguator too is what showed
    //     Runnin' Wild for Airbourne's self-titled album — "Runnin' Wild
    //     (Airbourne album)" contains "Airbourne", and for a self-titled
    //     record the album name is the act's name, so every album they ever
    //     made matched and the first search result won.
    if (!wikiMatch.albumPageTitleMatches(title, c.title)) continue;

    // (2) Reject person biographies.  These slipped through before because a
    //     musician's bio mentions "albums" ("recorded five studio albums").
    //     Tell-tale signs: a birth/death date in parentheses, or "is/was a …
    //     singer/musician/band" in the lead.
    const personBirthDeath = /\(\s*(born\s+)?\d{1,2}\s+\w+\s+\d{4}\b/i.test(lead)
                          || /\b\d{4}\s*[–—-]\s*\d{4}\b/.test(lead);
    const personDescriptor = /\b(is|was)\s+(an?\s+)?(scottish|american|english|british|irish|welsh|canadian|australian|[a-z]+)?\s*(singer|songwriter|musician|guitarist|drummer|rapper|composer|producer|vocalist|bassist|pianist|dj|band|duo)\b/i.test(lead);
    if (personBirthDeath || personDescriptor) continue;

    // (3) Confirm it reads like a release: "… is/was the … album/EP/record …"
    if (!/\b(is|was)\b[^.]{0,80}\b(album|ep|record|mixtape|soundtrack|single)\b/i.test(lead)) continue;

    // (4) If we know the artist, prefer an article that mentions them.
    if (artistFirst && artistFirst.length > 2 && !headNorm.includes(artistFirst)) continue;

    return { ...ext, source: "Wikipedia" };
  }
  return null;
}
// Strip ONE trailing parenthetical qualifier from a Wikipedia title:
// "Camel (band)" → "Camel". Lets the title-identity check below accept
// music qualifiers while still demanding the article IS the artist.
function wikiTitleBase(t) {
  return String(t || "").replace(/\s*\([^()]*\)\s*$/, "").trim();
}
// Loose-but-safe name identity: normalized equality, tolerating a
// leading "the" on either side ("Verve" ↔ "The Verve").
function namesEqualLoose(a, b) {
  const strip = (x) => normalize(x || "").replace(/^the\s+/, "");
  const na = strip(a), nb = strip(b);
  return !!na && na === nb;
}
// Full-text confirmation that the candidate artist article is connected to
// the album being played: Wikipedia's search index covers whole articles
// (including discography sections), so searching `"artist" "album"` and
// requiring the candidate among the hits confirms THIS article's subject
// made THAT album. Errors count as NOT confirmed — for bios, wrong is
// worse than missing.
async function wikiArticleMentionsAlbum(pageTitle, artist, albumTitle) {
  try {
    const hits = await wikiSearch(`"${artist}" "${albumTitle}"`, 10);
    const want = normalize(pageTitle);
    return hits.some(h => normalize(h.title) === want);
  } catch (e) {
    if (DEBUG) console.error("[wiki:artist] album cross-check:", e.message);
    return false;
  }
}

async function fetchWikiArtist(name, albumTitle) {
  if (!name) return null;
  // Split multi-artist credits on Roon's spaced " / " separator (and commas).
  // The slash must be spaced: bare slashes are part of names (AC/DC).
  const primary = name.split(/\s+\/\s+|,/)[0].trim();
  const candidates = await wikiSearch(`${primary} band musician singer`);
  for (const c of candidates) {
    if (/\b(album|song|tour|discography)\b/i.test(c.title)) continue;
    // The article title must BE the artist (one parenthetical qualifier like
    // "(band)"/"(musician)" allowed) — near-name matches and disambiguation
    // pages are rejected outright rather than risking someone else's bio.
    if (/\(disambiguation\)/i.test(c.title)) continue;
    if (!namesEqualLoose(wikiTitleBase(c.title), primary)) continue;
    const ext = await wikiExtract(c.title);
    if (!ext) continue;
    if (/\bmay (also )?refer to\b/i.test(ext.description.slice(0, 200))) continue; // disambiguation body
    const head = ext.description.slice(0, 800);
    if (!/\b(band|musician|singer|songwriter|group|musical|guitarist|drummer|pianist|composer|rapper|vocalist|recording artist|duo|trio|quartet|ensemble|orchestra)\b/i.test(head)) continue;
    // When the caller knows which album is playing, the article must also be
    // connected to that album — the strongest identity signal available.
    if (albumTitle && !(await wikiArticleMentionsAlbum(c.title, primary, albumTitle))) continue;
    return { ...ext, name: ext.title, source: "Wikipedia" };
  }
  return null;
}

async function fetchWikipedia(title, artist) {
  if (!title) return null;
  const key = normalize(title) + "||" + normalize(artist || "");
  if (wikiCache.has(key)) return wikiCache.get(key);
  let result = null;
  try {
    const [album, artistInfo] = await Promise.all([
      fetchWikiAlbum(title, artist).catch(() => null),
      artist ? fetchWikiArtist(artist, title).catch(() => null) : Promise.resolve(null)
    ]);
    if (album || artistInfo) result = { album, artist: artistInfo };
  } catch (e) {
    if (DEBUG) console.error("[wiki]", e.message);
  }
  wikiCache.set(key, result);
  return result;
}

// Extractor for a Pitchfork review PAGE: the review body from the JSON-LD
// Review block, plus the score / Best-New-Music flag from the inline preloaded
// state. Sole consumer is fetchPitchfork (album extras). The parsed body NEVER
// reaches a client (UK-law compliance — only score/BNM/link are emitted); it
// is read internally by fetchPitchfork's artist-verification guard. The body
// is stripped of HTML but NOT entity-decoded here; the consumer decodes.
function parsePitchforkReviewHtml(html) {
  let description = null;
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj["@type"] === "Review" && obj.reviewBody) {
        description = stripHtml(obj.reviewBody).trim() || null;
        break;
      }
    } catch (e) { /* malformed JSON-LD block — try the next one; loop continues */ }
  }
  let score = null, isBestNewMusic = false;
  const scoreM = html.match(/"musicRating"\s*:\s*\{[^}]*?"score"\s*:\s*(\d+(?:\.\d+)?)/);
  if (scoreM) score = parseFloat(scoreM[1]);
  const bnmM = html.match(/"isBestNewMusic"\s*:\s*(true|false)/);
  if (bnmM) isBestNewMusic = bnmM[1] === "true";
  return { description, score: Number.isFinite(score) ? score : null, isBestNewMusic };
}

async function fetchPitchfork(title, artist) {
  const key = normalize(title) + "||" + normalize(artist || "");
  if (pitchforkCache.has(key)) return pitchforkCache.get(key);

  // Use primary artist only (before collaborators)
  const primaryArtist = String(artist || "").split(/\s*[/,&]\s*|\s+feat\.\s+/i)[0].trim();
  const artistSlug = slugifyForPitchfork(primaryArtist);
  const albumSlug  = slugifyForPitchfork(title);
  if (!artistSlug || !albumSlug) { pitchforkCache.set(key, null); return null; }

  const url = `https://pitchfork.com/reviews/albums/${artistSlug}-${albumSlug}/`;
  try {
    await pitchforkWait();
    const html = await httpText(url, { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" }, 15000);

    const { description, score, isBestNewMusic } = parsePitchforkReviewHtml(html);

    if (!description && score === null) { pitchforkCache.set(key, null); return null; }

    // Verify the review is for the right artist
    if (description) {
      const artistFirst = firstSignificantToken(primaryArtist);
      if (artistFirst && !normalize(description).includes(artistFirst)) {
        pitchforkCache.set(key, null);
        return null;
      }
    }

    const out = { description, score, isBestNewMusic, url, source: "Pitchfork" };
    pitchforkCache.set(key, out);
    return out;
  } catch (e) {
    if (DEBUG) console.error("[pitchfork]", e.message);
    pitchforkCache.set(key, null);
    return null;
  }
}

// Combine: Pitchfork preferred, then Qobuz, then Wikipedia for the album review;
// Wikipedia also used for the artist bio.
async function fetchAlbumBios(title, artist) {
  if (!title) return null;
  const [pitchfork, qobuz, wiki] = await Promise.all([
    fetchPitchfork(title, artist).catch(() => null),
    fetchQobuz(title, artist).catch(() => null),
    fetchWikipedia(title, artist).catch(() => null)
  ]);

  // Where the shown TEXT came from, which is not always where the LINK goes.
  // `source`/`url` name the review being linked to; these name whoever wrote
  // the words on screen. They differ on exactly one path — see below — and
  // keeping them apart is what stops Wikipedia's prose appearing under a link
  // that says Pitchfork.
  const wikiText = (wiki && wiki.album && wiki.album.description) || null;
  const wikiUrl  = (wiki && wiki.album && wiki.album.url) || null;
  const qobuzText = (qobuz && qobuz.description) || null;

  /*
   * The prose to show when Pitchfork is the review being LINKED to.
   *
   * Pitchfork's own writing is never a candidate — see the compliance note in
   * that branch — so the words on screen come from one of the other two, and
   * both were fetched in the Promise.all above whatever happens next.
   *
   * v1.8.32 wired Wikipedia in here and stopped there, which left Qobuz's
   * description sitting unused in exactly the same way Wikipedia's had been:
   * a Pitchfork-reviewed album whose Wikipedia lookup came back empty showed
   * no words at all, even with a Qobuz editorial paragraph in hand. Reported
   * against Bruce Springsteen's *Western Stars* — whose title it shares with a
   * 2019 documentary film, which is the kind of thing that makes an
   * encyclopaedia lookup miss.
   *
   * Wikipedia keeps precedence, so nothing that shows an article today starts
   * showing a different paragraph tomorrow; Qobuz is the fallback rather than
   * a competitor.
   */
  const pfText   = wikiText || qobuzText;
  const pfSource = wikiText ? "Wikipedia" : (qobuzText ? "Qobuz" : null);
  const pfUrl    = wikiText ? wikiUrl : (qobuzText ? (qobuz.url || null) : null);

  let album = null;
  if (pitchfork && pitchfork.description) {
    // COMPLIANCE (UK law): PITCHFORK's written review must not be displayed —
    // only the score, the Best New Music flag, and a LINK to read the review
    // on pitchfork.com. Their text stays internal (this branch's gate and
    // fetchPitchfork's artist-verification guard read it) and never leaves.
    //
    // That rule is about THEIR prose, not about the album having none. This
    // branch once emitted description: null, which meant any record Pitchfork
    // had reviewed showed no text at all — on the album view and on the share
    // card — while the other two fetches sat here unused. Whichever of them
    // answers is shown, and description_source says which, so the two are
    // never confused. See pfText above for the precedence.
    album = {
      description:        pfText,
      description_source: pfSource,
      description_url:    pfUrl,
      year:           (qobuz && qobuz.year) || null,
      label:          (qobuz && qobuz.label) || null,
      url:            pitchfork.url,
      source:         "Pitchfork",
      score:          pitchfork.score,
      isBestNewMusic: pitchfork.isBestNewMusic
    };
  } else if (qobuz && qobuz.description) {
    album = {
      description:    qobuz.description,
      description_source: "Qobuz",
      description_url:    qobuz.url || null,
      year:           qobuz.year  || (wiki && wiki.album && /(\d{4})/.exec(wiki.album.description || "") || [])[1] || null,
      label:          qobuz.label || null,
      url:            qobuz.url,
      source:         "Qobuz",
      score:          null,
      isBestNewMusic: false
    };
  } else if (wiki && wiki.album) {
    album = {
      description:    wiki.album.description,
      description_source: "Wikipedia",
      description_url:    wiki.album.url || null,
      year:           null,
      label:          (qobuz && qobuz.label) ? qobuz.label : null,
      url:            wiki.album.url,
      source:         "Wikipedia",
      score:          null,
      isBestNewMusic: false
    };
  } else if (qobuz) {
    album = {
      description:        null,
      description_source: null,
      description_url:    null,
      year:           qobuz.year,
      label:          qobuz.label,
      url:            qobuz.url,
      source:         "Qobuz",
      score:          null,
      isBestNewMusic: false
    };
  }

  const artistObj = (wiki && wiki.artist) ? {
    name:        wiki.artist.name || artist || null,
    description: wiki.artist.description,
    url:         wiki.artist.url,
    source:      "Wikipedia"
  } : null;

  if (album && album.description) {
    album.description = decodeEntities(album.description).trim();
    const lead = leadArtistOf(album.description);
    if (artist && lead && !namesOverlap(lead, artist)) {
      if (DEBUG) console.error(`[bios] description artist mismatch: wanted "${artist}", got "${lead}" — dropping`);
      album.description = null;
    }
    if (!album.description) album.description = null;
    // The attribution belongs to the TEXT. When the guard above drops the text
    // for naming the wrong artist, the "View on …" link that describes it has
    // to go too, or the album view offers a source for prose that is no longer
    // on screen.
    if (!album.description) { album.description_source = null; album.description_url = null; }
  }

  // The resolved pages, kept whichever source won above. `album.url` carries
  // only the winner — Pitchfork outranks Qobuz outranks Wikipedia — so a
  // Wikipedia article found alongside a Pitchfork review was being thrown
  // away, and the share card's Wikipedia chip fell back to a search for a page
  // this function had already located. Additive: nothing reads these but the
  // links builder.
  return {
    album,
    artist: artistObj,
    urls: {
      wikipediaAlbum:  (wiki && wiki.album && wiki.album.url) || null,
      wikipediaArtist: (artistObj && artistObj.url) || null,
      pitchfork:       (pitchfork && pitchfork.url) || null,
    }
  };
}



const PITCHFORK_LIST_TTL   = 6 * 60 * 60 * 1000;
// Per-tab listing cache. Deliberately NOT makeTtlCache: we must NOT cache an
// EMPTY result (a parse miss or a served-but-unparseable page), or a recovery
// would be blocked for the whole TTL. Only non-empty results are stored.
const pitchforkLists       = new Map();  // type → { at, items }

const PF_HEADERS = { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" };

function unCdata(s) {
  return s == null ? s : String(s).replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
}

// Best-effort artist name from a review URL when the listing parse didn't give
// a clean one: the slug is "<artist>-<album>", so strip the known album-slug
// suffix and title-case what's left. Fallback only — casing is approximate.
function artistFromReviewUrl(url, albumTitle) {
  const m = /\/reviews\/albums\/([^\/?#]+)/.exec(url || "");
  if (!m) return null;
  let artistSlug = m[1];
  const albumSlug = slugifyForPitchfork(albumTitle || "");
  if (albumSlug && artistSlug.endsWith("-" + albumSlug)) {
    artistSlug = artistSlug.slice(0, artistSlug.length - albumSlug.length - 1);
  }
  const words = artistSlug.split("-").filter(Boolean);
  if (!words.length) return null;
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Parse the RSS album-reviews feed → [{ url, album, cover, date }].
async function fetchPitchforkRss() {
  await pitchforkWait();
  const xml = await httpText("https://pitchfork.com/feed/feed-album-reviews/rss", PF_HEADERS, 15000);
  const items = [];
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  let im;
  while ((im = itemRe.exec(xml)) !== null) {
    const block = im[0];
    const pick = (re) => { const x = re.exec(block); return x ? unCdata(x[1]) : null; };
    const link = pick(/<link>([\s\S]*?)<\/link>/i);
    if (!link || !/\/reviews\/albums\//.test(link)) continue;
    // stripHtml entity-decodes internally; decoding FIRST would let an escaped
    // "&lt;em&gt;" in a title turn into a strippable tag and lose literal text.
    const album = stripHtml(pick(/<title>([\s\S]*?)<\/title>/i) || "").trim();
    const cover = (/<media:thumbnail[^>]*\burl=["']([^"']+)["']/i.exec(block) || [])[1] || null;
    const date  = pick(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    if (album) items.push({ url: link.split(/[?#]/)[0], album, cover, date });
  }
  return items;
}

// Extract window.__PRELOADED_STATE__ = {...} via brace-matching (a greedy regex
// can't balance braces reliably on a ~2 MB page).
function extractPreloadedState(html) {
  const marker = html.indexOf("__PRELOADED_STATE__");
  if (marker === -1) return null;
  const start = html.indexOf("{", marker);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { if (--depth === 0) return html.slice(start, i + 1); }
  }
  return null;
}

// Square cover URL from a listing item's image.sources. lg (~1280px) first —
// plenty for the biggest mosaic tile without pulling the oversized xxl; then
// xxl, md, sm as availability fallbacks.
function pfListingCover(node) {
  const s = node.image && node.image.sources;
  if (!s || typeof s !== "object") return null;
  return (s.lg && s.lg.url) || (s.xxl && s.xxl.url) || (s.md && s.md.url) || (s.sm && s.sm.url) || null;
}

// Walk the preloaded state and collect review-listing items. Verified shape
// (2026): each item has contentType "review", a ratingValue object, a url, the
// title in dangerousHed (HTML) — bare `hed` only exists nested under `source` —
// the artist in subHed.name, and square covers under image.sources.{lg,md,sm}.
// Matching on contentType + ratingValue + url (not a fixed path) keeps it
// resilient to container reshuffles.
function collectReviewItems(state) {
  const out = [];
  const seen = new Set();
  const stack = [state];
  let guard = 0;
  while (stack.length && guard++ < 500000) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) { for (const x of node) if (x && typeof x === "object") stack.push(x); continue; }
    if (node.contentType === "review" && node.ratingValue && typeof node.url === "string") {
      const full = (node.url.startsWith("http") ? node.url : "https://pitchfork.com" + node.url).split(/[?#]/)[0];
      if (!seen.has(full)) {
        seen.add(full);
        // Title: dangerousHed (HTML), falling back to source.hed (markdown-ish
        // asterisks) — tested AFTER stripping, so an empty/HTML-only
        // dangerousHed still consults the fallback. Non-strings are ignored
        // rather than stringified ("[object Object]" must never render).
        // stripHtml already entity-decodes, so no extra decode pass.
        let album = "";
        if (typeof node.dangerousHed === "string") album = stripHtml(node.dangerousHed).trim();
        if (!album && node.source && typeof node.source.hed === "string") {
          album = node.source.hed.replace(/\*/g, "").trim();
        }
        const artist = (node.subHed && typeof node.subHed.name === "string") ? node.subHed.name.trim() : null;
        const rv = node.ratingValue;
        const score = (rv.score != null && rv.score !== "") ? parseFloat(rv.score) : null;
        out.push({
          url:            full,
          album,
          artist,
          score:          Number.isFinite(score) ? score : null,
          isBestNewMusic: !!(rv.isBestNewMusic || rv.isBestNewReissue),
          cover:          pfListingCover(node),
          date:           node.pubDate || null
        });
      }
    }
    for (const k in node) { const v = node[k]; if (v && typeof v === "object") stack.push(v); }
  }
  return out;
}

async function fetchPitchforkListing(path) {
  await pitchforkWait();
  const html = await httpText("https://pitchfork.com" + path, PF_HEADERS, 15000);
  const raw = extractPreloadedState(html);
  if (!raw) { if (DEBUG) console.error("[pitchfork] no preloaded state in", path); return []; }
  let state;
  try { state = JSON.parse(raw); }
  catch (e) { if (DEBUG) console.error("[pitchfork] state parse failed:", e.message); return []; }
  return collectReviewItems(state);
}

function pfItemOut(x) {
  return {
    url:            x.url,
    album:          x.album || "",
    artist:         x.artist || null,
    cover:          x.cover || null,
    score:          x.score != null ? x.score : null,
    isBestNewMusic: !!x.isBestNewMusic,
    date:           x.date || null
  };
}

// The listing page carries everything we need (title, artist, score, BNM,
// square cover), so it's the primary source for both tabs, sorted newest-first
// by pubDate (the state walk's traversal order is oldest-first — verified
// against the live pages). For the Latest tab only, if the listing FAILS —
// network error/403 (the realistic scraper-block case) or a parse that yields
// nothing — fall back to the RSS feed: covers + title, artist derived from the
// slug, no score. Best New Music has no equivalent feed. Only when every
// available source has failed does this throw, so the route 500s and the UI
// shows an honest "couldn't load" instead of an empty page.
async function buildPitchforkList(type) {
  if (type === "best") {
    return sortPfNewestFirst(
      (await fetchPitchforkListing("/reviews/best/albums/")).map(pfItemOut).filter(it => it.album));
  }
  let listErr = null;
  let items = [];
  try {
    items = (await fetchPitchforkListing("/reviews/albums/")).map(pfItemOut).filter(it => it.album);
  } catch (e) { listErr = e; /* fall through to the RSS fallback below */ }
  if (items.length) return sortPfNewestFirst(items);
  const rss = await fetchPitchforkRss().catch(e => {
    if (DEBUG) console.error("[pitchfork] rss fallback failed:", e.message);
    return [];
  });
  const out = rss
    .map(r => pfItemOut({ url: r.url, album: r.album, artist: artistFromReviewUrl(r.url, r.album),
                          cover: r.cover, date: r.date }))
    .filter(it => it.album);
  if (!out.length && listErr) throw listErr;   // both sources down — surface the error
  return out;   // RSS document order is already newest-first
}

// Stable newest-first sort on ISO pubDate (lexicographic compare is correct
// for ISO-8601); undated items keep their relative order at the end.
function sortPfNewestFirst(items) {
  return items.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

const pitchforkListPending = new Map();   // type → in-flight build Promise
async function getPitchforkReviews(type) {
  const hit = pitchforkLists.get(type);
  if (hit && (Date.now() - hit.at) < PITCHFORK_LIST_TTL) return hit.items;
  // In-flight dedup: concurrent cache misses (a tab open racing a global
  // search, or two searches) share one scrape instead of each hitting Pitchfork.
  if (pitchforkListPending.has(type)) return pitchforkListPending.get(type);
  const pending = (async () => {
    try {
      const items = await buildPitchforkList(type);
      // Cache only a non-empty result — an empty list means a parse miss or a
      // served-but-unparseable page, which we want to retry (not lock in for 6h).
      if (items.length) pitchforkLists.set(type, { at: Date.now(), items });
      return items;
    } finally {
      pitchforkListPending.delete(type);
    }
  })();
  pitchforkListPending.set(type, pending);
  return pending;
}

// Match the query against the cached review lists (both tabs, deduped by URL).
// Cold cache triggers ONE shared scrape via the dedup above; a blocked/failed
// source just yields no Pitchfork section rather than failing the search.
async function searchPitchforkReviews(q, limit) {
  const nq = normalize(q);
  if (!nq) return [];
  const [latest, best] = await Promise.all([
    getPitchforkReviews("latest").catch(() => []),
    getPitchforkReviews("best").catch(() => [])
  ]);
  const seen = new Set();
  const out = [];
  for (const it of [...latest, ...best]) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    if (normalize(it.album).includes(nq) || normalize(it.artist || "").includes(nq)) {
      out.push(it);
      if (out.length >= limit) break;
    }
  }
  return out;
}

module.exports = {
  normalize, stripHtml, decodeEntities, namesEqualLoose, namesOverlap,
  fetchAlbumYear, fetchAlbumBios, fetchWikiArtist, fetchPitchfork,
  getPitchforkReviews, searchPitchforkReviews, httpJson, httpText, MB_USER_AGENT
};
