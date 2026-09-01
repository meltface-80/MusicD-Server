"use strict";

/*
 * Static checks on the web app.
 *
 * There is no browser here, so nothing in this file pretends to test
 * behaviour. What it does test is the two ways this pair of files silently
 * breaks: an element id that app.js reaches for and index.html does not have
 * (which throws on the null, usually only on the screen nobody opened during
 * testing), and a <head> that iOS reads differently from the one that is known
 * to fill the display.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const PUBLIC = path.join(__dirname, "..", "public");
const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
const js = fs.readFileSync(path.join(PUBLIC, "app.js"), "utf8");
const css = fs.readFileSync(path.join(PUBLIC, "style.css"), "utf8");

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

/* Prose is not code. These files explain at length WHY something is absent, and
   a bare text search over the comments would flag every one of those
   explanations — the same trap the Apple-meta check below sidesteps by matching
   tags rather than words. Strip the commentary, search what actually ships. */
function stripComments(source, kind) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  if (kind === "html") out = out.replace(/<!--[\s\S]*?-->/g, " ");
  if (kind === "js") out = out.split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
  return out;
}

test("every id app.js reaches for exists in the markup", () => {
  const wanted = new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map(m => m[1]));
  const missing = [...wanted].filter(id => !htmlIds.has(id));
  assert.deepStrictEqual(missing, [], "app.js would get null for these");
});

test("no id is declared twice", () => {
  const all = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const seen = new Set(), dupes = new Set();
  for (const id of all) { if (seen.has(id)) dupes.add(id); seen.add(id); }
  assert.deepStrictEqual([...dupes], []);
});

test("every data-go target is a screen app.js knows how to open", () => {
  const targets = [...html.matchAll(/data-go="([^"]+)"/g)].map(m => m[1]);
  assert.ok(targets.length, "the side menu has entries");
  const rows = ["library", "random", "added", "played", "unplayed", "picks"];
  for (const target of targets) {
    const known = target === "home" || target === "artists" ||
                  (target.startsWith("row:") && rows.includes(target.slice(4)));
    assert.ok(known, `the menu offers "${target}" and nothing opens it`);
  }
});

test("the head carries exactly one viewport, set to cover the display", () => {
  const viewports = html.match(/name="viewport"/g) || [];
  assert.strictEqual(viewports.length, 1,
    "a second viewport meta silently overrides the first and zeroes every safe-area inset");
  assert.match(html, /content="[^"]*viewport-fit=cover/);
});

test("the legacy Apple web-app metas stay out of the head", () => {
  /* Matched as TAGS, not as words: the head carries a comment naming these
     three and explaining why they are absent, and a bare word-grep on that
     comment would cry wolf. A check that cries wolf gets ignored, which is
     how a real one gets waved through. */
  const tags = html.match(
    /<meta[^>]*name="(apple-mobile-web-app-capable|mobile-web-app-capable|apple-mobile-web-app-status-bar-style)"/g);
  assert.strictEqual(tags, null,
    "these stop the app filling an iPhone screen, and iOS bakes them into the " +
    "home-screen shortcut at install time — no later build can undo it");
});

test("no screen is saved or restored by reading innerHTML", () => {
  /* Re-parsing serialised markup builds fresh elements and silently drops every
     listener attached to the originals. Assignment is fine; reading is not. */
  const reads = [...js.matchAll(/\.innerHTML\s*(?!=[^=])/g)];
  const bad = reads.filter(m => !/\.innerHTML\s*=[^=]/.test(js.slice(m.index, m.index + 40)));
  assert.deepStrictEqual(bad.map(m => js.slice(m.index - 40, m.index + 20)), []);
});

