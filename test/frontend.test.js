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
