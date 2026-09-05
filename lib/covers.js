/*
 * MusicD Server — finding a cover for an album that has none.
 *
 * The library is still the files. This does not identify albums, it does not
 * rewrite a tag, and it never touches the music mount: an album whose folder
 * holds no cover and whose files carry no embedded picture gets ONE image
 * downloaded into this app's own data directory, and the row remembers where
 * it came from. Everything else about the album is what the tags said.
 *
 * NO KEYS, AND NOTHING THAT NEEDS AN ACCOUNT. Two open services do the whole
 * job:
 *
 *   MusicBrainz      — an open music database. No key. Its terms ask for at
 *                      most one request a second and a User-Agent that says
 *                      who is calling, both of which are honoured below and
 *                      neither of which is optional.
 *   Cover Art Archive — the cover images for those releases, run with the
 *                      Internet Archive. No key, and the "front" endpoints
 *                      redirect straight to the image.
 *
 * HOW LITTLE IT ASKS. One search per album, and a second one only when the
 * first found nothing. A miss is remembered for a week so a library with two
 * hundred coverless bootlegs does not re-ask about them every six hours. A hit
 * is remembered forever, because the file is on disk.
 *
 * WHAT IT MATCHES ON. The album title and the artist first — the strongest
 * thing the tags give. When that finds nothing, the TRACK NAMES: two of them,
 * searched as recordings by the same artist, and the release group both agree
 * on is the record. That second path is what rescues an album whose folder is
 * named right and whose album tag is blank or wrong.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { normalise, artistKey, splitEdition } = require("./match");
const { albumNames } = require("./db");

/* The name the LIBRARY shows — see lib/db.js. An album whose artist tag is
   missing is exactly the album a user corrects by hand, and asking the Cover
   Art Archive about the blank the files carry rather than the name they typed
   would waste the one request this app is allowed to make for it. */
const NAME = albumNames("a");

/* The album's MusicBrainz id, which lives on the TRACKS because that is where
   the tag is. Any one of them will do — a folder's files name the same
   release — so the first non-empty answers, and a folder with none gives no
   row, which reads as null. */
const MBID_OF = `(SELECT t.mbid FROM tracks t
                  WHERE t.album_id = a.id AND t.present = 1 AND t.mbid <> ''
                  LIMIT 1)`;

const MB_ROOT = "https://musicbrainz.org/ws/2";
const CAA_ROOT = "https://coverartarchive.org";
/*
 * The iTunes Search API. No key, no account, no registration — which is the
 * only reason it is allowed here at all; the rule is that a source needing a
 * key is not a source for this project.
 *
 * Last, and only when MusicBrainz found nothing, because it answers a
 * different question: MusicBrainz says "this release", Apple says "a record on
 * our store whose name looks like that". The same artist+title check is
 * applied to its answer, so it is a fallback rather than a lowering of the
 * bar — but the Cover Art Archive's picture is of the release the library
 * actually holds, and this one is of whatever edition Apple sells.
 */
const ITUNES_ROOT = "https://itunes.apple.com/search";

/*
 * The only hosts an image is ever downloaded from.
 *
 * Every cover URL is one this module built, so this cannot currently be
 * reached with anything else — it is here so that stays true when the manual
 * picker hands a chosen candidate back. A server that will fetch a URL for you
 * is a server that will fetch your router's admin page for you.
 */
const IMAGE_HOSTS = [
  "coverartarchive.org", "ia801.us.archive.org", "archive.org",
  "mzstatic.com", "apple.com"
];

function hostAllowed(url, extra) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  const allowed = IMAGE_HOSTS.slice();
  /* A configured stand-in is trusted for the same reason it exists: it is set
     by whoever started the process, not by anything arriving over the wire. */
  if (extra) { try { allowed.push(new URL(extra).hostname.toLowerCase()); } catch { /* not a URL */ } }
  return allowed.some(ok => host === ok || host.endsWith("." + ok));
}

/* MusicBrainz asks for one request per second per application. This is the one
   gate every caller queues on: comparing timestamps let two callers awaiting
   at the same moment both read the same "last" value and both go, which is
   exactly the rate limit being broken by the code meant to honour it. */
