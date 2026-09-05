"use strict";

/*
 * What a record is, and who made it.
 *
 * THE FAKE WIKIPEDIA BELOW REFUSES THINGS, and every refusal is one the real
 * one makes:
 *
 *   - 403 to a client that will not say who it is, which Wikimedia's terms
 *     require and their infrastructure enforces;
 *   - ONE extract when exlimit is missing, because exlimit defaults to 1. That
 *     is the trap this whole file exists to guard: a caller that forgets it
 *     gets five search results and a single extract, which works perfectly
 *     until the right page is the second hit and then fails silently for ever;
 *   - a disambiguation page for "Hex", because that is genuinely what
 *     Wikipedia has under that title.
 *
 * A stand-in that answered whatever it was asked would pass all of this while
 * the real service refused every request. That mistake cost this project four
 * passing transport tests and three releases of a broken updater.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dbLib = require("../lib/db");
const scanner = require("../lib/scanner");
const library = require("../lib/library");
const { createInfo, userAgent, section, clamp, stripHtml,
        namesArtist, isDisambiguation, MISS_TTL_MS } = require("../lib/info");
const { wav } = require("./fixtures");

const API = "https://en.wikipedia.org/w/api.php";

/* ------------------------------------------------------------------ */
/*  A library on disk                                                  */
/* ------------------------------------------------------------------ */

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-info-"));
  return {
    root,
    music: path.join(root, "music"),
    data: path.join(root, "data"),
    art: path.join(root, "data", "cache", "art"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function putAlbum(root, dir, { album, artist, tracks }) {
  const full = path.join(root, dir);
  fs.mkdirSync(full, { recursive: true });
  tracks.forEach((title, i) => {
    fs.writeFileSync(path.join(full, `${String(i + 1).padStart(2, "0")} ${title}.wav`),
      wav({ seconds: 1, title, artist, album, albumArtist: artist, track: i + 1 }));
  });
}

async function scanned() {
  const ws = workspace();
  putAlbum(ws.music, "Bark Psychosis/Hex", {
    album: "Hex", artist: "Bark Psychosis",
    tracks: ["The Loom", "A Street Scene", "Absent Friend"]
  });
  putAlbum(ws.music, "Slowdive/Souvlaki (Deluxe Edition)", {
    album: "Souvlaki (Deluxe Edition)", artist: "Slowdive",
    tracks: ["Alison", "Machine Gun", "40 Days"]
  });
  const db = dbLib.open(ws.data);
  await scanner.scan(db, [ws.music], { artDir: ws.art });
  return { ws, db };
}

const albumId = (db, title) =>
  db.prepare("SELECT id FROM albums WHERE title = ?").get(title).id;

/* ------------------------------------------------------------------ */
/*  A Wikipedia as strict as the real one                              */
/* ------------------------------------------------------------------ */

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/* The pages this Wikipedia holds. Keyed by title, as Wikipedia is. */
const PAGES = {
  "Hex (Bark Psychosis album)": {
    intro: "Hex is the debut studio album by the English post-rock band Bark " +
           "Psychosis, released in February 1994 on Circa Records.",
    body: "Hex is the debut studio album by the English post-rock band Bark Psychosis.\n" +
          "\n== Recording ==\n\nRecorded over three years in a church in Stratford.\n" +
          "\n== Critical reception ==\n\nHex was acclaimed on release. Simon Reynolds " +
          "coined the term post-rock in his review of the album for Mojo.\n" +
          "\n== Track listing ==\n\n1. The Loom\n2. A Street Scene\n"
  },
  "Hex": {
    disambiguation: true,
    intro: "Hex may refer to: hexadecimal, a curse, or several albums and films."
  },
  "Bark Psychosis": {
    intro: "Bark Psychosis are an English post-rock band formed in 1986 in " +
           "Snaresbrook, east London, by Graham Sutton and John Ling."
  },
  /* A DIFFERENT record with the SAME name. It is an album, it is about music,
     and its title scores exactly as well as the right one — so every signal
     except the artist says yes to it. */
  "Hex (Earth album)": {
    intro: "Hex; Or Printing in the Infernal Method is the fifth studio album " +
           "by the American drone metal band Earth, released in 2005."
  },
  "Souvlaki (album)": {
    intro: "Souvlaki is the second studio album by the English shoegaze band " +
           "Slowdive, released on 17 May 1993 by Creation Records.",
    body: "Souvlaki is the second studio album by Slowdive.\n" +
          "\n== Critical reception ==\n\nInitially panned, Souvlaki has since been " +
          "reappraised as a landmark of the genre.\n\n== Personnel ==\n\nRachel Goswell\n"
  },
  /* A page that names no musician at all: the trap a bare-name search falls
     into, and the reason the verification exists. */
  "Souvlaki": {
    intro: "Souvlaki is a Greek dish of small pieces of meat grilled on a skewer."
  }
};

/*
 * Which pages a search term finds, in the order Wikipedia would rank them.
 *
 * Deliberately imperfect: "Hex Bark Psychosis album" puts the disambiguation
 * page FIRST, because a real search engine ranks on words and the
 * disambiguation page contains all of them. A caller that takes the first hit
 * is wrong here, which is the point.
 */
const SEARCHES = {
  "hex bark psychosis album": [
    "Hex", "Hex (Earth album)", "Hex (Bark Psychosis album)", "Bark Psychosis"
  ],
  "bark psychosis": ["Bark Psychosis", "Hex (Bark Psychosis album)"],
  "souvlaki slowdive album": ["Souvlaki", "Souvlaki (album)"],
  "slowdive": ["Souvlaki (album)"],
  "nowhere nobody album": [],
  "nobody": []
};

function fakeWikipedia({ onCall = () => {} } = {}) {
  return async (url, options) => {
    const agent = (options && options.headers && options.headers["User-Agent"]) || "";
    const q = new URL(url).searchParams;
    onCall({ url, params: q, agent });

    /* Wikimedia asks every client to identify itself with an application, a
       version and a contact, and refuses one that does not. */
    if (!agent || !/\S+\/\d/.test(agent) || !/https?:\/\//.test(agent)) {
      return reply(403, { error: { code: "http-bad-ua" } });
    }

    const build = (titles, { intro }) => {
      /* THE DEFAULT THAT BITES. exlimit is 1 unless the caller says otherwise,
         so only the first page comes back with an extract. */
      const limit = intro ? Number(q.get("exlimit") || 1) : 1;
      return titles.map((title, i) => {
        const page = PAGES[title] || {};
        const out = { pageid: i + 1, title };
        if (i < limit) out.extract = intro ? page.intro : (page.body || page.intro);
        if (page.disambiguation) out.pageprops = { disambiguation: "" };
        return out;
      });
    };

    if (q.get("generator") === "search") {
      const term = String(q.get("gsrsearch") || "").toLowerCase().trim();
      const titles = SEARCHES[term] || [];
      if (!titles.length) return reply(200, { batchcomplete: true });
      return reply(200, { query: { pages: build(titles, { intro: true }) } });
    }

    if (q.get("titles")) {
      return reply(200, { query: { pages: build([q.get("titles")], { intro: false }) } });
    }
    return reply(200, {});
  };
}

/* Last.fm, which answers about things Wikipedia has never heard of. */
function fakeLastfm(plan = {}) {
  return {
    describeArtist: async (artist) => plan.artist ? plan.artist(artist) : {},
    describeAlbum: async (album, artist) => plan.album ? plan.album(album, artist) : {}
  };
}

function build(db, extra = {}) {
  return createInfo({
    db, version: "9.9.9", apiRoot: API, gapMs: 0,
    fetchImpl: fakeWikipedia(extra.wiki || {}),
    ...extra
  });
}

/* ------------------------------------------------------------------ */
/*  The article an ID names                                            */
/* ------------------------------------------------------------------ */

const WIKIDATA = "https://wikidata.test/w/api.php";

/*
 * A stand-in for lib/covers.js's share of the gate. It refuses an unidentified
 * client the way MusicBrainz does, so a caller that stopped saying who it is
 * fails here instead of in production.
 */
function fakeCovers({ group = "rg-hex", relations = [], seen = [], agent = "MusicD/9.9.9 ( https://x )" } = {}) {
  const check = () => {
    if (!/\S+\/\d/.test(agent) || !/https?:\/\//.test(agent)) {
      throw new Error("MusicBrainz answered 403");
    }
  };
  return {
    groupOfRelease: async (id, options) => {
      seen.push({ call: "groupOfRelease", id, urgent: !!(options && options.urgent) });
      check();
      return group;
    },
    lookupMusicBrainz: async (entity, id, inc) => {
      seen.push({ call: "lookup", entity, id, inc });
      check();
      return { id, relations };
    }
  };
}

/* Wikipedia and Wikidata in one stand-in, since both are the same Action API
   and the caller reaches them through the same asker. */
function fakeWikimedia({ onCall = () => {}, entities = {} } = {}) {
  const wiki = fakeWikipedia({ onCall });
  return async (url, options) => {
    if (!url.startsWith(WIKIDATA)) return wiki(url, options);
    const q = new URL(url).searchParams;
    onCall({ url, params: q, agent: (options.headers || {})["User-Agent"] || "" });
    /* The real one only returns the sitelinks that were asked for. */
    assert.strictEqual(q.get("props"), "sitelinks");
    assert.strictEqual(q.get("sitefilter"), "enwiki");
    const id = q.get("ids");
    return reply(200, { entities: { [id]: entities[id] || { sitelinks: {} } } });
  };
}

const WD_HEX = { sitelinks: { enwiki: { site: "enwiki", title: "Hex (Bark Psychosis album)" } } };

test("a confirmed release gets THE article, with no search at all", async () => {
  /*
   * The whole reason identification is worth having twice over. A search
   * always answers — Wikipedia ranks the disambiguation page for "Hex" above
   * the Bark Psychosis album — so a searched page has to be checked against
   * the library's own facts, and an album whose tags are wrong has no facts
   * worth checking against. An id has none of that trouble.
   */
  const { ws, db } = await scanned();
  try {
    const id = albumId(db, "Hex");
    db.prepare("UPDATE albums SET mbid_chosen = ? WHERE id = ?")
      .run("11111111-2222-3333-4444-555555555555", id);

    const calls = [];
    const seen = [];
    const info = build(db, {
      wikidataRoot: WIKIDATA,
      covers: fakeCovers({ relations: [
        { type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q42" } }
      ], seen }),
      fetchImpl: fakeWikimedia({ onCall: (c) => calls.push(c), entities: { Q42: WD_HEX } })
    });

    const out = await info.album(id);
    assert.ok(out, "an album with an id gets a write-up");
    assert.strictEqual(out.title, "Hex (Bark Psychosis album)");
    assert.match(out.summary, /debut studio album by the English post-rock band/);
    assert.match(out.review, /Simon Reynolds/, "and the reception, out of the same request");
    assert.strictEqual(out.source, "wikipedia");
    assert.strictEqual(out.licence, "CC BY-SA 4.0");

    /* NOTHING was searched for. That is the point. */
    assert.ok(!calls.some(c => c.params.get("generator") === "search"),
      calls.map(c => c.url).join(" | "));
    /* And it asked MusicBrainz which RECORD the pressing belongs to, urgently,
       because somebody has a screen open. */
    assert.deepStrictEqual(seen[0],
      { call: "groupOfRelease", id: "11111111-2222-3333-4444-555555555555", urgent: true });
    assert.deepStrictEqual(seen[1],
      { call: "lookup", entity: "release-group", id: "rg-hex", inc: "url-rels" });
  } finally { db.close(); ws.cleanup(); }
});

test("a direct Wikipedia relation skips Wikidata entirely", async () => {
  /* MusicBrainz moved these to Wikidata, but the older direct link is still
     on plenty of release groups and costs one request fewer. */
  const { ws, db } = await scanned();
  try {
    const id = albumId(db, "Hex");
    db.prepare("UPDATE albums SET mbid_chosen = ? WHERE id = ?")
      .run("11111111-2222-3333-4444-555555555555", id);
    const calls = [];
    const info = build(db, {
      wikidataRoot: WIKIDATA,
      covers: fakeCovers({ relations: [
        { type: "wikipedia",
          url: { resource: "https://en.wikipedia.org/wiki/Hex_(Bark_Psychosis_album)" } }
      ] }),
      fetchImpl: fakeWikimedia({ onCall: (c) => calls.push(c) })
    });
    const out = await info.album(id);
    assert.strictEqual(out.title, "Hex (Bark Psychosis album)", "the title is read out of the URL");
    assert.ok(!calls.some(c => c.url.startsWith(WIKIDATA)), "Wikidata was never asked");
    /* And it came from the LINK, not from a search that happens to reach the
       same page — without this the test passes with the relation ignored. */
    assert.ok(!calls.some(c => c.params.get("generator") === "search"),
      calls.map(c => c.url).join(" | "));
  } finally { db.close(); ws.cleanup(); }
});

test("a release group with no article falls back to the search", async () => {
  /* Most release groups have no link at all. The id path answering nothing is
     the ordinary case, not a failure, and the album must still get whatever a
     search can verify. */
  const { ws, db } = await scanned();
  try {
    const id = albumId(db, "Hex");
    db.prepare("UPDATE albums SET mbid_chosen = ? WHERE id = ?")
      .run("11111111-2222-3333-4444-555555555555", id);
    const calls = [];
    const info = build(db, {
      wikidataRoot: WIKIDATA,
      covers: fakeCovers({ relations: [] }),
      fetchImpl: fakeWikimedia({ onCall: (c) => calls.push(c) })
    });
    const out = await info.album(id);
    assert.ok(out, "the search still found it");
    assert.strictEqual(out.title, "Hex (Bark Psychosis album)");
    assert.ok(calls.some(c => c.params.get("generator") === "search"), "by searching");
  } finally { db.close(); ws.cleanup(); }
});

test("MusicBrainz being down falls back to the search rather than failing", async () => {
  const { ws, db } = await scanned();
  try {
    const id = albumId(db, "Hex");
    db.prepare("UPDATE albums SET mbid_chosen = ? WHERE id = ?")
      .run("11111111-2222-3333-4444-555555555555", id);
    const info = build(db, {
      wikidataRoot: WIKIDATA,
      covers: { groupOfRelease: async () => { throw new Error("unreachable"); },
                lookupMusicBrainz: async () => { throw new Error("unreachable"); } },
      fetchImpl: fakeWikimedia({})
    });
    const out = await info.album(id);
    assert.ok(out && out.title === "Hex (Bark Psychosis album)");
  } finally { db.close(); ws.cleanup(); }
});

test("an album with no id is unaffected", async () => {
  /* Most albums have none, and nothing about them may change: no extra
     request, and the same verified search as before. */
  const { ws, db } = await scanned();
  try {
    const seen = [];
    const info = build(db, {
      wikidataRoot: WIKIDATA,
      covers: fakeCovers({ seen }),
      fetchImpl: fakeWikimedia({})
    });
    const out = await info.album(albumId(db, "Hex"));
    assert.strictEqual(out.title, "Hex (Bark Psychosis album)");
    assert.deepStrictEqual(seen, [], "MusicBrainz was never troubled");
  } finally { db.close(); ws.cleanup(); }
});

test("the id path is kept like any other hit — asked once, ever", async () => {
  const { ws, db } = await scanned();
  try {
    const id = albumId(db, "Hex");
    db.prepare("UPDATE albums SET mbid_chosen = ? WHERE id = ?")
      .run("11111111-2222-3333-4444-555555555555", id);
    const seen = [];
    const info = build(db, {
      wikidataRoot: WIKIDATA,
      covers: fakeCovers({ relations: [
        { type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q42" } }
      ], seen }),
      fetchImpl: fakeWikimedia({ entities: { Q42: WD_HEX } })
    });
    await info.album(id);
    const after = seen.length;
    await info.album(id);
    assert.strictEqual(seen.length, after, "the second open asked nobody anything");
  } finally { db.close(); ws.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  Asking correctly                                                   */
/* ------------------------------------------------------------------ */

test("an unidentified client is refused, so this one identifies itself", async () => {
  const { ws, db } = await scanned();
  try {
    const agents = [];
    const info = createInfo({
      db, version: "0.4.17", apiRoot: API, gapMs: 0,
      fetchImpl: fakeWikipedia({ onCall: c => agents.push(c.agent) })
    });
    const found = await info.album(albumId(db, "Hex"));
    assert.ok(found, "a refused client would have found nothing");
    assert.ok(agents.length, "it did make a request");
    for (const agent of agents) {
      assert.match(agent, /MusicD-Server\/0\.4\.17/, "the app and its version");
      assert.match(agent, /https:\/\/github\.com/, "and somewhere to complain");
    }
  } finally { ws.cleanup(); }
});

test("the search asks for every candidate's extract, not just the first", async () => {
  /* exlimit defaults to 1. Without it the fake returns one extract, the second
     hit has none to verify, and the right page can never be chosen — which is
     exactly how this fails against the real Wikipedia. */
  const { ws, db } = await scanned();
  try {
    const searches = [];
    const info = createInfo({
      db, version: "9.9.9", apiRoot: API, gapMs: 0,
      fetchImpl: fakeWikipedia({
        onCall: c => { if (c.params.get("generator") === "search") searches.push(c.params); }
      })
    });
    await info.album(albumId(db, "Hex"));
    assert.ok(searches.length, "a search went out");
    for (const q of searches) {
      assert.ok(Number(q.get("exlimit")) > 1, "exlimit is set past its default of 1");
      assert.strictEqual(q.get("exintro"), "1", "and extracts are only multiple with exintro");
      assert.strictEqual(q.get("explaintext"), "1", "plain text, not HTML");
      assert.strictEqual(q.get("gsrnamespace"), "0", "articles only");
    }
  } finally { ws.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  Believing the right page                                           */
/* ------------------------------------------------------------------ */

test("the first search result is not taken on trust", async () => {
  /* Wikipedia ranks the disambiguation page for "Hex" above the album, because
     it contains every word of the query. Taking the first hit would attach a
     list of hexadecimal links to a post-rock record. */
  const { ws, db } = await scanned();
  try {
    const found = await build(db).album(albumId(db, "Hex"));
    assert.ok(found, "the album was found");
    assert.strictEqual(found.title, "Hex (Bark Psychosis album)",
      "the second hit, because the first is a disambiguation page");
    assert.match(found.summary, /post-rock band Bark Psychosis/);
  } finally { ws.cleanup(); }
});

test("a page that does not name the artist is refused", async () => {
  /* "Souvlaki" the Greek dish outranks Souvlaki the album on a bare search and
     reads perfectly well. The only thing separating them is whether the page
     mentions Slowdive. */
  const { ws, db } = await scanned();
  try {
    const found = await build(db).album(albumId(db, "Souvlaki (Deluxe Edition)"));
    assert.ok(found, "the album was found");
    assert.strictEqual(found.title, "Souvlaki (album)", "the record, not the kebab");
    assert.ok(!/grilled on a skewer/.test(found.summary));
  } finally { ws.cleanup(); }
});

test("another band's album of the same name is refused", async () => {
  /*
   * THE GUARD THIS MODULE STANDS ON.
   *
   * Earth's Hex and Bark Psychosis's Hex are both albums, both about music,
   * and their titles score identically — "hex earth album" and "hex bark
   * psychosis album" both open with the record's name. Earth's is listed
   * first, so on every signal but one it wins. The only thing that separates
   * them is whether the page names the artist the library has.
   */
  const { ws, db } = await scanned();
  try {
    const found = await build(db).album(albumId(db, "Hex"));
    assert.ok(found, "the album was found");
    assert.strictEqual(found.title, "Hex (Bark Psychosis album)",
      "not the drone metal record with the same name");
    assert.ok(!/drone metal/.test(found.summary));
  } finally { ws.cleanup(); }
});

test("an edition marker is not part of the search", async () => {
  /* The library's title is "Souvlaki (Deluxe Edition)". Wikipedia has no
     article under that name and never will — the record is Souvlaki. */
  const { ws, db } = await scanned();
  try {
    const terms = [];
    const info = createInfo({
      db, version: "9.9.9", apiRoot: API, gapMs: 0,
      fetchImpl: fakeWikipedia({
        onCall: c => { if (c.params.get("gsrsearch")) terms.push(c.params.get("gsrsearch")); }
      })
    });
    await info.album(albumId(db, "Souvlaki (Deluxe Edition)"));
    assert.ok(terms.length, "something was searched for");
    assert.ok(!/deluxe/i.test(terms[0]), "the edition marker came off: " + terms[0]);
  } finally { ws.cleanup(); }
});

test("nothing confident means nothing shown", async () => {
  const { ws, db } = await scanned();
  try {
    db.prepare(`INSERT INTO albums (id, dir, title, artist, added_at)
                VALUES ('a:x/Nowhere', '', 'Nowhere', 'Nobody', 0)`).run();
    const found = await build(db).album("a:x/Nowhere");
    assert.strictEqual(found, null, "a wrong write-up is worse than an absent one");
  } finally { ws.cleanup(); }
});

test("an album with no artist is never looked up at all", async () => {
  /* The artist is the only thing a candidate page is checked against. Without
     one there is nothing to verify with, so the search is not worth making. */
  const { ws, db } = await scanned();
  try {
    let asked = 0;
    db.prepare(`INSERT INTO albums (id, dir, title, artist, added_at)
                VALUES ('a:x/Untitled', '', 'Untitled', '', 0)`).run();
    const info = createInfo({
      db, version: "9.9.9", apiRoot: API, gapMs: 0,
      fetchImpl: fakeWikipedia({ onCall: () => { asked++; } })
    });
    assert.strictEqual(await info.album("a:x/Untitled"), null);
    assert.strictEqual(asked, 0, "no request went out");
  } finally { ws.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  The write-up itself                                                */
/* ------------------------------------------------------------------ */

test("the critical reception section is pulled out of the article", async () => {
  const { ws, db } = await scanned();
  try {
    const found = await build(db).album(albumId(db, "Hex"));
    assert.match(found.review, /Simon Reynolds coined the term post-rock/);
    assert.ok(!/Recorded over three years/.test(found.review), "not the section above it");
    assert.ok(!/The Loom/.test(found.review), "and not the one below");
  } finally { ws.cleanup(); }
});

test("the licence and a link back travel with the text", async () => {
  /* Wikipedia gives its prose away on condition it is credited and linked.
     Storing the terms beside the text is what makes the credit impossible to
     get wrong later — see the info table in lib/db.js. */
  const { ws, db } = await scanned();
  try {
    const found = await build(db).album(albumId(db, "Hex"));
    assert.strictEqual(found.source, "wikipedia");
    assert.match(found.licence, /CC BY-SA/);
    assert.strictEqual(found.url,
      "https://en.wikipedia.org/wiki/Hex%20(Bark%20Psychosis%20album)".replace(/%20/g, "_"));
  } finally { ws.cleanup(); }
});

test("an artist biography is found and verified the same way", async () => {
  const { ws, db } = await scanned();
  try {
    const found = await build(db).artist("Bark Psychosis");
    assert.ok(found, "the band was found");
    assert.strictEqual(found.title, "Bark Psychosis");
    assert.match(found.summary, /English post-rock band/);
    assert.strictEqual(found.review, "", "an artist has no critical reception");
  } finally { ws.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  Kept, and kept forever                                             */
/* ------------------------------------------------------------------ */

test("a write-up is fetched once and read from the database ever after", async () => {
  const { ws, db } = await scanned();
  try {
    let requests = 0;
    const info = createInfo({
      db, version: "9.9.9", apiRoot: API, gapMs: 0,
      fetchImpl: fakeWikipedia({ onCall: () => { requests++; } })
    });
    const id = albumId(db, "Hex");
    const first = await info.album(id);
    const after = requests;
    assert.ok(after > 0, "the first open went to the network");

    for (let i = 0; i < 5; i++) {
      const again = await info.album(id);
      assert.deepStrictEqual(again, first, "the same answer");
    }
    assert.strictEqual(requests, after, "and not one more request");
  } finally { ws.cleanup(); }
});

test("a hit has no expiry — only a miss is ever asked again", async () => {
  const { ws, db } = await scanned();
  try {
    const info = build(db);
    const id = albumId(db, "Hex");
    await info.album(id);

    /* A year later. An encyclopaedia article about a 1994 record is not going
       to have become a different article. */
    const YEAR = 365 * 24 * 60 * 60 * 1000;
    db.prepare("UPDATE info SET fetched_at = ?").run(Date.now() - YEAR);

    let requests = 0;
    const later = createInfo({
      db, version: "9.9.9", apiRoot: API, gapMs: 0,
      fetchImpl: fakeWikipedia({ onCall: () => { requests++; } })
    });
    assert.ok(await later.album(id), "still known");
    assert.strictEqual(requests, 0, "and still not re-fetched");

    /* A miss is the opposite: an album with no article today may have one next
       year, and never asking again would mean never finding out. */
    db.prepare(`INSERT INTO info (kind, key, fetched_at, ok) VALUES ('album', 'a:gone', ?, 0)`)
      .run(Date.now() - MISS_TTL_MS - 1000);
    db.prepare(`INSERT INTO albums (id, dir, title, artist, added_at)
                VALUES ('a:gone', '', 'Nowhere', 'Nobody', 0)`).run();
    await later.album("a:gone");
    assert.ok(requests > 0, "a stale miss is asked again");
  } finally { ws.cleanup(); }
});

test("a miss inside the week is not asked again", async () => {
  const { ws, db } = await scanned();
  try {
    db.prepare(`INSERT INTO albums (id, dir, title, artist, added_at)
                VALUES ('a:x/Nowhere', '', 'Nowhere', 'Nobody', 0)`).run();
    let requests = 0;
    const info = createInfo({
      db, version: "9.9.9", apiRoot: API, gapMs: 0,
      fetchImpl: fakeWikipedia({ onCall: () => { requests++; } })
    });
    assert.strictEqual(await info.album("a:x/Nowhere"), null);
    const after = requests;
    assert.strictEqual(await info.album("a:x/Nowhere"), null);
    assert.strictEqual(requests, after, "a library of bootlegs asks once a week, not every open");
  } finally { ws.cleanup(); }
});

test("two taps while the first is in flight are one request", async () => {
  const { ws, db } = await scanned();
  try {
    let requests = 0;
    const info = createInfo({
      db, version: "9.9.9", apiRoot: API, gapMs: 0,
      fetchImpl: fakeWikipedia({ onCall: () => { requests++; } })
    });
    const id = albumId(db, "Hex");
    const [a, b] = await Promise.all([info.album(id), info.album(id)]);
    assert.deepStrictEqual(a, b);
    /* One search and one article fetch — not two of each. */
    assert.strictEqual(requests, 2, "the second tap joined the first request");
  } finally { ws.cleanup(); }
});

test("a network failure is not written down as an answer", async () => {
  /* A router rebooting is not Wikipedia saying it has never heard of the
     album, and recording it as one would mean waiting a week to ask again. */
  const { ws, db } = await scanned();
  try {
    const info = createInfo({
      db, version: "9.9.9", apiRoot: API, gapMs: 0,
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); }
    });
    assert.strictEqual(await info.album(albumId(db, "Hex")), null);
    const row = db.prepare("SELECT * FROM info").get();
    assert.strictEqual(row, undefined, "nothing was remembered");
  } finally { ws.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  Last.fm, for what Wikipedia has never heard of                     */
/* ------------------------------------------------------------------ */

test("Last.fm answers for a record Wikipedia does not have", async () => {
  const { ws, db } = await scanned();
  try {
    db.prepare(`INSERT INTO albums (id, dir, title, artist, added_at)
                VALUES ('a:x/Nowhere', '', 'Nowhere', 'Nobody', 0)`).run();
    const info = createInfo({
      db, version: "9.9.9", apiRoot: API, gapMs: 0,
      fetchImpl: fakeWikipedia(),
      lastfm: fakeLastfm({
        album: () => ({ album: {
          name: "Nowhere", artist: "Nobody", url: "https://www.last.fm/music/Nobody/Nowhere",
          wiki: { content: "A self-released cassette from 1994. <a href=\"x\">Read more on Last.fm</a>" }
        } })
      })
    });
    const found = await info.album("a:x/Nowhere");
    assert.ok(found, "the fallback answered");
    assert.strictEqual(found.source, "lastfm");
    assert.match(found.licence, /CC BY-SA/);
    assert.match(found.url, /^https:\/\/www\.last\.fm\//, "their terms want the link back");
    assert.strictEqual(found.summary, "A self-released cassette from 1994.",
      "their own Read more link is replaced by our credit, not passed through");
  } finally { ws.cleanup(); }
});

test("Last.fm's autocorrect cannot hand back a different act", async () => {
  /* autocorrect=1 is on, which is what turns Bjork into Björk — but it also
     means the answer may be about somebody else entirely. */
  const { ws, db } = await scanned();
  try {
    db.prepare(`INSERT INTO albums (id, dir, title, artist, added_at)
                VALUES ('a:x/Nowhere', '', 'Nowhere', 'Nobody', 0)`).run();
    const info = createInfo({
      db, version: "9.9.9", apiRoot: API, gapMs: 0,
      fetchImpl: fakeWikipedia(),
      lastfm: fakeLastfm({
        album: () => ({ album: {
          name: "Nowhere", artist: "Ride", url: "https://www.last.fm/x",
          wiki: { content: "The debut album by Ride." }
        } })
      })
    });
    assert.strictEqual(await info.album("a:x/Nowhere"), null,
      "a different artist is not an answer about this one");
  } finally { ws.cleanup(); }
});

test("Last.fm is not asked when Wikipedia has answered", async () => {
  const { ws, db } = await scanned();
  try {
    let asked = 0;
    const info = createInfo({
      db, version: "9.9.9", apiRoot: API, gapMs: 0,
      fetchImpl: fakeWikipedia(),
      lastfm: fakeLastfm({ album: () => { asked++; return {}; } })
    });
    assert.ok(await info.album(albumId(db, "Hex")));
    assert.strictEqual(asked, 0, "the second source is a fallback, not a supplement");
  } finally { ws.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  Switched off                                                       */
/* ------------------------------------------------------------------ */

test("INFO_LOOKUP=false means no request is ever made", async () => {
  const { ws, db } = await scanned();
  try {
    let asked = 0;
    const info = createInfo({
      db, version: "9.9.9", apiRoot: API, gapMs: 0, available: false,
      fetchImpl: fakeWikipedia({ onCall: () => { asked++; } })
    });
    assert.strictEqual(await info.album(albumId(db, "Hex")), null);
    assert.strictEqual(await info.artist("Bark Psychosis"), null);
    assert.strictEqual(asked, 0);
    assert.strictEqual(info.status().available, false);
  } finally { ws.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  Grouping is never touched                                          */
/* ------------------------------------------------------------------ */

test("nothing fetched is ever written back into the library", async () => {
  /* The rule this module is built around. A regroup MOVES play counts, so a
     website must never be allowed to cause one — and a title or artist taken
     from an article would be exactly the identification this project does not
     do. */
  const { ws, db } = await scanned();
  try {
    const before = db.prepare(
      "SELECT id, title, artist, version_of, title_edit, artist_edit FROM albums ORDER BY id").all();
    const info = build(db);
    await info.album(albumId(db, "Hex"));
    await info.artist("Bark Psychosis");
    const after = db.prepare(
      "SELECT id, title, artist, version_of, title_edit, artist_edit FROM albums ORDER BY id").all();
    assert.deepStrictEqual(after, before, "the albums table is untouched");
  } finally { ws.cleanup(); }
});

test("correcting an album's name throws its write-up away", async () => {
  /* The write-up was found by searching for the old name, so after a rename it
     is the answer to a question nobody is asking. */
  const { ws, db } = await scanned();
  try {
    const info = build(db);
    const id = albumId(db, "Hex");
    assert.ok(await info.album(id), "it was found under the tagged name");
    assert.ok(db.prepare("SELECT 1 FROM info WHERE kind='album' AND key=?").get(id));

    library.setNames(db, id, { title: "Hex", artist: "Bark Psychosis UK" });
    info.forget("album", id);
    assert.strictEqual(db.prepare("SELECT 1 FROM info WHERE kind='album' AND key=?").get(id),
      undefined, "the old answer is gone");
  } finally { ws.cleanup(); }
});

/* ------------------------------------------------------------------ */
/*  The small pure pieces                                              */
/* ------------------------------------------------------------------ */

test("a section stops at the next heading, whatever shape it is", () => {
  const equals = "Intro text.\n\n== Critical reception ==\n\nGood.\n\n== Personnel ==\n\nNames.";
  assert.strictEqual(section(equals, ["critical reception"]), "Good.");
  /* TextExtracts has rendered headings both ways over the years, and an album
     screen going quiet because of a formatting change is not a failure worth
     having. */
  const bare = "Intro text.\n\nCritical reception\n\nGood.\n\nTrack listing\n\n1. One";
  assert.strictEqual(section(bare, ["critical reception"]), "Good.");
  assert.strictEqual(section(equals, ["nothing like this"]), "");
});

test("a clamped extract stops at a sentence, not mid-word", () => {
  const text = "One sentence here. A second one follows it. And a third that runs on.";
  const cut = clamp(text, 40);
  assert.ok(cut.length <= 44, cut);
  assert.match(cut, /\. …$/, "cut at a full stop: " + cut);
});

test("an artist is matched through the app's own idea of identity", () => {
  assert.ok(namesArtist("An album by AC/DC, released in 1980.", "ACDC"));
  assert.ok(namesArtist("The fourth album by P!nk.", "Pink"));
  assert.ok(!namesArtist("An album by Ride, released in 1990.", "Slowdive"));
  /* A name that folds to one or two characters matches inside half of English,
     so the check abstains rather than passing everything. */
  assert.ok(!namesArtist("Anything at all.", "M"));
});

test("a disambiguation page is never an answer", () => {
  assert.ok(isDisambiguation({ pageprops: { disambiguation: "" }, extract: "" }));
  assert.ok(isDisambiguation({ extract: "Hex may refer to: several things." }));
  assert.ok(!isDisambiguation({ extract: "Hex is the debut album by Bark Psychosis." }));
});

test("Last.fm's own Read more link is stripped, and its entities decoded", () => {
  assert.strictEqual(
    stripHtml("Rock &amp; roll.<br/>More. <a href=\"x\">Read more on Last.fm</a>"),
    "Rock & roll.\nMore.");
});

test("the user agent names the app, its version and a contact", () => {
  const ua = userAgent("0.4.17");
  assert.match(ua, /MusicD-Server\/0\.4\.17/);
  assert.match(ua, /https:\/\/github\.com\/meltface-80\/MusicD-Server/);
});

test("a Wikipedia outage does not lock in a Last.fm answer for ever", async () => {
  /*
   * A hit is kept for good, so a minute of Wikipedia being down must not be
   * able to write a permanent second-choice answer over the better one nobody
   * was able to ask for. Last.fm is the fallback for Wikipedia ANSWERING with
   * nothing, not for Wikipedia failing.
   */
  const { ws, db } = await scanned();
  try {
    let askedLastfm = 0;
    const info = createInfo({
      db, version: "9.9.9", apiRoot: API, gapMs: 0,
      fetchImpl: async () => { throw new Error("ETIMEDOUT"); },
      lastfm: fakeLastfm({
        album: () => { askedLastfm++; return { album: {
          name: "Hex", artist: "Bark Psychosis", url: "https://www.last.fm/x",
          wiki: { content: "A thinner paragraph than the encyclopaedia has." }
        } }; }
      })
    });
    assert.strictEqual(await info.album(albumId(db, "Hex")), null);
    assert.strictEqual(askedLastfm, 0, "the fallback was not reached");
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM info").get().n, 0,
      "and nothing was written down, so the next open asks again");
  } finally { ws.cleanup(); }
});
