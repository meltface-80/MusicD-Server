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
                          "--ctl-radius", "--topbar-h", "--mini-h"]);
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

test("the Now playing face carries five transport controls", () => {
  const row = html.slice(html.indexOf('class="np-transport"'));
  const ids = [...row.slice(0, row.indexOf("</div>")).matchAll(/id="(np-[a-z]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(ids, ["np-shuffle", "np-prev", "np-playpause", "np-next", "np-repeat"]);
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

test("the artwork is full-bleed and fades into the controls", () => {
  /* The cover is the screen here, not a framed picture on it — so no radius,
     no shadow, and the bottom fades so the title sits in the tail of the image
     rather than under a hard edge. */
  const art = css.slice(css.indexOf(".np-art img {"));
  const block = art.slice(0, art.indexOf("}"));
  assert.match(block, /object-fit: cover/);
  assert.match(block, /border-radius: 0/);
  assert.match(block, /mask-image: linear-gradient/);
  assert.match(css, /\.np-art \{[^}]*margin: 0 -16px/s, "it cancels the panel gutter");
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
  assert.match(sharecard, /const YEAR_SIZE = 26;/);
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
  /* Bigger than the reference's 110px: this mark carries the waveform too. */
  const width = Number(/WORDMARK_W = (\d+)/.exec(sharecard)[1]);
  assert.ok(width >= 200, "the mark is drawn large — was " + width);
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