const MB_GAP_MS = 1100;

const REQUEST_TIMEOUT_MS = 20000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/* A lookup that found nothing is retried after a week. Long enough that a
   coverless library costs a handful of requests rather than hundreds; short
   enough that an album MusicBrainz gained last month is found this month. */
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/*
 * WHICH SET OF SOURCES A MISS WAS RECORDED AGAINST.
 *
 * A miss means "none of the places we knew about had it". That stops being
 * true the moment a new place is added — so without this, adding a source
 * would leave every album that had already failed sitting out its week-long
 * cooldown against sources that were never asked. Bump it and every stored
 * miss is retried on the next sweep; hits are untouched, because the file is
 * on disk and no new source changes that.
 *
 *   1 — MusicBrainz by album name, then by track names
 *   2 — the release id in the files first, and iTunes last
 */
const LOOKUP_GEN = 2;

/* Being told to slow down is the one answer that must change behaviour rather
   than just be logged. A 503 from MusicBrainz means the whole sweep waits. */
const BACKOFF_MS = 60000;

const IMAGE_EXT = {
  "image/jpeg": ".jpg", "image/png": ".png",
  "image/webp": ".webp", "image/gif": ".gif"
};

/*
 * Who is calling.
 *
 * MusicBrainz blocks a client that does not identify itself, and the string
 * has to carry an application, a version and a way to get in touch. The
 * project's own URL is the contact — this is a program people run at home, and
 * putting an installation's own address in here would be publishing it.
 */
function userAgent(version) {
  return `MusicD-Server/${version || "0"} ( https://github.com/meltface-80/MusicD-Server )`;
}

/* Lucene escaping. An album called "Where Are We Now?" is a syntax error
   otherwise, and one called "AC/DC Live" is a field query for nothing. */
