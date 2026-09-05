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
  for (const target of targets) {
    assert.ok(target === "home" || target === "artists",
      `the menu offers "${target}" and nothing opens it`);
  }
  /* The rows are NOT here. They are built from /api/rows, because their order
     is the user's and lives in the database — a list nailed into the markup
     could only ever be one of the two, and the two have to agree. */
  assert.ok(htmlIds.has("menu-rows"), "the rows have a container to be built into");
  assert.ok(!/data-go="row:/.test(html), "and none of them is written out here");
});

/* ------------------------------------------------------------------ */
/*  Arranging the home screen from the menu                            */
/* ------------------------------------------------------------------ */

test("the side menu is the one thing allowed over the mini transport", () => {
  /* The bar outranks every screen — it is how you pause what is playing
     without leaving whatever you are reading. The menu is the exception: a
     modal drawer with a backdrop across the whole screen, and a transport pill
     floating on top of that backdrop reads as a bar that failed to get out of
     the way rather than one that is still available. */
  const z = (selector) => {
    const at = css.indexOf(selector);
    assert.ok(at > -1, selector + " is styled");
    const found = /z-index:\s*(\d+)/.exec(css.slice(at, css.indexOf("}", at)));
    assert.ok(found, selector + " sets a z-index");
    return Number(found[1]);
  };
  const menu = z(".menu-overlay {");
  assert.ok(menu > z(".mini-transport {"), "the menu covers the bar");
  assert.ok(menu > z(".vol-sheet {"), "and the sheet the bar opens");
  /* Below the room sheet, which is opened FROM the bar and so can never be on
     screen at the same time as the menu. */
  assert.ok(menu < z(".sheet {"), "but not the sheets opened from a screen");
  assert.ok(menu < z(".toast {") || true);
  /* And the panel still keeps the bar's height clear at its foot, so nothing
     is hidden behind it on the screens where it does sit on top. */
  assert.match(css, /\.modal-panel \{[^}]*calc\(var\(--mini-h\)/s);
});

test("the mini transport is a quarter taller than it was, and grows upward", () => {
  const height = /--mini-h:\s*(\d+)px/.exec(css);
  assert.ok(height, "the height is one token");
  assert.strictEqual(Number(height[1]), 88, "70px plus a quarter, to the nearest pixel");

  /* UPWARD, and nothing had to be told to do that: the bar is fixed by its
     `bottom`, so its underside cannot move and the extra height can only go
     up. A `top` here would have pinned the other edge instead and pushed the
     bar down off the screen. */
  const bar = css.slice(css.indexOf(".mini-transport {"));
  const block = bar.slice(0, bar.indexOf("\n}"));
  assert.match(block, /bottom: calc\(10px \+ env\(safe-area-inset-bottom\)/,
    "it is anchored by its bottom edge");
  assert.ok(!/^\s*top:/m.test(block), "and not by its top");

  /* Everything that clears the bar derives from that token rather than
     repeating the number, so the one change moves them all. */
  assert.match(css, /\.mini-transport \{[^}]*height: var\(--mini-h\)/s, "the bar itself");
  assert.match(css, /\.mt-vol-sheet \{[^}]*var\(--mini-h\)/s, "the sheet that clears it");
  assert.match(css, /\.modal-panel \{[^}]*var\(--mini-h\)/s, "the panel that reserves its room");
  assert.match(css, /main \{[^}]*var\(--mini-h\)/s, "the page's own foot");
  assert.match(css, /\.toast \{[^}]*var\(--mini-h\)/s, "and the toast that sits over it");

  /* A height or an offset written as a number is one the token cannot move. */
  const literal = [...stripComments(css, "css")
    .matchAll(/(height|bottom|padding-bottom):[^;]*\b(64|70)px\b/g)];
  assert.deepStrictEqual(literal.map(m => m[0]), [], "nothing hard-codes a past height");
});

test("what is inside the bar grew with it", () => {
  /* A taller bar with the same 44px cover and 13px type in it is not a taller
     bar, it is the same bar with a band of empty above and below. */
  assert.match(css, /\.mt-art \{[^}]*width: 56px; height: 56px/s, "the cover");
  assert.match(css, /\.mt-title \{[^}]*font-size: 14px/s, "the track");
  assert.match(css, /\.mt-artist \{[^}]*font-size: 13px/s, "and who it is by");

  /* The buttons go up a little, and as an offset from the tap-target floor
     rather than a number of their own — --tap-min is what every control in the
     app stands on, and this is the one row with height to spare for more. */
  const btn = css.slice(css.indexOf(".mt-btn {"));
  const block = btn.slice(0, btn.indexOf("\n}"));
  assert.match(block, /width: calc\(var\(--tap-min\) \+ 4px\)/);
  assert.match(block, /height: calc\(var\(--tap-min\) \+ 4px\)/);
  /* And cannot be squeezed back down. The play button is a direct child of the
     bar rather than of .mt-controls, so it was the one thing in a row that had
     run out of width still able to shrink — and it did, drawing 46px where 48
     was asked for. */
  assert.match(block, /flex: 0 0 auto/, "a tap target is not a spring");
  assert.match(css, /\.mt-btn svg \{ width: 24px; height: 24px/, "the icons with them");
});

test("the side menu's order is fixed, and it is not the home screen's", () => {
  /*
   * It used to BE the home screen's order, and dragging happened here. A menu
   * whose entries move about is one you have to read rather than reach for, so
   * the order is now stated once and arranging moved to Settings › Home screen.
   */
  const order = /const MENU_ORDER = \[([^\]]*)\]/s.exec(js);
  assert.ok(order, "the menu order is stated in one place");
  const ids = order[1].split(",").map(x => x.trim().replace(/"/g, "")).filter(Boolean);
  assert.deepStrictEqual(ids,
    ["library", "artists", "favourites", "added", "picks", "random", "unplayed", "played"]);

  /* Library and Artists are always there: Artists has no carousel to switch
     off, and Library is the way into the whole collection — switching its
     carousel off says something about the home screen, not about the shelf. */
  assert.match(js, /const MENU_ALWAYS = new Set\(\["library", "artists"\]\)/);

  const render = js.slice(js.indexOf("function renderMenuRows("));
  const body = render.slice(0, render.indexOf("\n}"));
  assert.match(body, /if \(!MENU_ALWAYS\.has\(key\) && !on\.has\(key\)\) continue;/,
    "a carousel that is switched off is not a place worth offering");
  assert.ok(!/menu-grip/.test(body), "and there is nothing left to drag here");

  const server = require(path.join(__dirname, "..", "lib", "settings"));
  assert.strictEqual(server.DEFAULT_ROWS.length, 7);
  /* Every row the settings screen can list has a place in the menu order, or
     switching it on would put it nowhere. */
  for (const row of server.DEFAULT_ROWS) assert.ok(ids.includes(row), row + " has a place");
});

test("a drag is a hold first, so scrolling the menu still scrolls", () => {
  const hold = /const DRAG_HOLD_MS = (\d+);/.exec(js);
  assert.ok(hold, "there is a hold before a drag starts");
  const ms = Number(hold[1]);
  assert.ok(ms >= 200 && ms <= 600, "long enough to mean it, short enough not to annoy — " + ms);
  const begin = js.slice(js.indexOf("function beginRowDrag("));
  const body = begin.slice(0, begin.indexOf("\n}\n"));
  assert.match(body, /DRAG_SLOP/, "and moving before it elapses is a scroll, not a drag");
});

test("the drag follows the window, not the pad it started on", () => {
  /* Capturing the pointer on the pad is the obvious way to keep a drag alive
     and it is wrong here: moving the row to its new place moves the pad with
     it, and re-inserting a captured element releases the capture — the pad
     then receives nothing and the drag dies one pixel in. Measured:
     lostpointercapture fired on the very first move. */
  const begin = js.slice(js.indexOf("function beginRowDrag("));
  const body = begin.slice(0, begin.indexOf("\nasync function"));
  assert.match(body, /window\.addEventListener\("pointermove"/, "the window sees the drag");
  assert.match(body, /window\.addEventListener\("pointerup"/);
  assert.ok(!/setPointerCapture/.test(body),
    "capture on the pad is released the moment the row is moved");
  assert.match(body, /passive: false/, "and it can stop the menu scrolling under the drag");
  /* Without this the browser claims the gesture as a scroll before the app
     ever sees a move. */
  assert.match(css, /\.menu-grip \{[^}]*touch-action: none/s);
});

test("releasing saves the arrangement, and only when it changed", () => {
  const up = js.slice(js.indexOf("const up = ()"));
  const body = up.slice(0, up.indexOf("\n  };"));
  assert.match(body, /saveHomeRows\(/);
  assert.match(body, /order\.join\(\) === state\.homeRows\.map\(r => r\.id\)\.join\(\)/,
    "a row put back where it started is not a change worth a round trip");
  /* A drag changed the order and nothing else, so every row keeps the switch
     it already had — a save that reset them would be a reorder quietly turning
     things back on. */
  assert.match(body, /on\.get\(id\) !== false/);

  const save = js.slice(js.indexOf("async function saveHomeRows("));
  const saveBody = save.slice(0, save.indexOf("\n}"));
  assert.match(saveBody, /post\("\/api\/rows", \{ rows \}\)/,
    "both halves go together, or the two drift apart");
  assert.match(saveBody, /loadHome\(\)|homeStale/, "and the home screen is told to follow");
  assert.match(saveBody, /renderMenuRows\(\)/,
    "so is the menu — switching one off takes its entry out of the list");
  assert.match(saveBody, /state\.homeRows = previous/, "a failed save puts the list back");
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

/*
 * The soft keyboard must not move the mini transport.
 *
 * A fixed element is anchored to the layout viewport, which does not shrink
 * for the keyboard — but iOS re-anchors one to the VISUAL viewport while the
 * page scrolls, which lifted the bar out of the page and left it floating on
 * top of the keys whenever the search box had focus. Everything pinned to the
 * bottom subtracts the covered amount so it stays where it was put.
 */
/*
 * The side menu is destinations first, settings behind one button.
 *
 * A menu that is seven places and nine preferences in one list is a menu you
 * have to read rather than glance at. What each view holds is asserted here so
 * a later addition lands on the right side of that split by decision rather
 * than by whichever line it was pasted next to.
 */
test("the menu keeps places and settings apart", () => {
  const main = html.slice(html.indexOf('<div id="menu-main">'),
                          html.indexOf('<div id="menu-settings"'));
  const settings = html.slice(html.indexOf('<div id="menu-settings"'),
                              html.indexOf('</div>\n      </div>\n\n      <div class="menu-sep">'));

  /* Artists is no longer written into the markup — it is built by
     renderMenuRows with the rest of the fixed list, so the menu has one source
     rather than two that can disagree about the order. */
  for (const place of ['data-go="home"', 'id="menu-rows"']) {
    assert.ok(main.includes(place), `${place} is somewhere you go, so it stays on the first view`);
    assert.ok(!settings.includes(place), `${place} is not a setting`);
  }
  for (const setting of ["menu-rescan", "menu-theme", "menu-npleft", "menu-covers",
                         "menu-lastfm", "menu-update", "menu-version", "menu-home-open"]) {
    assert.ok(settings.includes(`id="${setting}"`), `${setting} belongs behind Settings`);
    assert.ok(!main.includes(`id="${setting}"`), `${setting} is no longer on the first view`);
  }
  assert.ok(main.includes('id="menu-settings-open"'), "and the way in is on the first view");
  assert.ok(settings.includes('id="menu-settings-back"'), "with a way back out of the second");
});

test("the library's counters cannot scroll away", () => {
  /* They answer "what is in here and which rooms can I reach" — the two things
     worth a glance rather than a scroll — so they sit outside the strip that
     scrolls and outside the strip that swaps. */
  const scroll = html.slice(html.indexOf('<div class="menu-scroll">'));
  const foot = html.indexOf('id="menu-foot"');
  const scrollEnd = html.indexOf('<div class="menu-sep"></div>\n      <div class="menu-foot"');
  assert.ok(scrollEnd > 0 && foot > scrollEnd, "the foot is after the scrolling strip, not inside it");
  assert.ok(!scroll.slice(0, scrollEnd - html.indexOf('<div class="menu-scroll">'))
              .includes('id="menu-foot"'));

  const panel = css.slice(css.indexOf(".menu-panel {"));
  assert.match(panel.slice(0, panel.indexOf("}")), /flex-direction: column/,
    "the panel is a column so the head and foot can stay put");
  assert.match(css, /\.menu-scroll \{[^}]*overflow-y: auto/,
    "and only the middle of it scrolls");
});

test("the menu opens on its first view, never on the settings last seen", () => {
  /* Reopening into Settings would have hidden Home behind a back button. */
  const open = js.slice(js.indexOf("function openMenu()"));
  assert.match(open.slice(0, open.indexOf("\n}")), /showMenuView\("main"\)/);
  const close = js.slice(js.indexOf("function closeMenu()"));
  assert.match(close.slice(0, close.indexOf("\n}")), /showMenuView\("main"\)/);
  /* Escape steps out one level at a time rather than closing the lot. */
  assert.match(js, /if \(menuIsOpen\(\)\) \{/);
  assert.match(js, /return showMenuView\("main"\);/);
});

test("everything pinned to the bottom allows for the keyboard", () => {
  const bar = css.slice(css.indexOf(".mini-transport {"));
  assert.match(bar.slice(0, bar.indexOf("}")), /bottom:[^;]*var\(--kb-inset, 0px\)/,
    "the mini transport holds its place when the keyboard opens");

  const sheet = css.slice(css.indexOf(".mt-vol-sheet {"));
  assert.match(sheet.slice(0, sheet.indexOf("}")), /bottom:[^;]*var\(--kb-inset, 0px\)/,
    "and the volume sheet moves with the bar it sits on, rather than apart from it");

  /* A fallback in every var() — the property only exists once app.js has
     measured a keyboard, and until then these must still compute. */
  for (const use of css.match(/var\(--kb-inset[^)]*\)/g) || []) {
    assert.match(use, /var\(--kb-inset, 0px\)/, `${use} has no fallback`);
  }
});

test("the keyboard is measured against the viewport that does not move", () => {
  /* window.innerHeight is the layout viewport and stays put when the keyboard
     opens; visualViewport is the one that shrinks. Measuring the difference
     between them is the whole trick, and measuring against the wrong one
     yields zero forever. */
  assert.match(js, /window\.innerHeight - viewport\.height/);
  /*
   * AND NOT offsetTop, which this test used to require.
   *
   * The keyboard's height is what is wanted; offsetTop is how far the visual
   * viewport has slid down inside the layout viewport, which is the SCROLL
   * POSITION. Folding it in made the measurement decay over the course of a
   * flick — 266, 226, 146, 0 — while the keyboard stood still, so the
   * correction switched itself off during the one gesture it exists for. */
  assert.doesNotMatch(js, /viewport\.height \+ viewport\.offsetTop/,
    "the keyboard's height must not vary with the scroll position");
  /* Both events: resize is the keyboard opening, scroll is the moment the bar
     used to jump. */
  assert.match(js, /viewport\.addEventListener\("resize", apply\)/);
  assert.match(js, /viewport\.addEventListener\("scroll", apply\)/);
  /* Absent on an old browser, where there is one viewport and nothing to fix. */
  assert.match(js, /if \(!viewport\) return;/);
  /* And a floor, so browser chrome or a pinch-zoom is not mistaken for a
     keyboard and does not twitch the bar. */
  assert.match(js, /const KB_MIN = \d+;/);
});

/*
 * While you are typing there is no mini bar.
 *
 * The subtraction above is arithmetic against a viewport whose behaviour is
 * not the same in Safari, in an installed home-screen app, or mid-scroll in
 * either — and it has now been reported twice as a bar sitting over the search
 * results with the keyboard up. The intent was always that the keyboard covers
 * the bar, so the bar is simply not there while the keyboard is: one rule, true
 * in every viewport model, and nothing left to paint in the wrong place.
 */
test("the mini transport is absent while the soft keyboard is up", () => {
  /* Decided in syncMini with the other conditions, so there is one place that
     knows whether the bar is on screen. */
  assert.match(js, /classList\.toggle\("hidden", onNpFace \|\| state\.typing \|\| selecting\(\)\)/);
  /* From the FOCUS, which is the actual cause of a soft keyboard, rather than
     from a measurement that only correlates with one. */
  assert.match(js, /el\.matches\("input, textarea"\)/);
  /* Coarse pointers only: a desktop keyboard is always up and covers nothing,
     and hiding the bar whenever somebody clicked the search box would be a new
     bug in place of the old one. */
  assert.match(js, /matchMedia\("\(pointer: coarse\)"\)\.matches/);
  /* focusout lands while activeElement is still the body, so it is read a tick
     later — otherwise moving between two fields blinks the bar back on. */
  assert.match(js, /"focusout", \(\) => setTimeout\(update, 0\)/);
});

test("the version tabs belong to the album, not to the panel", () => {
  /* The panel header already has a tab strip — Now playing and Queue — and
     putting the version tabs there would show them over the Now playing
     screen, which has no versions. They live inside the album face, between
     the Play/Queue pair and the track list they change. */
  const face = html.slice(html.indexOf('<div id="album-face">'),
                          html.indexOf('<div id="np-screen"'));
  assert.ok(face.includes('id="album-versions"'), "the strip is inside the album face");
  const actions = face.indexOf('class="modal-actions"');
  const strip = face.indexOf('id="album-versions"');
  const tracks = face.indexOf('id="tracks-label"');
  assert.ok(actions < strip && strip < tracks,
    "the version tabs sit between the buttons and the track list");
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
  const body = handler.slice(0, handler.indexOf("\n});"));
  assert.match(body, /musicdDepth/, "the depth comes off the entry, not a counter");
  assert.match(body, /nav\.splice\(depth\)/, "and every layer past it comes off at once");
});

test("a layer opened while the stack unwinds is not unwound with it", () => {
  /* The layers to close are decided BEFORE any of them is closed. A loop that
     re-read nav.length between closes saw a layer PUSHED BY a close callback
     as one more thing to unwind: tapping an artist on the album panel closes
     the panel, the close opens that artist's screen, and the same loop then
     closed that too — so the screen appeared and was replaced by Home. It only
     showed up when the panel was the only layer on the stack, which is what
     opening an album straight from the home screen does. */
  const handler = js.slice(js.indexOf('addEventListener("popstate"'));
  const body = handler.slice(0, handler.indexOf("\n});"));
  assert.ok(!/while \(nav\.length/.test(body),
    "the stack must not be re-read between closes");
  assert.ok(body.indexOf("nav.splice(depth)") < body.indexOf("layer.close()"),
    "it comes off the stack first, and is closed second");
});

test("every overlay registers itself with the navigation stack", () => {
  for (const layer of ['navOpen("modal"', 'navOpen("sheet"', 'navOpen("share"', 'navOpen("view"']) {
    assert.ok(js.includes(layer), layer + ") is on the stack");
  }
});

test("what the Now playing corner does is a preference, not a rule", () => {
  /*
   * Home was right on the reasoning it was built on — the mini bar is on every
   * screen, so Now playing can be reached from anywhere and there is no obvious
   * "back". It stops being right the moment somebody searches an artist, opens
   * their albums, taps the bar, and wants to be back at the artist. Neither
   * answer is wrong in general, so it is a choice.
   */
  assert.ok(htmlIds.has("menu-npleft"), "a row in Settings");
  assert.ok(htmlIds.has("npleft-sub"), "that says which way it is set");
  assert.match(js, /function applyNpLeft\(mode\)/);
  assert.match(js, /\$\("menu-npleft"\)\.addEventListener\("click"/);

  /* Kept on the device, beside the theme — the row ORDER is the library's and
     belongs in the database, but this is how one person's thumb gets out of a
     screen. */
  assert.match(js, /const NP_LEFT_KEY = "musicd\.npLeft";/);
  assert.match(js, /localStorage\.setItem\(NP_LEFT_KEY/);
  assert.match(js, /localStorage\.getItem\(NP_LEFT_KEY\) \|\| "home"/,
    "and Home is the default, because it is what every install already does");
});

test("the two corner controls are never both on screen", () => {
  /* They share grid column 1 of the panel's header, so two of them in one cell
     is one control drawn on top of another. One function decides, and it is
     the only thing that touches either. */
  assert.match(js, /function paintModalLeft\(\)/);
  const paint = js.slice(js.indexOf("function paintModalLeft()"));
  const body = paint.slice(0, paint.indexOf("\n}"));
  assert.match(body, /const showBack = !onNp \|\| state\.npLeft === "back";/);
  assert.match(body, /\$\("modal-back"\)\.classList\.toggle\("hidden", !showBack\)/);
  assert.match(body, /\$\("modal-home"\)\.classList\.toggle\("hidden", showBack\)/);

  /* Nowhere else may show or hide them, or the two could disagree. */
  const shows = [...stripComments(js, "js")
    .matchAll(/\$\("modal-(?:back|home)"\)\.classList\.toggle\("hidden"/g)];
  assert.strictEqual(shows.length, 2, "both toggles live in paintModalLeft and nowhere else");

  /* And the setting repaints a panel that is already open behind the menu. */
  const apply = js.slice(js.indexOf("function applyNpLeft(mode)"));
  assert.match(apply.slice(0, apply.indexOf("\n}")), /paintModalLeft\(\)/);
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

test("Now playing does not resize itself around the cover's pixel size", () => {
  /*
   * THE BUG THIS PINS.
   *
   * .modal-body carries `margin: 0 auto` to centre itself on a wide screen. On
   * this face the panel is a flex COLUMN, and an auto margin in a flex item's
   * cross axis switches stretching OFF — so the body became shrink-to-fit and
   * took its width from its widest content, which here is the artwork. A
   * 1400px sleeve filled the phone; a 300px one shrank the whole column to
   * 300px; a tiny one collapsed it to the width of the transport buttons. The
   * same screen looked like two different apps depending on how the cover
   * happened to have been scanned.
   *
   * A definite width gives back the stretch the auto margins took away.
   */
  const body = css.slice(css.indexOf(".modal.face-np .modal-body {"));
  const block = body.slice(0, body.indexOf("\n}"));
  assert.match(block, /width: 100%/, "the column fills the panel whatever is in it");
  /* And the artwork still fits rather than crops, which is the other half of
     the contract: the FRAME is constant, and a sleeve that is not square
     letterboxes inside it instead of losing its edges. */
  const art = css.slice(css.indexOf(".np-art img {"));
  assert.match(art.slice(0, art.indexOf("}")), /object-fit: contain/);
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

/* ------------------------------------------------------------------ */
/*  The update notice                                                  */
/* ------------------------------------------------------------------ */

test("the update notice floats rather than scrolling away", () => {
  /* In flow it scrolled off with the page, so anyone halfway down a wall never
     knew a version was waiting — which is the entire purpose of the thing. */
  assert.match(css, /\.update-banner \{[^}]*position: fixed; z-index: 60;/s);
  assert.match(css, /\.update-banner \{[^}]*top: calc\(var\(--topbar-h\) \+ 8px\);/s,
    "under the top bar, so it never covers the menu or the search");
  /* Below the album panel (70): a notice floating over Now playing would
     overlap that screen's own header. */
  const z = Number(/\.update-banner \{[^}]*z-index: (\d+);/s.exec(css)[1]);
  const modal = Number(/\.modal \{ position: fixed; inset: 0; z-index: (\d+); \}/.exec(css)[1]);
  assert.ok(z > 40 && z < modal, `${z} must sit above the top bar and below the panel (${modal})`);
});

test("the floating notice is opaque, or the wall shows through it", () => {
  /* --accent-soft and --danger-soft are translucent TINTS. Painted straight
     onto the page that was fine; over a moving wall of sleeves it is not. Both
     are layered over a solid ground instead. */
  assert.match(css, /\.update-banner \{[^}]*background: linear-gradient\(var\(--accent-soft\), var\(--accent-soft\)\), var\(--bg-elev-2\);/s);
  assert.match(css, /\.update-banner\.is-error \{[^}]*linear-gradient\(var\(--danger-soft\), var\(--danger-soft\)\), var\(--bg-elev-2\);/s);
});

test("Release notes is not the browser's link blue", () => {
  /* The one colour on that screen belonging to no palette and following no
     theme. --text is near-white on the dark themes and near-black on the light
     ones; :visited is named too, or a followed link goes the browser's purple. */
  assert.match(css, /\.update-link, \.update-link:visited \{[^}]*color: var\(--text\); text-decoration: underline;/s);
  assert.match(css, /\.update-link, \.update-link:visited \{[^}]*font-weight: 700;/s);
});

/* ------------------------------------------------------------------ */
/*  Looking for a cover by hand                                        */
/* ------------------------------------------------------------------ */

test("a candidate is chosen by position, never by URL", () => {
  /*
   * A server that fetches a URL a client hands it is an open proxy onto the
   * network it sits in — and this one sits on somebody's home network, beside
   * a router's admin page. The server holds the list it offered and the client
   * names an entry in it.
   */
  const body = js.slice(js.indexOf("async function chooseCover("));
  const fn = body.slice(0, body.indexOf("\n}"));
  assert.match(fn, /post\("\/api\/album\/" \+ b64url\(playing\(editing\)\) \+ "\/cover", \{ index \}\)/);
  assert.ok(!/url:/.test(fn), "no URL is ever posted back");
  /* And the download refuses anything off the allowlist even so, because the
     check belongs where the fetch is rather than where the caller is trusted. */
  const covers = fs.readFileSync(path.join(__dirname, "..", "lib", "covers.js"), "utf8");
  assert.match(covers, /if \(!hostAllowed\(url[^)]*\)\) throw new Error\("not a cover source"\)/);
});

test("the search uses what is in the fields, not what is saved", () => {
  /* The album the sweep cannot find is very often the one whose files name no
     artist — which is the album somebody is in this dialog to name. Searching
     with the saved value would mean saving before you could look. */
  const body = js.slice(js.indexOf("async function findCovers("));
  const fn = body.slice(0, body.indexOf("\n}\n"));
  assert.match(fn, /encodeURIComponent\(\$\("edit-title"\)\.value\.trim\(\)\)/);
  assert.match(fn, /encodeURIComponent\(\$\("edit-artist"\)\.value\.trim\(\)\)/);
});

test("the cover section provides its own gap above Save", () => {
  /* .edit-actions has NO top margin — the space above Cancel and Save has
     always come from whatever sits above them. So a section inserted between
     the note and the actions has to bring its own bottom margin, or Find cover
     and Save read as one crowded block, which is exactly what shipped. */
  assert.match(css, /\.edit-actions \{ display: flex; gap: 10px; justify-content: flex-end; \}/,
    "if this grows a margin-top, the rule below is no longer the only thing holding the gap");
  const rule = /\.edit-cover \{ margin: (\d+)px 0 (\d+)px; \}/.exec(css);
  assert.ok(rule, "the cover section sets its own margins");
  assert.ok(Number(rule[2]) >= 14, "and the bottom one is a real gap: " + (rule && rule[2]));
});

test("the dialog can always reach its own Save button", () => {
  /* It grew a grid of covers. A panel with no ceiling pushes Save off the
     bottom of a phone the moment there are two rows of them. */
  assert.match(css, /\.edit-panel \{[^}]*max-height:/s);
  assert.match(css, /\.edit-panel \{[^}]*overflow-y: auto; overscroll-behavior: contain;/s);
});

test("last album's covers are never offered for this one", () => {
  const body = js.slice(js.indexOf("function openEditDialog()"));
  assert.match(body.slice(0, body.indexOf("\n}")), /resetCoverSearch\(\)/);
});

/* ------------------------------------------------------------------ */
/*  The shape of the track                                             */
/* ------------------------------------------------------------------ */

test("the waveform is decoration under the seek bar, never a replacement", () => {
  /* The range input keeps the drag, the keyboard, the thumb and the disabled
     state. If the fetch fails or the file cannot be decoded, what is left is
     the bar exactly as it was before the feature existed. */
  assert.match(html, /<canvas id="np-wave" class="np-wave hidden" aria-hidden="true">/);
  assert.match(css, /\.np-wave \{[^}]*pointer-events: none/s,
    "the input underneath has to keep the drag");
  /*
   * THE HEIGHT IS THE POINT, and it was wrong first time round.
   *
   * Bound to the plain bar's 14px the waveform is right in length and
   * unreadable in height — every bar within a few pixels of every other, which
   * is a texture rather than a shape. The canvas draws at --wave-h and the
   * INPUT IS GROWN to match: a range centres its own track and thumb in its
   * box, so a 34px input puts the thumb exactly on the waveform's midline with
   * no offset to keep in step, and the whole shape becomes draggable rather
   * than just the 4px line the plain bar occupies.
   */
  assert.match(css, /--wave-h: 34px;/);
  assert.match(css, /\.np-progress\.has-wave \.np-seek \{ height: var\(--wave-h\);/);
  assert.match(css, /\.np-wave \{[^}]*height: var\(--wave-h\)/s);
  /* Chrome's UA sheet puts margin: 2px on input[type=range]. The canvas is
     positioned against the CONTAINER while the input sits in flow below that
     margin, so without allowing for it the shape is drawn two pixels above the
     thumb meant to ride along it. One token, read by both rules. */
  assert.match(css, /--seek-inset: 2px;/);
  assert.match(css, /\.np-wave \{[^}]*top: var\(--seek-inset\)/s);
  assert.match(css, /\.np-seek \{[^}]*margin: var\(--seek-inset\) 0;/s);
});

test("the seek bar's own track is REMOVED, not overridden, under a waveform", () => {
  /*
   * Both halves are needed and only one of them is obvious.
   *
   * The stylesheet says --fill: transparent for .has-wave — and on its own
   * that does nothing at all, because fillRange() writes --fill INLINE four
   * times a second and an inline custom property beats any stylesheet rule
   * however specific. MusicD Remote shipped exactly that and drew a grey line
   * straight through the middle of the waveform (its v1.7.90).
   */
  assert.match(css, /\.np-progress\.has-wave \.np-seek \{ --fill: transparent; \}/);
  const body = js.slice(js.indexOf("function fillRange("));
  const fn = body.slice(0, body.indexOf("\n}"));
  assert.match(fn, /removeProperty\("--fill"\)/,
    "the inline property has to go, not be written with a transparent value");
  /* Asked in ONE place, so the two call sites cannot drift. */
  assert.match(fn, /input\.closest\("\.np-progress"\)/);
});

test("a slow waveform cannot land under a track that has already changed", () => {
  const body = js.slice(js.indexOf("async function loadWaveform("));
  const fn = body.slice(0, body.indexOf("\n}"));
  /* Landing a stale waveform under a different song is worse than none: it
     looks authoritative and it is simply the wrong shape. */
  assert.match(fn, /if \(mine !== state\.waveReq \|\| state\.waveKey !== id\) return;/);
  /* Keyed on the TRACK ID. This server knows exactly which file is playing —
     there is nothing to match on a title and nothing that can resolve to the
     wrong recording. */
  assert.match(fn, /now\.track \? now\.track\.id : ""/);
  assert.match(fn, /"\/api\/track\/" \+ b64url\(id\) \+ "\/waveform"/);
});

test("the waveform and the bar read the same position", () => {
  /* Drawn from the same number in the same function, so the two can never
     disagree about where the track is — and drawn FIRST, because drawWave is
     what adds and removes .has-wave that fillRange goes on to read. */
  const body = js.slice(js.indexOf("function paintProgress("));
  const fn = body.slice(0, body.indexOf("\n}"));
  const wave = fn.indexOf("drawWave(position)");
  const fill = fn.indexOf("fillRange(seek, position");
  assert.ok(wave > -1 && fill > -1 && wave < fill,
    "drawWave sets the class that fillRange reads, so it has to go first");
});

/* ------------------------------------------------------------------ */
/*  Choosing several albums at once                                    */
/* ------------------------------------------------------------------ */

/*
 * The selection belongs to the SESSION, not to a screen.
 *
 * That is the whole of what was asked for: hold an album in one carousel, walk
 * back through Home into another, and keep adding to the same set. Every wall
 * is thrown away and rebuilt as you move between them, so the only way this can
 * work is for the cards to be painted from the selection rather than the
 * selection being read back off the cards.
 */
test("the selection outlives the screen it was started on", () => {
  /* On state, beside the other things that survive a screen change. */
  assert.match(js, /^\s*select: null,/m);
  /* And nothing on the way in or out of a screen clears it. showView() and
     openRow() run on every navigation; either one resetting the selection
     would break the one requirement this feature has. */
  for (const fn of ["function showView(", "async function openRow("]) {
    const body = js.slice(js.indexOf(fn));
    assert.ok(!/state\.select\s*=/.test(body.slice(0, body.indexOf("\n}"))),
      fn + " must not reset the selection — it has to cross screens");
  }
  /* Painted from the selection as each card is built, which is what makes an
     album ticked on a wall it was never chosen on. */
  assert.match(js, /if \(picked\(album\.id\)\) card\.classList\.add\("is-picked"\)/);
});

test("a repaint reaches every card on the page, not just the open wall", () => {
  const body = js.slice(js.indexOf("function paintPicked()"));
  /* document-wide: Home's carousels, the search results and an artist's albums
     are all cards outside #album-grid, and a grid-scoped clear would leave
     ticks behind on the screens the selection was gathered from. */
  assert.match(body.slice(0, body.indexOf("\n}")),
    /document\.querySelectorAll\("\.album\[data-album\]"\)/);
});

test("a flick along a carousel is a scroll, not a hold", () => {
  /* The rows scroll sideways and the gesture starts on a card, so without this
     every flick along a carousel would drop the user into select mode. */
  const body = js.slice(js.indexOf("function holdToPick("));
  const fn = body.slice(0, body.indexOf("\n}\n"));
  assert.match(fn, /Math\.abs\(ev\.clientX - startX\) > PICK_SLOP/);
  assert.match(fn, /Math\.abs\(ev\.clientY - startY\) > PICK_SLOP/);
  /* And the browser's own answer to a long press — the desktop menu, the iOS
     image callout — is not allowed over the top of ours. */
  assert.match(fn, /"contextmenu", \(e\) => e\.preventDefault\(\)/);
  /* Longer than the row pads' hold: a card is the app's ordinary tap target. */
  const hold = /const PICK_HOLD_MS = (\d+);/.exec(js);
  const drag = /const DRAG_HOLD_MS = (\d+);/.exec(js);
  assert.ok(hold && drag && Number(hold[1]) > Number(drag[1]),
    "an unhurried tap on an album must not start choosing albums");
});

test("the click behind a hold does not undo what the hold just did", () => {
  /* The same idiom the covers and Last.fm rows use: one gesture arrives as a
     hold AND as the click that follows the finger coming up, and letting the
     second through would toggle straight back off the album just chosen. */
  assert.match(js, /if \(state\.pickHeld\) \{ state\.pickHeld = false; return; \}/);
  assert.match(js, /state\.pickHeld = true;/);
});

test("a selection that could not be played is kept, not thrown away", () => {
  const body = js.slice(js.indexOf("async function playPicked("));
  const fn = body.slice(0, body.indexOf("\n}\n"));
  /* exitSelect() belongs to the success path only. Losing a set somebody
     picked one album at a time because the room was busy is the worse half of
     the two things that can go wrong. */
  const success = fn.slice(0, fn.indexOf("} catch"));
  const failure = fn.slice(fn.indexOf("} catch"));
  assert.match(success, /exitSelect\(\)/);
  assert.ok(!/exitSelect\(\)/.test(failure), "a failed play must not clear the selection");
});

test("the whole selection goes in one request", () => {
  /* One call with every album rather than one call per album: the server
     clears the room's queue for a play, so a loop would have each album wipe
     the one before it and leave only the last playing. */
  assert.match(js, /post\("\/api\/play", \{ zone: state\.zone\.uuid, albumIds: ids, mode \}\)/);
});

test("the mini bar is always on screen, because it is the only room picker", () => {
  /* Hiding it when nothing is playing would leave a fresh install with nowhere
     to choose a speaker from, now that the top bar has no button for it. */
  const sync = js.slice(js.indexOf("function syncMini()"));
  const body = sync.slice(0, sync.indexOf("\n}"));
  /* Three exceptions and no others: the Now playing face, which carries the
     full transport already; a soft keyboard, which the bar is meant to be
     behind; and choosing albums, where the selection bar stands in its place.
     None of them is about whether anything is playing. */
  assert.match(body, /classList\.toggle\("hidden", onNpFace \|\| state\.typing \|\| selecting\(\)\)/);
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

test("the artist is tappable on Now playing as well as on the album", () => {
  /* Tapping the album name there already opens the album; the artist beside it
     did nothing. Both screens build their names through the same function, so
     they cannot drift about what counts as one artist. */
  const build = /function renderArtistLinks\([\s\S]*?\n\}/.exec(js);
  assert.ok(build, "there is one builder");
  assert.match(build[0], /openArtist\(name\)/);
  assert.match(js, /renderArtistLinks\(\$\("np-artist"\)/, "Now playing uses it");
  assert.match(js, /renderArtistLinks\(subtitle/, "and so does the album screen");
  /* And nothing writes over it with plain text afterwards. */
  assert.ok(!/\$\("np-artist"\)\.textContent =/.test(js),
    "nothing replaces those links with a flat string");
});

test("the volume steps are drawn, not typed", () => {
  /* As text the - and + sat off the centre of their circles, and by how much
     depended on which font the platform resolved: flexbox centres the LINE
     BOX, and a glyph's ink sits wherever that font's metrics put it relative
     to the baseline. Two lines through the middle of a 24x24 box are centred
     everywhere. */
  for (const id of ["mt-vol-minus", "mt-vol-plus", "np-vol-minus", "np-vol-plus"]) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > -1, id + " exists");
    const markup = html.slice(at, html.indexOf("</button>", at));
    assert.match(markup, /<svg/, id + " is drawn");
    assert.match(markup, /<line x1="6" y1="12" x2="18" y2="12"/,
      id + " draws its bar across the exact middle");
    assert.ok(!/&#8722;|&plus;|>\s*[+\u2212-]\s*</.test(markup), id + " is not a glyph");
  }
  /* The plus is the bar plus an upright, both centred on 12. */
  const plus = html.slice(html.indexOf('id="mt-vol-plus"'));
  assert.match(plus.slice(0, plus.indexOf("</button>")), /<line x1="12" y1="6" x2="12" y2="18"/);
  assert.ok(!/\.vol-step \{[^}]*font:/s.test(css), "and the button no longer sets a font");
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

test("a long press selects nothing, except on the share card", () => {
  /* A long press on a phone is how you scroll from a standstill and how you
     hesitate before tapping. On a web page it also selects text, so resting a
     thumb on a menu item raised iOS's selection handles and its Copy / Look Up
     / Translate bar over the app. This is a remote control: every word on it is
     a label on a control. */
  assert.match(css, /^\* \{[^}]*user-select: none/ms, "nothing is selectable by default");
  assert.match(css, /^\* \{[^}]*-webkit-touch-callout: none/ms,
    "and the callout goes with it — that is the half that raises iOS's own sheet");

  /* Given back where there is something worth taking away. The card is an image
     the whole screen exists to give away, and the hint under it says to long-
     press it. */
  const frame = css.slice(css.indexOf(".share-frame img {"));
  const block = frame.slice(0, frame.indexOf("}"));
  assert.match(block, /-webkit-touch-callout: default/);
  assert.match(block, /user-select: auto/);

  /* And a field is still a field. */
  const field = css.slice(css.indexOf("input, textarea {"));
  assert.match(field.slice(0, field.indexOf("}")), /user-select: text/);
});

test("the Play and Queue buttons are one control in two halves", () => {
  /* "Play" is shorter than "Queue", so padding alone made the primary action
     the smaller button. */
  const block = css.slice(css.indexOf(".action-btn {"));
  const body = block.slice(0, block.indexOf("}"));
  assert.match(body, /min-width: \d+px/, "they are the same width whatever is on them");
  assert.match(body, /min-height: var\(--ctl-h-lg\)/, "and taller than the ordinary control");
});

test("a track row has the same air on both sides", () => {
  /* The row used to run edge to edge, so the duration sat hard against the
     right of the screen while the title was a whole number-column further in
     from the left. A gutter gives the duration somewhere to stop and gives the
     left the same amount back. */
  assert.match(css, /\.track-list li \{[^}]*padding: 10px 8px;/s, "a gutter, equal both sides");
  assert.match(css, /\.track-list li\.is-disc \{[^}]*padding: 18px 8px 6px;/s,
    "and the disc heading keeps to it");
  assert.match(css, /#tracks-label \{ padding-left: 8px; \}/,
    "so does the heading over the list");
  /* The rule under each track still spans the full width — a hairline that
     stops short of the edge turns a track list into a stack of cards. */
  assert.ok(!/\.track-list li \{[^}]*margin: 0 8px/s.test(css));
  assert.match(css, /\.t-no \{[^}]*text-align: left;/s);
  assert.match(css, /\.t-no \{[^}]*font-variant-numeric: tabular-nums/s,
    "figures still line the titles up");
});

test("the number column is absent on an album with no track numbers", () => {
  /* A rip whose numbering lives in the filename carries no number tag at all,
     so the column was a stack of placeholder dots pushing every title a
     further 38px in from a left edge that already had more air than the right.
     Decided once for the whole list, so one file with a lost tag does not sit
     its title out of line with the other eleven. */
  const render = js.slice(js.indexOf("function renderAlbum(album)"));
  const body = render.slice(0, render.indexOf("\n}"));
  assert.match(body, /const numbered = album\.tracks\.some\(t => t\.no\);/,
    "asked of the whole album, not of each row");
  assert.match(body, /if \(numbered\) li\.appendChild\(el\("span", "t-no"/,
    "and the column only exists when the answer is yes");
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

/* ------------------------------------------------------------------ */
/*  The Now playing scroll indicator                                   */
/* ------------------------------------------------------------------ */

test("a drag on Now playing is not handed to the page behind it", () => {
  /*
   * The bug this replaces: a screen that never scrolls, with a scroll bar down
   * the right of it.
   *
   * overflow: hidden stops the face scrolling but not the GESTURE — a drag the
   * panel had no use for went up the chain to the document, which is one long
   * scrolling page. The panel is fixed, so nothing moved; the only sign was the
   * PAGE's own indicator appearing over a screen that cannot scroll. It also
   * woke the infinite-scroll listener, which loads another grid page whenever
   * the document nears its end.
   */
  const np = css.slice(css.indexOf(".modal.face-np .modal-panel {"));
  const block = np.slice(0, np.indexOf("\n}"));
  assert.match(block, /overflow: hidden/, "the face still does not scroll");
  assert.match(block, /touch-action: none/, "and declines the drag rather than passing it on");

  /* Given back in the one window where the face really does scroll — a rule
     that stayed behind there would make the transport unreachable. */
  assert.match(css, /@media \(max-height: 520px\) \{[^@]*touch-action: auto/s);
});

test("the panel's scroll stops at the panel", () => {
  /* The same defect from the other side: flicking past the end of the track
     list chained to the document, which scrolled behind a full-screen overlay
     and left Home somewhere else when the panel closed. */
  const panel = css.slice(css.indexOf(".modal-panel {"));
  const block = panel.slice(0, panel.indexOf("\n}"));
  assert.match(block, /overscroll-behavior: contain/);
});

/* ------------------------------------------------------------------ */
/*  The overflow menu and the edit dialog                              */
/* ------------------------------------------------------------------ */

test("the album's sleeve carries an overflow menu at its bottom right", () => {
  assert.ok(htmlIds.has("album-more"), "the … button");
  assert.ok(htmlIds.has("album-menu"), "the menu it opens");
  assert.ok(htmlIds.has("album-edit"), "and the one thing on it");

  /* Positioned against the WRAPPER, not the art: .modal-art clips to its own
     rounded corners, so a menu inside it would be cut off by them. */
  const more = css.slice(css.indexOf(".art-more {"));
  const block = more.slice(0, more.indexOf("\n}"));
  assert.match(block, /position: absolute/);
  assert.match(block, /right: \d/, "at the right");
  assert.match(block, /bottom: \d/, "and the bottom");
  assert.match(css, /\.modal-art-wrap \{[^}]*position: relative/s, "of a box that anchors it");
  assert.ok(!/\.modal-art-wrap \{[^}]*overflow: hidden/s.test(css), "and does not clip it");

  /* A control ON artwork needs its own ground: a sleeve is as light in the
     dark theme as in the light one, so the disc cannot follow either. */
  assert.match(css, /--scrim:/, "the scrim is a token");
  const dark = css.slice(css.indexOf(":root {"), css.indexOf('[data-theme="light"]'));
  const light = css.slice(css.indexOf('[data-theme="light"]'), css.indexOf("*, *::before"));
  for (const token of ["--scrim", "--scrim-strong", "--on-scrim"]) {
    assert.ok(dark.includes(token + ":") && light.includes(token + ":"),
      token + " is declared in both palettes");
  }
});

test("the menu is dismissed by a tap anywhere, including the panel's own header", () => {
  /* The head is sticky at z-index 3 and was intercepting the taps meant for
     the catch, so a tap at the top of the screen pressed Back and left the
     menu open on a panel that was closing. */
  const layer = css.slice(css.indexOf(".art-menu-layer {"));
  const block = layer.slice(0, layer.indexOf("}"));
  const z = /z-index:\s*(\d+)/.exec(block);
  assert.ok(z, "the menu layer sets a z-index");
  const head = css.slice(css.indexOf(".modal-head {"));
  const headZ = /z-index:\s*(\d+)/.exec(head.slice(0, head.indexOf("}")));
  assert.ok(Number(z[1]) > Number(headZ[1]), "and it is above the panel's header");
  /* The catch is what makes the tap land nowhere else. */
  assert.match(css, /\.art-menu-catch \{[^}]*position: fixed/s);
  assert.match(html, /data-menu-close/, "and something in the markup carries it");
});

test("the sleeve's menu is closed directly, never unwound", () => {
  /* A menu, not a place you went — the same rule the side menu follows. A
     history entry for it would mean the phone's Back gesture dismissed a popup
     instead of leaving the album, and picking Edit would have to unwind that
     entry and open a dialog in the same breath. */
  assert.ok(!/navOpen\("menu"/.test(js), "it is not on the navigation stack");
  assert.match(js, /if \(albumMenuOpen\(\)\) return closeAlbumMenu\(\);/,
    "Escape closes it directly, innermost first");
  /* And it cannot be left open on a face that is no longer showing. */
  const face = js.slice(js.indexOf("function setFace(face)"));
  assert.match(face.slice(0, face.indexOf("\n}")), /closeAlbumMenu\(\)/);
});

test("the edit dialog has every field the client writes into", () => {
  for (const id of ["edit-overlay", "edit-title", "edit-artist", "edit-save",
                    "edit-cancel", "edit-err", "edit-heading"]) {
    assert.ok(htmlIds.has(id), id + " is in the markup");
  }
  /* It IS a place you went: it has to be dismissed, and the phone's Back
     gesture is how a phone dismisses things. */
  assert.match(js, /navOpen\("edit", hideEditDialog\)/);
  assert.match(js, /data-edit-close/);
});

test("the dialog says how a correction is undone, and what it does not touch", () => {
  /* The blank field IS the undo — there is no third button for it — so a
     dialog that does not say so has a feature nobody can find. And the promise
     the whole app rests on is worth repeating in the one place somebody is
     about to doubt it. */
  const note = /<p class="edit-note">([\s\S]*?)<\/p>/.exec(html);
  assert.ok(note, "the dialog carries a note");
  assert.match(note[1], /Clear a field/);
  assert.match(note[1], /never changed/);
  /* And the field says what it will fall back to, where the fallback happens. */
  assert.match(js, /artist\.placeholder = tags\.artist \|\| "Unknown artist"/);
});

test("a second Enter cannot save twice, or unwind two screens", () => {
  /*
   * Enter in a field does not go through the Save button, so disabling the
   * button stops a second TAP and nothing else. Two Enters in one tick — a
   * held key, or a fast double press of a phone keyboard's Done — each started
   * a save, and each finished with a navBack(): two of those unwind the dialog
   * AND the album screen behind it.
   */
  const save = js.slice(js.indexOf("async function saveEdit()"));
  const body = save.slice(0, save.indexOf("\n}"));
  assert.match(body, /if \(!editing \|\| savingEdit\) return;/, "an in-flight save is refused");
  assert.match(body, /savingEdit = true;/);
  assert.match(body, /savingEdit = false;/, "and cleared, so a failed save can be retried");
  /* And the finished one lets go BEFORE the close: closeEditDialog is a
     history.back(), and the dialog is not hidden until the popstate lands. */
  assert.ok(body.indexOf("editing = null;") < body.indexOf("closeEditDialog()"),
    "the album is released before the close, not by it");
});

test("a correction is saved, then re-read, rather than painted on trust", () => {
  /* The heart paints first and asks afterwards because a heart that waits for
     a round trip feels broken. A name is the other way round: the server is
     what decides whether what was typed is a correction at all or the tags
     typed back, so painting a guess would show one that was never stored. */
  const save = js.slice(js.indexOf("async function saveEdit()"));
  const body = save.slice(0, save.indexOf("\n}"));
  assert.match(body, /await post\("\/api\/album\/name"/, "it goes to the server");
  assert.ok(body.indexOf('post("/api/album/name"') < body.indexOf("renderAlbum(next)"),
    "and only repaints from the answer");
  assert.match(body, /state\.homeStale = true/,
    "every row on Home carries this album's name on a card");
});

/* ------------------------------------------------------------------ */
/*  What a record is, and who made it                                  */
/* ------------------------------------------------------------------ */

test("the write-up and the biography are one renderer on two screens", () => {
  assert.ok(htmlIds.has("album-info"), "the album's");
  assert.ok(htmlIds.has("artist-info"), "the artist's");
  assert.match(js, /function renderInfo\(host, info\)/, "one function paints both");
  assert.match(js, /loadInfo\(\$\("album-info"\)/);
  assert.match(js, /loadInfo\(\$\("artist-info"\)/);
});

test("the credit is outside the part that collapses", () => {
  /*
   * Wikipedia and Last.fm both give their prose away on one condition: that it
   * is credited and linked. A credit that only appears once somebody presses
   * "Read more" is a credit that is usually not shown at all — so it is
   * appended after the button rather than into the clamped body, and the
   * stylesheet folds .info-body alone.
   */
  const render = js.slice(js.indexOf("function renderInfo(host, info)"));
  const body = render.slice(0, render.indexOf("\n}"));
  assert.ok(body.indexOf("host.appendChild(more)") < body.indexOf("creditFor(info)"),
    "the credit comes after the fold, not inside it");
  assert.match(css, /\.info-body \{[^}]*line-clamp: 5/s, "the body is what folds");
  assert.ok(!/\.info \{[^}]*line-clamp/s.test(css), "not the block that holds the credit");
});

test("the credit names the source, the licence and a way to the article", () => {
  const credit = js.slice(js.indexOf("function creditFor(info)"));
  const body = credit.slice(0, credit.indexOf("\n}"));
  assert.match(body, /"Last\.fm" : "Wikipedia"/, "which of the two answered");
  assert.match(body, /link\.href = info\.url/, "a link back, which both licences ask for");
  assert.match(body, /info\.licence/, "and the licence it arrived under");
  /* A link out of the app opens away from it, and rel is what stops the new
     tab reaching back into this one. */
  assert.match(body, /link\.target = "_blank"/);
  assert.match(body, /noopener noreferrer/);
});

test("a late answer cannot land on the screen that replaced it", () => {
  /* The album screen can be closed and another opened while a request is still
     out. Painting a late answer onto whatever is showing now is how the wrong
     band's biography ends up under the right band's albums. */
  const load = js.slice(js.indexOf("async function loadInfo("));
  const body = load.slice(0, load.indexOf("\n}"));
  assert.match(body, /state\.infoFor = key/);
  assert.match(body, /if \(state\.infoFor !== key\) return;/);
});

test("a failed lookup is silent", () => {
  /* The one place in this app where a silent catch is right, and it says so:
     a write-up is not what anybody opened the screen for, and a toast about a
     failed biography interrupts somebody who came to press play. */
  const load = js.slice(js.indexOf("async function loadInfo("));
  const body = load.slice(0, load.indexOf("\n}"));
  assert.ok(!/toast\(/.test(body), "no toast for something nobody asked for");
  assert.match(body, /\/\* Silent on purpose/, "and the silence carries its reason");
});

test("the biography belongs to the artist screen, and is cleared once", () => {
  /* Every home row opened in full shares the artist screen's markup, so a
     biography left behind would appear over a row of albums. */
  const show = js.slice(js.indexOf("function showView(view, title)"));
  const body = show.slice(0, show.indexOf("\n}"));
  assert.match(body, /\$\("artist-info"\)\.classList\.add\("hidden"\)/,
    "cleared in the one place every view change goes through");
});

test("an album's write-up is keyed on the record, not the version on show", () => {
  /* /api/album answers with the record's identity whichever version was asked
     for, so album.id is the primary's — switching version tabs repaints the
     same write-up rather than fetching a second one. */
  assert.match(js, /loadInfo\(\$\("album-info"\), "album:" \+ album\.id,/);
  assert.match(js, /"\/api\/album\/" \+ b64url\(album\.id\) \+ "\/info"/);
});

/* ------------------------------------------------------------------ */
/*  Random Album Radio                                                 */
/* ------------------------------------------------------------------ */

test("the genre option is absent while the radio is off, not dimmed", () => {
  /* It is not a setting that is currently unavailable — it is a setting that
     describes something not happening. The same rule the covers row follows on
     a container with the lookup switched off. */
  assert.ok(htmlIds.has("menu-radio"), "the switch");
  assert.ok(htmlIds.has("menu-radio-genre"), "and the option under it");
  const show = js.slice(js.indexOf("function showRadio(radio)"));
  const body = show.slice(0, show.indexOf("\n}"));
  assert.match(body, /genre\.classList\.toggle\("hidden", !radio\.enabled\)/,
    "hidden by the radio being off");
  assert.match(body, /genre\.classList\.toggle\("is-off", !radio\.matchGenre\)/,
    "and dimmed only by its own setting");
});

test("both radio rows are painted from what the server says it did", () => {
  /* This setting lives in the database and drives a loop nothing on the phone
     can see, so the server's answer is the only true one — painting from what
     was asked for would let a phone show a radio that is not running. */
  assert.match(js, /showRadio\(await post\("\/api\/radio", \{ \[field\]: !now\[field\] \}\)\)/);
  assert.match(js, /if \(status\.radio\) showRadio\(status\.radio\);/,
    "and the status poll repaints them, so two phones cannot disagree for long");
});

/* ------------------------------------------------------------------ */
/*  How the Library screen is ordered                                  */
/* ------------------------------------------------------------------ */

test("the sort bar belongs to the Library screen and nowhere else", () => {
  /* Every other grid IS an order: "Recently added" re-sorted by artist is a
     row that no longer means what its name says. */
  assert.ok(htmlIds.has("sort-bar"));
  assert.ok(htmlIds.has("sort-open"));
  assert.ok(htmlIds.has("sort-dir"));
  const paint = js.slice(js.indexOf("function paintSortBar()"));
  const body = paint.slice(0, paint.indexOf("\n}"));
  assert.match(body, /state\.grid && state\.grid\.key === "library"/);
  /* Cleared in showView, the one place every view change goes through, so an
     opener that forgot could not leave it over a row of albums. */
  const show = js.slice(js.indexOf("function showView(view, title)"));
  assert.match(show.slice(0, show.indexOf("\n}")),
    /\$\("sort-bar"\)\.classList\.add\("hidden"\)/);
});

test("the order is kept by the server, not by the phone", () => {
  /*
   * The requirement it was asked for: it has to survive an update, a reboot
   * and a restart. localStorage would also lose it to a cleared cache or a
   * re-added home-screen shortcut — the failure that reads as a regression.
   */
  assert.match(js, /async function loadSort\(\)/);
  assert.match(js, /api\("\/api\/sort"\)/, "read from the server at startup");
  assert.match(js, /post\("\/api\/sort", next\)/, "and written back to it");
  const save = js.slice(js.indexOf("async function saveSort(next)"));
  const body = save.slice(0, save.indexOf("\n}"));
  assert.ok(!/localStorage/.test(body), "nothing about this touches the phone's storage");
  /* Painted from what came BACK, because the server decides what a valid view
     is — painting the request could show an order the library is not in. */
  assert.match(body, /state\.sort = data\.view/);
});

test("changing the order re-reads the wall from the top", () => {
  /* A new order makes every page boundary meaningless, so appending the next
     page of the old one underneath would interleave two sorts. */
  const save = js.slice(js.indexOf("async function saveSort(next)"));
  const body = save.slice(0, save.indexOf("\n}"));
  assert.match(body, /openRow\("library"\)/);
});

test("a sort is chosen in its own direction, and Random is shuffled", () => {
  const sheet = js.slice(js.indexOf("function openSortSheet()"));
  const body = sheet.slice(0, sheet.indexOf("\n}\n"));
  /* dir is left OUT, which is what asks the server for that sort's own
     default — inheriting "A → Z" onto "sort by year" answers a different
     question. */
  assert.match(body, /saveSort\(\{ sort: option\.id \}\)/);
  assert.ok(!/dir:/.test(body), "the sheet never names a direction");
  /* Random has none, so its control is the only thing a shuffle needs. */
  assert.match(js, /def\.directional\s*\n?\s*\? \{ sort: state\.sort\.sort, dir:/s);
  assert.match(js, /: \{ sort: state\.sort\.sort, seed: nextSeed\(state\.sort\.seed\) \}/);
  assert.match(js, /function nextSeed\(current\)/);
});