test("every colour in the stylesheet is a token, not a literal", () => {
  /* Hex literals are allowed only inside the two palette blocks at the top,
     which is where a theme is defined. Anywhere below, a literal is a colour
     that will not follow the light theme. */
  const body = css.slice(css.indexOf("*, *::before"));
  const literals = [...body.matchAll(/:\s*(#[0-9a-fA-F]{3,8})\b/g)].map(m => m[1]);
  assert.deepStrictEqual(literals, [],
    "these would not change when the theme does");
});

test("the light theme redefines every token the dark one declares", () => {
  const tokensIn = (block) => new Set([...block.matchAll(/(--[a-z0-9-]+):/g)].map(m => m[1]));
  const dark = css.slice(css.indexOf(":root {"), css.indexOf('[data-theme="light"]'));
  const light = css.slice(css.indexOf('[data-theme="light"]'), css.indexOf("*, *::before"));

  /* Sizing tokens are deliberately shared; only the colours have to be paired. */
  const shared = new Set(["--font-sans", "--ctl-h", "--ctl-h-sm", "--tap-min",
                          "--ctl-radius", "--topbar-h", "--mini-h", "--np-pad-b",
                          "--ctl-h-lg"]);
  const missing = [...tokensIn(dark)].filter(t => !shared.has(t) && !tokensIn(light).has(t));
  assert.deepStrictEqual(missing, [], "these colours would stay dark in the light theme");
});

test("the six home rows are named the same in the client and the server", () => {
  const block = js.slice(js.indexOf("const ROW_TITLES = {"));
  const table = block.slice(0, block.indexOf("};"));
  const titles = Object.fromEntries(
    [...table.matchAll(/(\w+): "([^"]+)"/g)].map(m => [m[1], m[2]]));
  assert.strictEqual(titles.library, "Library");
  assert.strictEqual(titles.random, "Random albums");
  assert.strictEqual(titles.added, "Recently added");
  assert.strictEqual(titles.played, "Recently played");
  assert.strictEqual(titles.unplayed, "Not played in 6 months");
  assert.strictEqual(titles.picks, "Smart Picks");
});

test("nothing left over from MusicD Remote that this server does not do", () => {
  /* The features the brief removed. A stray handler for one of them is dead
     code at best and a broken button at worst. */
  const sources = [
    ["index.html", stripComments(html, "html")],
    ["app.js", stripComments(js, "js")],
    ["style.css", stripComments(css, "css")]
  ];
  for (const gone of ["qobuz", "tidal", "pitchfork", "discogs", "fanart",
                      "wall-display", "label-of-the-week"]) {
    for (const [name, source] of sources) {
      assert.ok(!new RegExp(gone, "i").test(source), `${gone} still appears in ${name}`);
    }
  }
});

/* ------------------------------------------------------------------ */
/*  Layout parity with MusicD Remote                                   */
/* ------------------------------------------------------------------ */

test("search puts artists above albums", () => {
  /* An artist match is a place to GO. Rendered under a grid of album covers it
     is the one tap that gets you their whole shelf, and the one you have to
     scroll to find. */
  const render = js.slice(js.indexOf("function renderSearch"));
  const body = render.slice(0, render.indexOf("\n}"));
  const artists = body.indexOf('"Artists"');
  const albums = body.indexOf('"Albums"');
  assert.ok(artists > -1 && albums > -1, "both sections are rendered");
  assert.ok(artists < albums, "the Artists section is built before the Albums one");
});

test("the Now playing face carries three transport controls, and no play modes", () => {
  /* Shuffle and repeat were removed on request: an album is listened to in the
     order it was sequenced, and the two controls that undo that were taking
     the outside positions in a row of three that does the actual work. */
  const row = html.slice(html.indexOf('class="np-transport"'));
  const ids = [...row.slice(0, row.indexOf("</div>")).matchAll(/id="(np-[a-z]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(ids, ["np-prev", "np-playpause", "np-next"]);
  /* And nothing left behind that would set one. The server still READS the
     mode — it is in the now-playing payload — so a mode set in the Sonos app
     survives rather than being silently corrected by a screen with no control
     for it. */
  const code = stripComments(js, "js");
  assert.ok(!/transport\("shuffle"\)|transport\("repeat"\)/.test(code),
    "nothing sends a play-mode command any more");
  assert.ok(!htmlIds.has("np-shuffle") && !htmlIds.has("np-repeat"),
    "and the buttons are gone from the markup");
});

test("Now playing and Queue are tabs of one screen, each with a pane", () => {
  const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(tabs, ["np", "queue"]);
  assert.ok(htmlIds.has("np-screen"), "the Now playing pane exists");
  assert.ok(htmlIds.has("queue-pane"), "the Queue pane exists");
  assert.ok(htmlIds.has("modal-tabs"));
});

test("the mini bar is play/pause, what is on, then room and volume", () => {
  const bar = html.slice(html.indexOf('id="mini"'), html.indexOf('id="album-modal"'));
  const ids = [...bar.matchAll(/id="(mt-[a-z]+)"/g)].map(m => m[1]);
  assert.ok(ids.includes("mt-playpause"), "play/pause is on the bar");
  assert.ok(ids.includes("mt-zone") && ids.includes("mt-vol"), "so are room and volume");
  /* Prev and next are deliberately NOT here: the reference bar has three
     controls, and skipping tracks belongs on the Now playing screen. */
  assert.ok(!ids.includes("mt-prev") && !ids.includes("mt-next"));
  assert.ok(bar.indexOf('id="mt-playpause"') < bar.indexOf('id="mt-open"'),
    "play/pause leads, ahead of the title");
});

/* ------------------------------------------------------------------ */
/*  Updating                                                           */
/* ------------------------------------------------------------------ */

test("the banner carries a button that starts the update", () => {
  /* Reporting a new version and leaving the user to go and run docker commands
     is what this stopped doing. */
  assert.ok(htmlIds.has("update-now"), "the banner has an Update now button");
  const banner = html.slice(html.indexOf('id="update-banner"'),
                            html.indexOf('id="status-banner"'));
  assert.ok(/<button[^>]*id="update-now"/.test(banner), "and it is on the banner");
  assert.match(js, /post\("\/api\/update\/apply"/, "which asks the server to install it");
});

test("an update finishes on the version changing, not on the server going away", () => {
  /* The obvious signal is the outage — the server restarts in the middle, so
     watch for a failed request. It is not a signal: a fast machine finishes
     inside one poll interval and no request ever fails, so a watch waiting for
     one waits for ever exactly where the update went best. */
  const body = /function watchUpdate\([\s\S]*?\n\}/.exec(js);
  assert.ok(body, "watchUpdate exists");
  const fn = body[0];

  assert.match(fn, /function watchUpdate\(runningVersion\)/,
    "it is told which version was running");
  assert.match(fn, /status\.current !== runningVersion/,
    "and finishes when a different one answers");

  /* The reload must not be reachable only from the failure path. */
  const catchBlock = /\} catch \{[\s\S]*?\n    \}/.exec(fn);
  assert.ok(catchBlock, "it handles the request failing");
  assert.ok(!/location\.replace/.test(catchBlock[0]),
    "a failed request does not itself mean the update finished");

  const start = /async function startUpdate\([\s\S]*?\n\}/.exec(js);
  assert.ok(start, "startUpdate exists");
  assert.match(start[0], /watchUpdate\(runningVersion\)/,
    "and hands the running version on to the watch");
});

test("the update endpoints are POSTs, so nothing can install by being linked to", () => {
  const index = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(index, /app\.post\("\/api\/update\/apply"/, "applying is a POST");
  assert.match(index, /app\.post\("\/api\/update\/check"/, "and so is re-checking");
  assert.match(index, /app\.get\("\/api\/update"/, "reading the status is a GET");
  assert.ok(!/app\.get\("\/api\/update\/apply"/.test(index),
    "there is no way to start an update with a GET");
});

test("a running update is joined rather than talked over", () => {
  /* A second phone, or a reload part-way through, must not be offered the
     update that is already installing. */
  assert.match(js, /resumeUpdateIfRunning/, "the page asks what is happening first");
  const boot = js.slice(js.indexOf("if (!state.checkedForUpdate)"));
  const block = boot.slice(0, boot.indexOf("\n    }"));
  assert.ok(block.indexOf("resumeUpdateIfRunning") < block.indexOf("showStaleShell"),
    "and that answer comes before the stale-page banner or a new offer");
});

/* ------------------------------------------------------------------ */
/*  Volume sheet                                                       */
/* ------------------------------------------------------------------ */

/* VOL_SHEETS is the one place the two sheets' ids are written down, so read it
   out of app.js rather than repeating it here. */
function volSheets() {
  const block = /const VOL_SHEETS = \[([\s\S]*?)\n\];/.exec(js);
  assert.ok(block, "app.js declares VOL_SHEETS");
  return [...block[1].matchAll(/\{([\s\S]*?)\}/g)].map(m =>
    [...m[1].matchAll(/(\w+):\s*"([^"]+)"/g)]
      .reduce((o, kv) => { o[kv[1]] = kv[2]; return o; }, {}));
}

test("both volume sheets name only ids the markup has", () => {
  /* The id check above reads $("literal") calls. These ids reach $ through a
     variable, so nothing else would notice a rename that missed one. */
  const sheets = volSheets();
  assert.strictEqual(sheets.length, 2, "one sheet per bar");
  for (const ids of sheets) {
    for (const [part, id] of Object.entries(ids)) {
      assert.ok(htmlIds.has(id), `${part} is "${id}", which the markup does not have`);
    }
  }
});

test("each bar's volume button opens that bar's own sheet", () => {
  /* The mini bar's speaker used to open Now playing and show ITS slider, which
     took you off the screen you were on to change the volume on it. */
  const [mini, np] = volSheets();
  assert.strictEqual(mini.button, "mt-vol");
  assert.strictEqual(mini.sheet, "mt-vol-sheet");
  assert.strictEqual(np.button, "np-volbtn");
  assert.strictEqual(np.sheet, "np-vol-sheet");
  const code = stripComments(js, "js");
  const from = code.indexOf("for (const ids of VOL_SHEETS)");
  assert.ok(from > -1, "the buttons are wired in one loop");
  const loop = code.slice(from, code.indexOf("\n  }", from));
  assert.ok(!/openNowPlaying|setFace|navOpen/.test(loop),
    "opening a volume sheet never navigates anywhere");
});

test("the volume sheets float, so opening one moves nothing", () => {
  /* In flow, the Now playing sheet pushed the screen up as it opened: that face
     never scrolls, so the artwork shrank to make room for it. */
  const sheet = /\.vol-sheet \{([\s\S]*?)\}/.exec(css);
  assert.ok(sheet, "there is one shared .vol-sheet");
  assert.match(sheet[1], /position:\s*fixed/, "it is taken out of the flow");
  for (const cls of [".mt-vol-sheet", ".np-vol-sheet"]) {
    assert.match(css, new RegExp("\\" + cls + " \\{[^}]*bottom:"),
      cls + " is anchored to the bar that opens it");
  }
});

test("both sheets carry the same controls, and both have a minus and a plus", () => {
  for (const ids of volSheets()) {
    const open = html.indexOf(`id="${ids.sheet}"`);
    assert.ok(open > -1);
    const sheet = html.slice(open, html.indexOf("</div>", html.indexOf(`id="${ids.plus}"`)));
    for (const part of ["value", "range", "minus", "plus"]) {
      assert.ok(sheet.includes(`id="${ids[part]}"`), `${ids.sheet} is missing its ${part}`);
    }
    assert.ok(sheet.includes("vol-scale"), `${ids.sheet} shows the ends of the scale`);
  }
});

test("one writer paints both sheets, so they cannot disagree", () => {
  /* They show the same speaker. A number written into one and not the other is
     a stale reading the next person to open that sheet would believe. */
  const body = /function syncVolume\([\s\S]*?\n\}/.exec(js);
  assert.ok(body, "syncVolume exists");
  assert.match(body[0], /for \(const ids of VOL_SHEETS\)/, "it writes every sheet");
  const writes = [...js.matchAll(/\$\("(mt|np)-vol-(value|range)"\)/g)];
  assert.deepStrictEqual(writes.map(m => m[0]), [],
    "nothing addresses one sheet's readout or slider by name");
});

test("the screen title gives way to the search field rather than sharing the row", () => {
  assert.match(css, /\.topbar-row\.searching \.screen-title \{ display: none; \}/);
  assert.match(js, /classList\.add\("searching"\)/);
});

/* ------------------------------------------------------------------ */
/*  Share card                                                         */
/* ------------------------------------------------------------------ */

const sharecard = fs.readFileSync(path.join(PUBLIC, "sharecard.js"), "utf8");

test("the share card renderer is loaded before the app that calls it", () => {
  const card = html.indexOf('src="/sharecard.js"');
  const app = html.indexOf('src="/app.js"');
  assert.ok(card > -1 && app > -1, "both scripts are on the page");
  assert.ok(card < app, "ShareCard has to exist by the time app.js runs");
});

test("the card is a fixed 1200x600, and says so once", () => {
  const { ShareCard } = require(path.join(PUBLIC, "sharecard.js"));
  assert.strictEqual(ShareCard.CARD_W, 1200);
  assert.strictEqual(ShareCard.CARD_H, 600);
  /* The frame in the panel holds that shape while the render is in flight, so
     the dialog does not jump when the image lands. */
  assert.match(css, /\.share-frame \{[^}]*aspect-ratio: 2 \/ 1/s);
});

test("a full release date is said in full, and anything less says the year", () => {
  const { ShareCard } = require(path.join(PUBLIC, "sharecard.js"));
  const line = (d, y) => ShareCard.releaseLine(d, y);

  assert.strictEqual(line("2025-09-23", 2025), "23rd September 2025");
  assert.strictEqual(line("1988-09-16", 1988), "16th September 1988");
  /* A month with no day is not a date. Saying it in full would mean inventing
     a day, so it falls back with the word in front — a bare number on its own
     line reads as part of the title. */
  assert.strictEqual(line("2025-09", 2025), "Released 2025");
  assert.strictEqual(line("2026", 2026), "Released 2026");
  assert.strictEqual(line("", 2026), "Released 2026");
  assert.strictEqual(line("", null), "", "and an album with no year says nothing");
  /* The date alone is enough — an album row is not required to have both. */
  assert.strictEqual(line("2019-04-01", null), "1st April 2019");
  assert.strictEqual(line("2019", null), "Released 2019");
});

test("the ordinal is right on the days that catch people out", () => {
  const { ShareCard } = require(path.join(PUBLIC, "sharecard.js"));
  const day = (n) => ShareCard.releaseLine(`2025-01-${String(n).padStart(2, "0")}`, 2025).split(" ")[0];
  assert.strictEqual(day(1), "1st");
  assert.strictEqual(day(2), "2nd");
  assert.strictEqual(day(3), "3rd");
  assert.strictEqual(day(4), "4th");
  assert.strictEqual(day(5), "5th", "and every plain day in between");
  /* The three a naive rule gets wrong: eleventh, twelfth, thirteenth. */
  assert.strictEqual(day(11), "11th");
  assert.strictEqual(day(12), "12th");
  assert.strictEqual(day(13), "13th");
  assert.strictEqual(day(21), "21st");
  assert.strictEqual(day(22), "22nd");
  assert.strictEqual(day(23), "23rd");
  assert.strictEqual(day(31), "31st");
});

test("the date line never outgrows the artist line under it", () => {
  /* A long artist name steps that line down. The date following it down is
     what keeps the two reading as a heading and its subject rather than the
     other way round. */
  const target = Number(/const DATE_SIZE = (\d+);/.exec(sharecard)[1]);
  const artistSizes = JSON.parse(/const ARTIST_SIZES = (\[[^\]]+\])/.exec(sharecard)[1]);
  assert.ok(target > 26, "it is bigger than the 26 it was — was " + target);
  assert.ok(target <= artistSizes[0],
    `${target} is larger than the artist line ever gets (${artistSizes[0]})`);
  assert.match(sharecard, /Math\.min\(DATE_SIZE, artist\.size\)/,
    "and it is capped at the size the artist line actually chose");
});

test("the share overlay has every part the controller writes into", () => {
  for (const id of ["share-overlay", "share-frame", "share-actions", "share-hint", "share-err"]) {
    assert.ok(htmlIds.has(id), id + " is in the markup");
  }
  assert.ok(htmlIds.has("modal-share"), "and the button that opens it");
});

test("the card is drawn from the album row alone", () => {
  /* No lookup, no review, no label — the same rule the rest of the app
     follows, and what lets the card be drawn with the network down. */
  const render = sharecard.slice(sharecard.indexOf("async function render"));
  for (const field of ["data.coverUrl", "data.title", "data.artist", "data.year"]) {
    assert.ok(render.includes(field), field + " is used");
  }
  /* The track count and length were dropped: a share card says what the record
     IS, and how long it runs is a detail for the album screen. */
  assert.ok(!sharecard.includes("data.meta"), "no length line");
  assert.ok(!/fetch\(/.test(sharecard), "the renderer makes no requests of its own");
});

test("share actions are offered only where the browser can perform them", () => {
  /* navigator.share with files and ClipboardItem are both patchy; a button
     that throws when tapped is worse than one that was never drawn. */
  assert.match(js, /navigator\.canShare\(\{ files:/);
  assert.match(js, /typeof window\.ClipboardItem !== "undefined"/);
  assert.match(js, /download\.download = fileName/, "Download is always available");
});

/* ------------------------------------------------------------------ */
/*  Navigation                                                         */
/* ------------------------------------------------------------------ */

test("Back is one path: nothing closes itself", () => {
  /* Every layer is closed by the popstate handler, so the phone's Back gesture
     and the on-screen control cannot drift apart. */
  assert.match(js, /window\.addEventListener\("popstate"/);
  assert.match(js, /function navOpen\(name, close\)/);
  assert.match(js, /function navBack\(\)/);
  assert.match(js, /history\.pushState\(\{ musicdDepth: nav\.length \}/);
});

test("popstate unwinds to the depth it was given, not one layer per event", () => {
  /* A held Back, or a jump of several entries, arrives as ONE popstate. */
  const handler = js.slice(js.indexOf('addEventListener("popstate"'));
  assert.match(handler.slice(0, 600), /while \(nav\.length > depth\)/);
});

test("every overlay registers itself with the navigation stack", () => {
  for (const layer of ['navOpen("modal"', 'navOpen("sheet"', 'navOpen("share"', 'navOpen("view"']) {
    assert.ok(js.includes(layer), layer + ") is on the stack");
  }
});

test("Home unwinds the whole stack rather than stepping back one screen", () => {
  assert.match(js, /function navReset\(\)/);
  assert.match(js, /history\.go\(-nav\.length\)/);
  assert.match(js, /\$\("modal-home"\)\.addEventListener\("click", navReset\)/);
});

/* ------------------------------------------------------------------ */
/*  Versions and updating                                              */
/* ------------------------------------------------------------------ */

/* The comparison is pulled out of the shipped file and run, rather than
   re-implemented here — a copy in the test would pass while the real one was
   wrong. */
function loadIsNewer() {
  const start = js.indexOf("function isNewer(");
  assert.ok(start > -1, "isNewer is in app.js");
  const end = js.indexOf("\n}", start) + 2;
  // eslint-disable-next-line no-new-func
  return new Function(js.slice(start, end) + "\nreturn isNewer;")();
}

test("a newer version is compared numerically, not as text", () => {
  const isNewer = loadIsNewer();
  assert.strictEqual(isNewer("0.3.0", "0.2.0"), true);
  assert.strictEqual(isNewer("0.2.0", "0.2.0"), false, "the same version is not an update");
  assert.strictEqual(isNewer("0.1.9", "0.2.0"), false, "nor is an older one");
  /* The one a string comparison gets backwards. */
  assert.strictEqual(isNewer("0.10.0", "0.9.0"), true, "0.10 is newer than 0.9");
  assert.strictEqual(isNewer("0.9.0", "0.10.0"), false);
  assert.strictEqual(isNewer("1.0.0", "0.99.99"), true);
  assert.strictEqual(isNewer("v0.3.0", "0.2.0"), true, "a leading v is tolerated");
  assert.strictEqual(isNewer("", "0.2.0"), false, "and nonsense is never an update");
});

test("the update check runs in the browser and never blocks the app", () => {
  /* The server has no business reaching the internet on its own, and the app
     has to work with GitHub unreachable. */
  assert.ok(!/api\.github\.com/.test(fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")),
    "the server makes no call to GitHub");
  const check = js.slice(js.indexOf("async function checkForUpdate"));
  assert.match(check.slice(0, 1400), /api\.github\.com/);
  assert.match(check.slice(0, 1600), /catch \{/, "a failed check is silent");
});

test("the running build is identifiable from the menu", () => {
  assert.ok(htmlIds.has("version-sub"), "the menu has a version line");
  assert.match(js, /function describeBuild\(build\)/);
  assert.match(js, /build\.commit/);
  assert.match(js, /build\.date/);
});

test("the version is the same everywhere it is written down", () => {
  const version = require("../package.json").version;
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const site = fs.readFileSync(path.join(__dirname, "..", "docs", "index.html"), "utf8");
  const changelog = fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8");

  assert.match(site, new RegExp('FALLBACK_VERSION = "' + version.replace(/\./g, "\\.") + '"'),
    "the install site names this version");
  assert.ok(changelog.includes("\n## " + version + "\n"),
    "the changelog has a section for it — the release notes are cut from there");
  assert.ok(readme.includes(":" + version + "`"),
    "the README's tag table names it");
});

test("every documented run command pulls", () => {
  /* `docker run` reuses a cached tag without asking the registry, so a command
     without this reads as an update and ships nothing. */
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const compose = fs.readFileSync(path.join(__dirname, "..", "docker-compose.yml"), "utf8");
  const site = fs.readFileSync(path.join(__dirname, "..", "docs", "index.html"), "utf8");

  for (const block of readme.match(/```bash\n[\s\S]*?```/g) || []) {
    if (!/docker run/.test(block) || !/ghcr\.io/.test(block)) continue;
    assert.match(block, /--pull always/, "a README run command that pulls the image");
  }
  assert.match(compose, /pull_policy: always/);
  assert.match(site, /--pull always/, "and the command the install site builds");
});

test("a page older than the server announces itself", () => {
  /* The one state no cache header can fix after the fact: a shell stored under
     the old rules will not revalidate until its lifetime runs out. */
  assert.match(js, /const SHELL_VERSION =/);
  assert.match(js, /function showStaleShell\(serverVersion\)/);
  assert.match(js, /SHELL_VERSION !== status\.version/);
  /* The reload has to be a URL the cache has never seen — location.reload()
     can itself be answered from the entry that is the problem. */
  assert.match(js, /location\.pathname \+ "\?r=" \+ Date\.now\(\)/);
});

/* ------------------------------------------------------------------ */
/*  The Now playing layout contract                                    */
/* ------------------------------------------------------------------ */

test("Now playing never scrolls — the artwork absorbs the leftover height", () => {
  /* This is the whole layout. Everything else takes its natural height and the
     art takes what is left, which is why a tall phone has no dead space at the
     bottom and a short one has no clipped controls. A fixed art size cannot do
     both: it leaves a gap on one and overflows the other, which is exactly what
     `width: min(300px, 66vw)` did. */
  assert.match(css, /\.modal\.face-np \.modal-panel \{[^}]*overflow: hidden/s);
  assert.match(css, /\.np-art \{[^}]*flex: 1 1 0;\s*min-height: 0;/s);
  assert.ok(!/\.np-art \{[^}]*width: min\(/s.test(css),
    "the art has no fixed size to fight the available height");
});

test("Now playing shows the whole cover, never a cropped one", () => {
  /* It used to fill the box and crop, full-bleed to both screen edges. That
     cost the sides of every square sleeve on a tall phone — and a sleeve is a
     designed object, so the half that got cut was usually the half with the
     artist's name on it. */
  const art = css.slice(css.indexOf(".np-art img {"));
  const block = art.slice(0, art.indexOf("}"));
  assert.match(block, /object-fit: contain/, "the cover fits rather than fills");
  assert.ok(!/object-fit: cover/.test(block), "nothing crops it");
  /* The element fills the box and the picture fits inside it, which is right
     for every shape a sleeve comes in and also GROWS a small file to the
     screen — sizing the element itself would hug the art exactly but can only
     ever shrink an image. */
  assert.match(block, /width: 100%; height: 100%/, "it fills, and contain fits");
  assert.match(block, /mask-image: none/, "and the fade goes with the crop it hid");
  /* Nothing for a frame to hug: the box is not the picture's shape, so a
     radius or a shadow would outline the box and float in the empty band. */
  assert.match(block, /border-radius: 0/);
  assert.match(block, /box-shadow: none/);
  assert.ok(!/\.np-art \{[^}]*margin: 0 -16px/s.test(css), "and the bleed goes too");
});

test("the panel's top bar reaches the top, and nothing scrolls above it", () => {
  /* A sticky element cannot rise above its containing block's content box. While
     the panel held the safe-area inset as padding, the head stuck BELOW it and
     left a band at the top of the screen with nothing in front of it — the
     artwork scrolled past in full view up there. The inset belongs to the head. */
  const head = css.slice(css.indexOf(".modal-head {"));
  const block = head.slice(0, head.indexOf("}"));
  assert.match(block, /position: sticky; top: 0/);
  assert.match(block, /padding: calc\(env\(safe-area-inset-top\)/,
    "the head carries the inset");
  const panel = css.slice(css.indexOf(".modal-panel {"));
  const panelBlock = panel.slice(0, panel.indexOf("}"));
  assert.ok(!/padding: calc\(env\(safe-area-inset-top\)/.test(panelBlock),
    "and the panel no longer does");
  /* Full width, or the cover shows down either side of it. */
  assert.match(block, /margin: 0 -16px/);
});

test("the panel's top bar is translucent, like the app's own", () => {
  /* Over an unscrolled screen --bg-veil composites to exactly --bg and there is
     no step; once the screen moves, the cover passing underneath tints it
     rather than vanishing under a hard edge. */
  const head = css.slice(css.indexOf(".modal-head {"));
  const block = head.slice(0, head.indexOf("}"));
  assert.match(block, /background: var\(--bg-veil\)/);
  assert.ok(!/background: var\(--bg\)/.test(block), "not the opaque ground");
});

test("the panel knows which face it is showing", () => {
  /* Now playing is a different SHAPE, not just different contents, and only
     CSS can express that. */
  assert.match(js, /classList\.toggle\("face-np", face === "np"\)/);
  assert.match(js, /classList\.toggle\("face-queue", face === "queue"\)/);
  assert.match(js, /classList\.toggle\("face-album", face === "album"\)/);
});

test("a short window scrolls rather than putting the transport out of reach", () => {
  assert.match(css, /@media \(max-height: 520px\) \{[^@]*\.modal\.face-np \.modal-panel \{ overflow-y: auto/s);
});

test("Now playing is a screen at every width, never a floating dialog", () => {
  /* At >=720px the panel is otherwise a centred auto-height box, which gives
     height-driven artwork nothing to size against — it collapses to nothing
     and takes the view with it. */
  assert.match(css, /@media \(min-width: 720px\) \{\s*\.modal\.face-np \.modal-panel \{[^}]*height: 100%/s);
});


test("the card's type is MusicD Remote's, not a second scale", () => {
  /* Sizes and spacing lifted from the reference so a card from either app is
     recognisably the same object. */
  assert.match(sharecard, /const TITLE_SIZES = \[56, 48, 42, 36, 31, 27\];/);
  assert.match(sharecard, /const ARTIST_SIZES = \[37, 32, 28, 24, 21\];/);
  assert.match(sharecard, /const TITLE_LH = 68 \/ 56;/);
  assert.match(sharecard, /const ARTIST_LH = 48 \/ 37;/);
  assert.match(sharecard, /const BLOCK_GAP = 18;/);
  /* Both step down TOGETHER, so their relative scale holds. */
  assert.match(sharecard, /TITLE_SIZES\[step\]/, "the title steps");
  assert.match(sharecard, /ARTIST_SIZES\[Math\.min\(step, ARTIST_SIZES\.length - 1\)\]/,
    "and the artist steps with it");
});

test("the wordmark is the real mark, drawn from the traced SVG", () => {
  const svg = fs.readFileSync(path.join(PUBLIC, "icons", "wordmark.svg"), "utf8");
  assert.match(svg, /<svg[^>]*viewBox="0 0 \d+ \d+"/, "it is a vector, not a wrapped bitmap");
  assert.ok(!/<image\b/.test(svg), "no raster smuggled inside");
  /* A presentation attribute, the lowest-priority way to colour it: white for
     the canvas, where there is no CSS context and currentColor would come out
     black, and overridable by any CSS rule when the mark is inlined. */
  assert.match(svg, /<path fill="#ffffff"/, "white by default");
  assert.ok(!/<rect[^>]*fill="#0|background/.test(svg), "and carries no background of its own");
  assert.match(sharecard, /WORDMARK_URL = "\/icons\/wordmark\.svg"/);
  /* Still larger than the reference's 110px — this mark carries the waveform
     too — but a third smaller than it first shipped at, where it dominated the
     card it was supposed to sign. */
  const width = Number(/WORDMARK_W = (\d+)/.exec(sharecard)[1]);
  assert.ok(width > 110 && width < 200, "the mark signs the card — was " + width);
});

test("the text knows the wordmark is under it", () => {
  /* The mark sits at the bottom of the same column as the text. Fitting on
     width alone was enough while it was small; at its real size a long title
     ran straight through it. */
  const render = sharecard.slice(sharecard.indexOf("async function render"));
  assert.match(render, /const availH = PANE_H - PANE_PAD \* 2 - \(markH \? markH \+ 16 : 0\)/);
  assert.match(render, /if \(blockH <= availH\) break;/,
    "type steps down until the block fits the height it actually has");
});

/* ------------------------------------------------------------------ */
/*  Keeping an installed app up to date                                */
/* ------------------------------------------------------------------ */

const sw = fs.readFileSync(path.join(PUBLIC, "sw.js"), "utf8");

test("the service worker never serves the shell from cache while online", () => {
  /* The opposite of the usual strategy, and deliberately so: this exists
     because an installed app would not update, not to make a LAN round trip
     faster. `cache: "reload"` bypasses the HTTP cache under the worker too. */
  assert.match(sw, /cache: "reload"/);
  assert.match(sw, /self\.skipWaiting\(\)/, "a new worker takes over at once");
  assert.match(sw, /self\.clients\.claim\(\)/);
  assert.match(sw, /caches\.delete\(name\)/, "and old caches go");
});

test("the worker leaves art, audio and the API alone", () => {
  /* Audio is fetched by the SPEAKER, not this browser, and art is already
     cached properly by its headers. Either one in here would fill a phone up
     for nothing. */
  assert.match(sw, /const SHELL = \[/);
  const shell = /const SHELL = \[([^\]]+)\]/.exec(sw)[1];
  assert.ok(!shell.includes("/stream"), "no audio");
  assert.ok(!shell.includes("/api"), "no API");
  assert.ok(shell.includes("/icons/wordmark.svg"), "the mark is cached, so a card works offline");
  assert.match(sw, /if \(!navigation && !isShell\(url\)\) return;/);
});

test("the worker is registered from script, never from a head tag", () => {
  /* iOS reads <head> at add-to-home-screen time and bakes the result into the
     shortcut. A registration call runs after layout and changes nothing about
     how the window is sized. */
  assert.ok(!/rel="manifest"/.test(html), "no manifest link");
  assert.match(js, /navigator\.serviceWorker\.register\("\/sw\.js"\)/);
  assert.match(js, /"controllerchange"/, "and the page reloads when one takes over");
  assert.match(js, /if \(reloading\) return;/, "once — a reload loop is worse than a stale page");
});

test("the worker carries the version, so a browser can see it changed", () => {
  assert.match(sw, /const VERSION = "__BUILD_VERSION__"/);
  const server = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(server, /replace\("__BUILD_VERSION__", BUILD\.version\)/);
  assert.match(server, /Cache-Control", "no-cache"/);
});

/* ------------------------------------------------------------------ */
/*  The top bar, and where the room picker lives                       */
/* ------------------------------------------------------------------ */

test("the top bar is the menu and the search, and nothing else", () => {
  const row = html.slice(html.indexOf('class="topbar-row"'), html.indexOf('id="scan-progress-bar"'));
  const buttons = [...row.matchAll(/<button id="([^"]+)"/g)].map(m => m[1]);
  /* topbar-back is hidden on Home and appears on the screens below it. */
  assert.deepStrictEqual(buttons, ["menu-toggle", "topbar-back", "search-open", "search-clear"]);
  assert.ok(!row.includes("zone-btn"), "the room picker has left the corner");
});

test("Home does not name itself in the bar", () => {
  assert.match(html, /<h1 id="screen-title" class="screen-title"><\/h1>/);
  assert.match(js, /showView\("home", ""\)/);
  assert.ok(!/textContent = title \|\| "MusicD"/.test(js));
});

test("the mini bar is always on screen, because it is the only room picker", () => {
  /* Hiding it when nothing is playing would leave a fresh install with nowhere
     to choose a speaker from, now that the top bar has no button for it. */
  const sync = js.slice(js.indexOf("function syncMini()"));
  const body = sync.slice(0, sync.indexOf("\n}"));
  assert.match(body, /classList\.toggle\("hidden", onNpFace\)/);
  assert.ok(!/!playing/.test(body), "playing state no longer decides whether the bar exists");
  /* And it says something useful when idle. */
  assert.match(js, /"Nothing playing" : "Choose a room"/);
});

test("the side menu carries the real mark", () => {
  assert.match(html, /<img class="menu-brand" src="\/icons\/wordmark\.svg"/);
  assert.match(css, /\.menu-brand \{[^}]*height: 26px/s, "sized to the header, not redrawn");
  /* The mark paints itself white and carries no colour to flip, so the light
     theme has to invert it. */
  assert.match(css, /\[data-theme="light"\] \.menu-brand \{ filter: invert\(1\); \}/);
});

/* ------------------------------------------------------------------ */
/*  Fixes with a measurement behind them                               */
/* ------------------------------------------------------------------ */

test("the panel header places each control in its own column", () => {
  /* Auto-placement put the right-hand control in the middle column on the album
     face, where Home and the tabs are display:none and take no cell — so it
     landed next to Back instead of in the far corner. */
  assert.match(css, /\.modal-head > #modal-share,\s*\n\.modal-head > #modal-fave \{ grid-column: 3; grid-row: 1; justify-self: end; \}/);
  assert.match(css, /\.modal-head > #modal-back,\s*\n\.modal-head > #modal-home \{ grid-column: 1/);
  assert.match(css, /\.modal-head > \.modal-tabs \{ grid-column: 2/);
});

test("an artist link waits for the panel to close before it navigates", () => {
  /* The panel closes through the navigation stack, which runs on popstate:
     history.back() returns immediately and the layer is not gone until the
     browser gets round to it. Closing and navigating in the same tick loses
     that race every time — the artist screen paints, then the late pop unwinds
     the layer under it and lands on Home. */
  const open = js.slice(js.indexOf("function openArtist("));
  const body = open.slice(0, open.indexOf("\n}"));
  assert.match(body, /state\.afterModal/, "it hands the navigation to the close");
  assert.ok(!/showView\(/.test(body), "and does not navigate itself while the panel is up");

  const hide = js.slice(js.indexOf("function hideModal("));
  const hideBody = hide.slice(0, hide.indexOf("\n}"));
  assert.match(hideBody, /state\.afterModal = null/, "and the close runs it exactly once");
});

test("the artist screen separates their records from their appearances", () => {
  /* Two sections answer two questions — what did they make, and where else
     will I hear them. An empty heading is worse than no heading. */
  assert.match(js, /\["Appears on", data\.appearsOn/, "the second list is read");
  assert.match(js, /filter\(\(\[, albums\]\) => albums\.length\)/,
    "and a section with nothing in it is dropped");
  /* The grid is a CSS grid whose children are cards, so a stack of headed
     grids needs its own layout or each section becomes one cell. */
  assert.match(css, /\.album-grid\.is-sectioned \{ display: block; \}/);
  assert.match(css, /\.album-grid\.is-sectioned \.album-grid-inner \{[^}]*grid-template-columns: inherit/s,
    "the sections inherit the columns rather than restating the breakpoints");
});

test("artist names split on what a tag list uses, and nothing else", () => {
  const body = /function splitArtists\([\s\S]*?\n\}/.exec(js);
  assert.ok(body, "splitArtists exists");
  // eslint-disable-next-line no-new-func
  const split = new Function("return " + body[0] + "; splitArtists")();

  assert.deepStrictEqual(split("David Bowie; Queen"), ["David Bowie", "Queen"]);
  assert.deepStrictEqual(split("A / B"), ["A", "B"], "a slash with space around it");
  /* And NOT on these. Splitting an ampersand or a comma turns real acts into
     artists who have never recorded anything. */
  assert.deepStrictEqual(split("Simon & Garfunkel"), ["Simon & Garfunkel"]);
  assert.deepStrictEqual(split("Earth, Wind & Fire"), ["Earth, Wind & Fire"]);
  assert.deepStrictEqual(split("Crosby, Stills, Nash & Young"), ["Crosby, Stills, Nash & Young"]);
  assert.deepStrictEqual(split("AC/DC"), ["AC/DC"], "no space, no split");
  assert.deepStrictEqual(split(""), []);
  assert.deepStrictEqual(split(null), []);
});

test("the corner is the heart on an album and the share card on Now playing", () => {
  /* Both live in the same cell, so exactly one of them shows at a time and
     which one follows the face. */
  assert.ok(htmlIds.has("modal-fave") && htmlIds.has("modal-share"));
  const face = js.slice(js.indexOf("function setFace("));
  const body = face.slice(0, face.indexOf("\n}"));
  assert.match(body, /\$\("modal-fave"\)\.classList\.toggle\("hidden", onNp\)/);
  assert.match(body, /\$\("modal-share"\)\.classList\.toggle\("hidden", !onNp\)/);
});

test("the heart is hollow until it is one", () => {
  /* Stroked with no fill by default; the fill and the colour both arrive with
     .is-on, so an unmarked album never shows a filled shape. */
  const button = html.slice(html.indexOf('id="modal-fave"'));
  const markup = button.slice(0, button.indexOf("</button>"));
  assert.match(markup, /fill="none"/, "hollow by default");
  assert.match(markup, /stroke="currentColor"/);
  assert.match(css, /#modal-fave\.is-on svg \{ fill: var\(--fave\); \}/, "filled when marked");
  assert.match(css, /#modal-fave\.is-on \{ color: var\(--fave\); \}/, "and red");
});

test("the Play and Queue buttons are one control in two halves", () => {
  /* "Play" is shorter than "Queue", so padding alone made the primary action
     the smaller button. */
  const block = css.slice(css.indexOf(".action-btn {"));
  const body = block.slice(0, block.indexOf("}"));
  assert.match(body, /min-width: \d+px/, "they are the same width whatever is on them");
  assert.match(body, /min-height: var\(--ctl-h-lg\)/, "and taller than the ordinary control");
});

test("a track row has the same inset on both sides", () => {
  /* Right-aligning the number inside a fixed box pushed every single digit
     about twenty pixels in, and the list read as though the left margin were
     wider than the right. */
  assert.match(css, /\.track-list li \{[^}]*padding: 10px 0;/s);
  assert.match(css, /\.t-no \{[^}]*text-align: left;/s);
  assert.match(css, /\.t-no \{[^}]*font-variant-numeric: tabular-nums/s,
    "figures still line the titles up");
});

test("the progress bar runs on a clock, not on the poll", () => {
  /* Painting position only when the speaker answers made the bar sit still and
     then jump — a visual stutter over perfectly smooth playback. */
  assert.match(js, /function paintProgress\(\)/);
  assert.match(js, /function startProgressTicker\(\)/);
  assert.match(js, /\(Date\.now\(\) - state\.positionAt\) \/ 1000/);
  assert.match(js, /state\.positionAt = Date\.now\(\)/, "and each poll re-anchors it");
  assert.match(js, /if \(state\.seeking\) return;/, "never while a finger is on the bar");
});

test("the update check can be run on demand", () => {
  assert.ok(htmlIds.has("menu-update"), "there is a menu entry for it");
  assert.match(js, /checkForUpdate\(state\.build, \{ manual: true \}\)/);
  /* Asking for the check is asking to see the answer, whatever it is. */
  assert.match(js, /You are on the latest version/);
  assert.match(js, /if \(!manual && dismissed === latest\) return;/,
    "a dismissal only silences the automatic check");
  assert.match(js, /Could not check for updates/, "and a failed check says so");
});