function quote(s) {
  return String(s || "").replace(/([+\-!(){}[\]^"~*?:\\/])/g, "\\$1");
}

/*
 * `available` and `enabled` are two different answers and both have to travel.
 *
 * `available` is the CONTAINER's answer — COVER_LOOKUP — and nothing a phone
 * does can change it. `enabled` is the switch in the side menu. The client
 * hides the row entirely on the first and dims it on the second, so a status
 * that reports only one of them leaves the row hidden for ever: which is
 * exactly what shipped in 0.4.9, because `available` was added to the
 * /api/covers replies and not to the status object the menu actually reads.
 */
/*
 * `roots` is undefined in every real install, which leaves the three services
 * at their own addresses. It exists so an end-to-end check can point the WHOLE
 * path — the routes, this module, the rate gate, the User-Agent, the host
 * allowlist and the store — at a stand-in over real HTTP, rather than testing a
 * renderer fed by hand. Same reason lib/info.js takes apiRoot.
 */
function createCovers({ db, dataDir, version, available = true, enabled = true,
                        fetchImpl = null, gapMs = MB_GAP_MS, roots = null }) {
  const MB = (roots && roots.mb) || MB_ROOT;
  const CAA = (roots && roots.caa) || CAA_ROOT;
  const ITUNES = (roots && roots.itunes) || ITUNES_ROOT;
  const dir = path.join(dataDir, "cache", "art", "fetched");
  const http = fetchImpl || ((...args) => fetch(...args));
  const UA = userAgent(version);

  const state = {
    available: !!available,
    enabled: !!available && !!enabled,
    running: false,
    done: 0, total: 0, found: 0,
    startedAt: 0, finishedAt: 0,
    last: "", error: ""
  };

  /* ---------------------------------------------------------------- */
  /*  The rate gate                                                    */
  /* ---------------------------------------------------------------- */

  let chain = Promise.resolve();
  let lastCall = 0;
  let holdUntil = 0;

  function wait() {
    const mine = chain.then(async () => {
      const until = Math.max(lastCall + gapMs, holdUntil);
      const gap = until - Date.now();
      if (gap > 0) await new Promise(r => setTimeout(r, gap));
      lastCall = Date.now();
    });
    /* One caller's rejection must not poison the queue for everyone behind
       it — the chain is a turn-taking order, not a dependency. */
    chain = mine.catch(() => {});
    return mine;
  }

  async function get(url, headers) {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await http(url, {
        headers: { "User-Agent": UA, ...headers },
        redirect: "follow",
        signal: control.signal
      });
    } finally { clearTimeout(timer); }
  }

  async function askMusicBrainz(url) {
    await wait();
    const res = await get(url, { Accept: "application/json" });
    if (res.status === 503 || res.status === 429) {
      /* Told to slow down. The whole gate waits, not just this call — asking
         again immediately is what turns a throttle into a block. */
      holdUntil = Date.now() + BACKOFF_MS;
      throw new Error("MusicBrainz asked for a slower pace");
    }
    if (!res.ok) throw new Error("MusicBrainz answered " + res.status);
    return res.json();
  }

  /* ---------------------------------------------------------------- */
  /*  Deciding a hit is really this album                              */
  /* ---------------------------------------------------------------- */

  /* Stylisation-folded, and containment counts: MusicBrainz credits
     "Slowdive feat. Someone" where the tags say "Slowdive". */
  function artistAgrees(credit, artist) {
    const theirs = artistKey(credit), ours = artistKey(artist);
    if (!theirs || !ours) return false;
    return theirs === ours || theirs.includes(ours) || ours.includes(theirs);
  }

  function creditOf(entity) {
    return (entity["artist-credit"] || [])
      .map(c => (c && (c.name || (c.artist && c.artist.name))) || "").join(" ");
  }

  /*
   * The album title and the artist. The strongest thing the tags give, and
   * one request.
   *
   * Matched on the title with its edition marker taken off, because that is
   * how the library itself groups versions — the deluxe edition of a record
   * and the record are one release group at MusicBrainz too.
   */
  async function byTitle(title, artist) {
    const base = splitEdition(title).base;
    const query = `releasegroup:"${quote(base)}" AND artist:"${quote(artist)}"`;
    const body = await askMusicBrainz(
      `${MB}/release-group/?query=${encodeURIComponent(query)}&fmt=json&limit=5`);
    const want = normalise(base);
    for (const group of body["release-groups"] || []) {
      if (!group || !group.id) continue;
      if (Number(group.score) < 85) continue;
      if (normalise(group.title || "") !== want) continue;
      if (!artistAgrees(creditOf(group), artist)) continue;
      return { kind: "release-group", id: group.id, why: "album name" };
    }
    return null;
  }

  /*
   * THE ID THE FILES ALREADY CARRY.
   *
   * Picard and most tagging tools write the MusicBrainz release id into the
   * files, and a great many libraries have it. It is the only EXACT identity
   * this app ever gets for nothing: with it there is no search, no scoring, no
   * artist comparison and no way to match the wrong record — the id names one
   * release and the Cover Art Archive is asked about that release.
   *
   * So it goes first, ahead of everything that guesses. It also costs no
   * MusicBrainz request at all, which is why an album that has one is answered
   * without ever touching the rate gate.
   */
  function byTaggedId(album) {
    const id = String(album.mbid || "").trim();
    /* A UUID or nothing. A malformed tag must not become a URL. */
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    return { kind: "release", id, why: "the id in the files" };
  }

  /*
   * Apple, last, when MusicBrainz knew nothing.
   *
   * Keyless and accountless, which is the whole of why it is allowed. It is
   * asked a different question from MusicBrainz — "a record on the store whose
   * name looks like this" rather than "this release" — so the same artist and
   * title agreement is demanded of its answer before it is believed.
   *
   * artworkUrl100 is a thumbnail; the same path at 600x600 is the full cover,
   * which is a documented property of these URLs rather than a guess.
   */
  async function byItunes(title, artist) {
    const base = splitEdition(title).base;
    const url = `${ITUNES}?term=${encodeURIComponent(artist + " " + base)}` +
                "&entity=album&limit=5";
    let body;
    try {
      const res = await get(url, { Accept: "application/json" });
      if (!res.ok) return null;
      body = await res.json();
    } catch {
      /* Apple being unreachable is not a reason to fail the album — it is the
         last source tried, and the caller records "no release matched". */
      return null;
    }
    const want = normalise(base);
    for (const hit of (body && body.results) || []) {
      if (!hit || !hit.artworkUrl100) continue;
      if (normalise(hit.collectionName || "") !== want) continue;
      if (!artistAgrees(hit.artistName || "", artist)) continue;
      return {
        kind: "itunes", id: String(hit.collectionId || ""), why: "the iTunes store",
        url: String(hit.artworkUrl100).replace("100x100", "600x600")
      };
    }
    return null;
  }

  /*
   * The track names, when the album name found nothing.
   *
   * Two tracks searched as recordings by the same artist; the release group
   * they BOTH point at is the record. One track can be on a dozen
   * compilations, so a single hit proves nothing — the agreement is the whole
   * of the evidence, which is why this needs two requests and not one.
   */
  async function byTracks(tracks, artist) {
    const chosen = tracks.filter(t => normalise(t).length >= 3).slice(0, 2);
    if (chosen.length < 2) return null;

    const seen = [];
    for (const track of chosen) {
      const query = `recording:"${quote(track)}" AND artist:"${quote(artist)}"`;
      const body = await askMusicBrainz(
        `${MB}/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=10`);
      const groups = new Set();
      for (const rec of body.recordings || []) {
        if (!rec || Number(rec.score) < 85) continue;
        if (!artistAgrees(creditOf(rec), artist)) continue;
        for (const release of rec.releases || []) {
          const group = release && release["release-group"];
          if (group && group.id) groups.add(group.id);
        }
      }
      seen.push(groups);
    }

    for (const id of seen[0]) {
      if (seen.every(set => set.has(id))) {
        return { kind: "release-group", id, why: "track names" };
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /*  The image                                                        */
  /* ---------------------------------------------------------------- */

  /* The "front" endpoints redirect to the image itself, or answer 404 when the
     release has no art — so the URL is the answer and the 404 is the "no". */
  function coverUrl(hit, size) {
    /* An iTunes hit names its own image; there is no size ladder to walk. */
    if (hit.url) return hit.url;
    return `${CAA}/${hit.kind}/${encodeURIComponent(hit.id)}/front${size}`;
  }

  async function download(url) {
    /* Belt and braces. Every URL here is one this module built, and the manual
       picker hands back a candidate by id rather than by address — but a
       server that will fetch a URL for you is a server that will fetch your
       router's admin page for you, so the check is made where the fetch is
       rather than where the caller is trusted. */
    if (!hostAllowed(url, roots && roots.caa)) throw new Error("not a cover source");
    const res = await get(url, { Accept: "image/*" });
    if (!res.ok) throw new Error("Cover Art Archive answered " + res.status);
    const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) throw new Error("that was not an image: " + (type || "unknown"));
    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length) throw new Error("the image was empty");
    if (body.length > MAX_IMAGE_BYTES) throw new Error("the image is larger than any cover needs to be");
    return { body, type };
  }

  /* 1200px first because the album screen shows a cover at up to 280 CSS
     pixels on a 3x display; 500 is the fallback for a release whose only
     upload is small, and the bare endpoint for one with no thumbnails at all. */
  const SIZES = ["-1200", "-500", ""];

  async function fetchCover(hit) {
    /* A hit that names its own image has no size ladder to walk; asking for it
       three times would be three requests for one answer. */
    if (hit.url) return download(hit.url);
    let last = null;
    for (const size of SIZES) {
      try { return await download(coverUrl(hit, size)); }
      catch (e) {
        last = e;
        /* A 404 means this release has no art at any size, so trying the other
           two sizes is three requests for one answer. Anything else might be
           this size alone. */
        if (/answered 404/.test(e.message)) break;
      }
    }
    throw last || new Error("no image");
  }

  /* ---------------------------------------------------------------- */
  /*  Storing it                                                       */
  /* ---------------------------------------------------------------- */

  /* Named for the album id, so a re-fetch replaces the file rather than
     leaving the old one behind, and so nothing has to be cleaned up when an
     album goes away. */
  function fileFor(albumId, type) {
    const name = crypto.createHash("sha1").update(albumId).digest("hex");
    return path.join(dir, name + (IMAGE_EXT[type] || ".jpg"));
  }

  function store(albumId, image, hit) {
    fs.mkdirSync(dir, { recursive: true });
    const file = fileFor(albumId, image.type);
    /* A cover fetched before as a PNG and now as a JPEG would otherwise leave
       the old file in the cache forever, referenced by nothing. */
    const stem = crypto.createHash("sha1").update(albumId).digest("hex");
    for (const ext of new Set(Object.values(IMAGE_EXT))) {
      const old = path.join(dir, stem + ext);
      if (old !== file) { try { fs.unlinkSync(old); } catch { /* it was never there */ } }
    }
    fs.writeFileSync(file, image.body);
    db.prepare("UPDATE albums SET art_fetched = ? WHERE id = ?").run(file, albumId);
    remember(albumId, 1, `${hit.kind}:${hit.id}`, hit.why);
    return file;
  }

  function remember(albumId, ok, source, note) {
    db.prepare(`INSERT INTO cover_lookups (album_id, tried_at, ok, source, note, gen)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(album_id) DO UPDATE SET
                  tried_at = excluded.tried_at, ok = excluded.ok,
                  source = excluded.source, note = excluded.note, gen = excluded.gen`)
      .run(albumId, Date.now(), ok, source || "", String(note || "").slice(0, 200), LOOKUP_GEN);
  }

  /* ---------------------------------------------------------------- */
  /*  One album                                                        */
  /* ---------------------------------------------------------------- */

  /*
   * Look for one album's cover. Returns the file it stored, or null.
   *
   * Throws only on being told to slow down, which the sweep has to hear —
   * everything else is "not found for this album" and is recorded as a miss so
   * the next sweep skips it for a week.
   */
  async function findFor(album) {
    const title = String(album.title || "").trim();
    const artist = String(album.artist || "").trim();

    /* Before anything else, and before the artist is even required: an id in
       the files names the release outright, so a compilation or a Various
       Artists record that no search could ever have found is answered exactly.
       This is also the one path that costs no MusicBrainz request. */
    let hit = byTaggedId(album);

    if (!hit) {
      /* An album with no artist is a folder of files that agreed about nothing.
         There is no query to make that would not match half a catalogue — which
         is precisely the album somebody corrects by hand and then searches for
         from the album screen. */
      if (!title || !artist || artist === "Various Artists") {
        remember(album.id, 0, "", "no artist to search on — correct the name and look again");
        return null;
      }

      const tracks = db.prepare(
        `SELECT title FROM tracks WHERE album_id = ? AND present = 1
         ORDER BY disc, no, rel LIMIT 4`).all(album.id).map(t => t.title);

      hit = await byTitle(title, artist);
      if (!hit) hit = await byTracks(tracks, artist);
      /* Apple last: it answers a looser question than MusicBrainz, so it is
         asked only once the exact sources have said no. */
      if (!hit) hit = await byItunes(title, artist);
    }
    if (!hit) { remember(album.id, 0, "", "no release matched at MusicBrainz or iTunes"); return null; }

    try {
      return store(album.id, await fetchCover(hit), hit);
    } catch (e) {
      remember(album.id, 0, `${hit.kind}:${hit.id}`, e.message);
      return null;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Looking by hand, from the album screen                           */
  /* ---------------------------------------------------------------- */

  /*
   * THE ONE PLACE THIS PROJECT ALLOWS A PICKER.
   *
   * The rule was, and for the sweep still is, that covers are not a manual
   * fetch — no picker, no candidate grid, no per-album button. That rule is
   * about the AUTOMATIC path: a background sweep that asked a person to choose
   * four hundred times would not be a background sweep.
   *
   * It does not survive contact with the albums the sweep cannot answer. A
   * record whose files carry no artist is refused before a single request is
   * made, because there is no query that would not match half a catalogue —
   * and that is exactly the album whose owner knows what it is. The name
   * editor added in 0.4.15 exists for the same reason, and this is the same
   * gesture finishing the job: correct the name, then look with it.
   *
   * The candidates are held HERE, keyed by album, and the client picks one by
   * index. The alternative — the client posting back a URL to fetch — is an
   * open proxy on the user's own network, however carefully the host is
   * checked afterwards.
   */
  const offers = new Map();          // albumId -> { at, list }
  const OFFER_TTL_MS = 10 * 60 * 1000;

  function albumRow(albumId) {
    return db.prepare(
      `SELECT a.id, ${NAME.title} AS title, ${NAME.artist} AS artist, ${MBID_OF} AS mbid
       FROM albums a WHERE a.id = ?`).get(albumId) || null;
  }

  /* Why the sweep gave up on this album, in the words it recorded at the time.
     "24 missing and nothing happening" is unanswerable without it. */
  function reasonFor(albumId) {
    const row = db.prepare(
      "SELECT ok, note, tried_at FROM cover_lookups WHERE album_id = ?").get(albumId);
    if (!row || row.ok) return "";
    return row.note || "";
  }

  /*
   * Every cover any source can offer for this album, best first.
   *
   * The title and artist come from the CALLER, not the database, so a name
   * corrected in the dialog above is the name searched with — before it has
   * been saved, if that is what the person wants to try.
   */
  async function candidatesFor(albumId, title, artist) {
    const row = albumRow(albumId);
    if (!row) return [];
    const name = String(title || row.title || "").trim();
    const who = String(artist || row.artist || "").trim();
    const base = splitEdition(name).base;
    const list = [];
    const add = (c) => { if (c && !list.some(x => x.url === c.url)) list.push(c); };

    /* The id in the files: exact, and free. */
    const tagged = byTaggedId(row);
    if (tagged) {
      add({ url: coverUrl(tagged, "-1200"), thumb: coverUrl(tagged, "-250"),
            source: "Cover Art Archive", why: "the id in the files" });
    }

    if (who && base) {
      try {
        const hit = await byTitle(name, who);
        if (hit) {
          add({ url: coverUrl(hit, "-1200"), thumb: coverUrl(hit, "-250"),
                source: "Cover Art Archive", why: "album name" });
        }
      } catch { /* one source down is not the end of the search */ }

      try {
        const res = await get(
          `${ITUNES}?term=${encodeURIComponent(who + " " + base)}&entity=album&limit=8`,
          { Accept: "application/json" });
        if (res.ok) {
          const body = await res.json();
          for (const hit of (body && body.results) || []) {
            if (!hit || !hit.artworkUrl100) continue;
            /* Looser than the automatic path on purpose: a person is looking at
               these and can tell a wrong sleeve at a glance, which is the whole
               advantage a picker has over a sweep. The artist must still agree,
               so the grid is this record's editions rather than a search page. */
            if (!artistAgrees(hit.artistName || "", who)) continue;
            add({
              url: String(hit.artworkUrl100).replace("100x100", "600x600"),
              thumb: String(hit.artworkUrl100).replace("100x100", "250x250"),
              source: "iTunes", why: String(hit.collectionName || "")
            });
          }
        }
      } catch { /* ditto */ }
    }

    /* Nine: three rows of three, which is as many sleeves as anybody compares
       at a glance and keeps the dialog a dialog rather than a search page. */
    const shown = list.slice(0, 9);
    offers.set(albumId, { at: Date.now(), list: shown });
    return shown.map((c, i) => ({ i, thumb: c.thumb, source: c.source, why: c.why }));
  }

  /* Take one of the offers above and make it this album's cover. */
  async function chooseFor(albumId, index) {
    const held = offers.get(albumId);
    if (!held || Date.now() - held.at > OFFER_TTL_MS) {
      throw new Error("Those results have expired — search again.");
    }
    const chosen = held.list[Number(index)];
    if (!chosen) throw new Error("That is not one of the results.");
    const image = await download(chosen.url);
    /* Stored exactly as a swept cover is, so nothing downstream — the tile, the
       queue, Now playing, the speaker's metadata — can tell the two apart. */
    return store(albumId, image, { kind: "chosen", id: chosen.source, why: chosen.why });
  }

  /* ---------------------------------------------------------------- */
  /*  The sweep                                                        */
  /* ---------------------------------------------------------------- */

  /* Every album with no cover of its own that has not been looked for
     recently. A version behind a tab counts: its own tab shows its own cover,
     and an empty tile there looks as broken as one on the home screen. */
  function pending() {
    return db.prepare(
      `SELECT a.id, ${NAME.title} AS title, ${NAME.artist} AS artist,
              ${MBID_OF} AS mbid
       FROM albums a
       LEFT JOIN cover_lookups c ON c.album_id = a.id
       WHERE a.present = 1 AND a.art = '' AND a.art_fetched = ''
         AND (c.album_id IS NULL
              OR (c.ok = 0 AND (c.gen < ? OR c.tried_at < ?)))
       ORDER BY a.added_at DESC`).all(LOOKUP_GEN, Date.now() - MISS_TTL_MS);
  }

  /*
   * Every album still without a cover, and what the last look made of it.
   *
   * NOT pending(): that answers "what is due a look", which leaves out
   * everything inside its week-long cooldown — and the question this answers is
   * "which of my albums have no picture", where a miss recorded yesterday is
   * exactly the one somebody wants to see. Ordered by artist so the list reads
   * as a shelf rather than as a scan log.
   */
  function missing(limit = 500) {
    return db.prepare(
      `SELECT a.id, ${NAME.title} AS title, ${NAME.artist} AS artist,
              COALESCE(c.note, '') AS note, COALESCE(c.tried_at, 0) AS triedAt
       FROM albums a
       LEFT JOIN cover_lookups c ON c.album_id = a.id AND c.ok = 0
       WHERE a.present = 1 AND a.art = '' AND a.art_fetched = ''
       ORDER BY ${NAME.sortArtist}, ${NAME.sortTitle}
       LIMIT ?`).all(Math.max(1, Math.min(2000, Number(limit) || 500)));
  }

  /*
   * Walk the coverless albums, one at a time.
   *
   * Sequential because the rate gate makes it sequential anyway, and because
   * the alternative — a dozen in flight all waiting on the same gate — is the
   * same speed with a dozen sockets open. Only one sweep runs at once.
   */
  async function sweep({ onFound = () => {} } = {}) {
    if (state.running || !state.available || !state.enabled) return state;
    const albums = pending();
    Object.assign(state, {
      running: true, done: 0, total: albums.length, found: 0,
      startedAt: Date.now(), finishedAt: 0, error: ""
    });
    if (albums.length) console.log(`[covers] looking for ${albums.length} missing cover(s)`);
    try {
      for (const album of albums) {
        if (!state.enabled) break;               // switched off mid-sweep
        try {
          const file = await findFor(album);
          if (file) { state.found++; onFound(album, file); }
        } catch (e) {
          /* Being asked to slow down is the only error that stops the sweep:
             the gate is already holding, and grinding through two hundred more
             albums against a hold is how a polite client becomes a blocked
             one. Anything else was recorded against the album. */
          state.error = e.message;
          console.warn("[covers] stopping: " + e.message);
          break;
        }
        state.done++;
      }
      state.last = state.total
        ? `${state.found} of ${state.total} found`
        : "nothing missing a cover";
      if (state.total) console.log(`[covers] ${state.last}`);
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
    return state;
  }

  function status() {
    const counts = db.prepare(
      `SELECT COUNT(*) AS missing FROM albums
       WHERE present = 1 AND art = '' AND art_fetched = ''`).get();
    const found = db.prepare(
      "SELECT COUNT(*) AS n FROM albums WHERE art_fetched <> ''").get().n;
    return {
      available: state.available,
      enabled: state.enabled,
      running: state.running,
      done: state.done, total: state.total, found: state.found,
      missing: counts.missing, fetched: found,
      last: state.last, error: state.error
    };
  }

  /* A container that said no cannot be talked round from a phone. */
  function setEnabled(on) {
    state.enabled = state.available && !!on;
    return state.enabled;
  }

  return { sweep, findFor, status, setEnabled, pending, missing,
           candidatesFor, chooseFor, reasonFor, userAgent: () => UA };
}

module.exports = { createCovers, userAgent, MISS_TTL_MS, MB_GAP_MS };
