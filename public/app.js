/*
 * MusicD Server — the client.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 *
 * One screen at a time, and one card renderer for every album everywhere it
 * appears — the home carousels, the full grids, the search results. That is
 * what keeps this file small enough to read.
 */

"use strict";

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function post(path, data) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
}

function mmss(seconds) {
  const t = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(t / 60), s = t % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, "0")}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function runtime(seconds) {
  const total = Number(seconds) || 0;
  /* Rounding to the nearest minute turns anything under thirty seconds into
     "0 min", which reads as missing data rather than as a short record. */
  if (total < 60) return "under a minute";
  const mins = Math.round(total / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return mins % 60 ? `${h} hr ${mins % 60} min` : `${h} hr`;
}

/* Dates are shown as "how long ago", because that is the only thing anybody
   reads them for on this screen. */
function ago(ts) {
  if (!ts) return "";
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30.4);
  if (months < 24) return `${months} month${months === 1 ? "" : "s"} ago`;
  return `${Math.round(months / 12)} years ago`;
}

/* Copying, with somewhere to fall back to. The clipboard needs a secure
   context, which a LAN address over plain HTTP is not — so when it is refused
   the text goes on screen instead, where it can at least be read out. */
function copyText(text, done) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(done), () => toast(text));
  } else {
    toast(text);
  }
}

let toastTimer = null;
function toast(message, isError = false) {
  const node = $("toast");
  node.textContent = message;
  node.classList.toggle("error", !!isError);
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), isError ? 5200 : 2800);
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

const state = {
  view: "home",          // home | grid | search | artists
  rows: [],
  zone: null,            // { uuid, name }
  rooms: [],
  album: null,           // the album open in the modal
  face: "album",         // album | np | queue
  npTab: "np",           // which tab the Now playing face is showing
  /* What the corner control does when leaving Now playing: "home" unwinds
     everything, "back" steps out one screen. A preference, set in Settings —
     see applyNpLeft(). */
  npLeft: "home",
  /* The Library screen's order, and the vocabulary the sheet is drawn from.
     Both come from the server — see loadSort(). */
  sort: null,
  sortOptions: [],
  /* Whether a text field has the soft keyboard up, which is the third thing
     that decides whether the mini bar is on screen — see trackTyping(). */
  typing: false,
  /* The shape of the track under the seek bar: the peaks themselves, which
     track they belong to, and a generation so a slow answer cannot land under
     a song that has already changed. See loadWaveform(). */
  wave: null,
  waveKey: "",
  waveReq: 0,
  /*
   * Choosing several albums at once. null when off; { ids: [...] } while on,
   * in the order they were tapped.
   *
   * It lives HERE, on the session, rather than on any screen — that is the
   * whole feature. Hold an album in one carousel, go back to Home, open
   * another row and carry on adding: the wall is rebuilt from scratch each
   * time and the selection is not, because nothing about it belongs to the
   * screen it was started on.
   */
  select: null,
  /* A hold just fired, so the click coming up behind the finger is that same
     gesture arriving late and must not also be treated as a tap. The same
     idiom the covers row and the Last.fm row use. */
  pickHeld: false,
  now: null,
  grid: null,            // the row on screen, and how far into it we have read
  seeking: false,
  volDragging: false,    // a finger is on the volume slider
  volPending: null,      // { level, until, zone } — asked for, not yet echoed
  pollTimer: null,
  scanTimer: null,
  coverTimer: null,      // the fast poll that runs only while a sweep does
  progressTimer: null,
  updateTimer: null,     // the poll watching an update through its restart
  positionAt: 0,
  build: null,
  /* The home screen's carousels: the order they were arranged in, and which
     are switched on. One list rather than two, because the order and the
     on/off state are two halves of one answer — see lib/settings.js.
     NOT `rows`, which is the home screen's built payload — {key, title,
     albums} — and a different thing entirely. */
  homeRows: [],
  rowTitles: {},
  homeStale: false,      // a favourite changed while Home sat behind the panel
  /*
   * The queue's own selection: POSITIONS, not album ids.
   *
   * Deliberately not state.select, which holds album ids and follows you from
   * one carousel to another. A queue position means nothing on any other
   * screen — and nothing on this one either once the queue has changed — so it
   * is cleared whenever the queue is re-read.
   */
  qsel: null,            // { at: [1, 4, 5] } while picking, else null
  covers: null,          // what the server last said about looking for covers
  identify: null,        // ditto, for saying which release an album is
  lastfm: null,          // what the server last said about the Last.fm account
  lastfmHeld: false,     // ditto, for the Last.fm row
  afterModal: null,      // a screen to open once the panel has closed itself
  checkedForUpdate: false
};

const ROW_TITLES = {
  favourites: "Favourites",
  library: "Library",
  random: "Random albums",
  added: "Recently added",
  played: "Recently played",
  unplayed: "Not played in 6 months",
  picks: "Smart Picks",
  /* Not a home row — see ROW_DEFS in index.js. It is here because this is what
     names a grid screen, and Missing covers is one. */
  nocover: "Missing covers"
};

/* What an empty row means. Reaching one of these screens from the side menu
   skips Home, so the copy cannot live only in the Home payload — an empty
   grid with no explanation reads as a fault, and neither of these is one. */
const ROW_EMPTY = {
  favourites: "No favourites yet. Tap the heart on an album to keep it here.",
  library: "No albums scanned yet. Check your music folder is mounted, then rescan.",
  nocover: "Every album has a cover.",
  random: "No albums scanned yet.",
  added: "No albums scanned yet.",
  played: "Nothing played yet. Play an album and it will appear here.",
  unplayed: "Nothing yet — this row fills once albums have gone six months unplayed.",
  picks: "Play a few albums and Smart Picks will follow what you listen to."
};

/* The chosen room outlives a reload — being asked which speaker you meant
   every time you open the app is the single most irritating thing a remote
   can do. */
function loadZone() {
  try {
    const raw = localStorage.getItem("musicd.zone");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }          // private mode, or a corrupted value
}
function saveZone(zone) {
  try {
    if (zone) localStorage.setItem("musicd.zone", JSON.stringify(zone));
    else localStorage.removeItem("musicd.zone");
  } catch { /* storage unavailable — the room still works for this session */ }
}

/* ------------------------------------------------------------------ */
/*  Navigation                                                         */
/* ------------------------------------------------------------------ */

/*
 * Everything that opens over the library goes on this stack, and the phone's
 * Back gesture pops it.
 *
 * The rule that makes it predictable: nothing closes itself. An on-screen
 * close control calls navBack(), which asks the browser to go back, and the
 * popstate handler below is the ONLY thing that actually closes a layer. One
 * path means the hardware Back and the on-screen one cannot drift apart — and
 * on an installed shortcut, Back closing the album you are looking at rather
 * than the whole app is the difference between the thing feeling native and
 * feeling like a web page.
 */
const nav = [];

function navOpen(name, close) {
  /* Re-opening a layer that is already the top one replaces it rather than
     stacking a second entry — tapping Queue then Now playing is one screen
     changing tabs, not two screens deep. */
  if (nav.length && nav[nav.length - 1].name === name) {
    nav[nav.length - 1].close = close;
    return;
  }
  nav.push({ name, close });
  history.pushState({ musicdDepth: nav.length }, "");
}

function navBack() {
  if (nav.length) history.back();
}

/* Unwind everything — the side menu's Home entry, which should land on the
   library however deep you were. */
function navReset() {
  if (nav.length) history.go(-nav.length);
}

window.addEventListener("popstate", (event) => {
  /* Reconciled against the depth the entry was pushed with rather than popping
     one per event: a held Back, or a jump of several entries, arrives as a
     single popstate and must close every layer it passed. */
  const depth = (event.state && event.state.musicdDepth) || 0;

  /*
   * TAKEN OFF THE STACK FIRST, CLOSED SECOND.
   *
   * A close callback is allowed to open something new — tapping an artist on
   * the album panel closes the panel and opens that artist's screen, which
   * pushes a layer of its own. A loop that re-read nav.length between closes
   * saw that new layer as one more thing to unwind and closed it again, so the
   * artist screen appeared and was immediately replaced by Home. Splicing
   * decides the work before any of it runs, and anything opened during it is
   * left alone.
   */
  const closing = nav.splice(depth).reverse();
  for (const layer of closing) {
    try { layer.close(); }
    catch { /* a layer whose DOM has already gone — nothing left to close */ }
  }
});

/* ------------------------------------------------------------------ */
/*  Choosing several albums at once                                    */
/* ------------------------------------------------------------------ */

/*
 * Hold an album to start choosing; tap the rest to add them.
 *
 * THE SELECTION OUTLIVES THE SCREEN. That is the point of it, and it is why
 * nothing here is stored on a wall, a row or a grid: hold an album in one
 * carousel, step back to Home, open a different row and keep adding to the
 * same set. Every screen is thrown away and rebuilt as you move between them,
 * so the cards are painted FROM the selection each time they are built rather
 * than the selection being read back off the cards.
 *
 * MusicD Remote arms the mode without choosing the album under the finger, on
 * the grounds that pressing something and having it become selected gives you
 * a selection you did not ask for. This does the opposite, as asked: the hold
 * is what says "this one, and more to come", and needing a second tap on the
 * album you are already holding would be a gesture that starts by doing
 * nothing.
 */

/* Longer than the row pads' 320ms, deliberately. A pad is a small control
   whose only job is to be held; an album card is the ordinary tap target of
   the whole app, and at 320ms an unhurried tap would start choosing albums. */
const PICK_HOLD_MS = 500;
/* The same eight pixels the row pads allow, stated here rather than borrowed
   from them: that one is a vertical drag inside a menu, this one is a hold on
   a card that a carousel can be flicked sideways from. */
const PICK_SLOP = 8;

const selecting = () => !!state.select;
const picked = (id) => !!state.select && state.select.ids.includes(id);

/*
 * The hold, in pointer events so one path covers a finger and a mouse — the
 * same shape as beginRowDrag() below.
 *
 * Movement cancels it, which is what keeps the carousels usable: a flick along
 * a row of albums starts on a card, and without the slop check every scroll
 * would end in select mode.
 */
/*
 * THE HOLD, once, for anything that can be picked.
 *
 * The album wall and the queue want the same gesture with different meanings,
 * and two copies of the slop handling would drift the first time either was
 * touched. `onHold` is what the caller does with it.
 */
function holdToPick(card, onHold) {
  let timer = null;
  const drop = () => { if (timer) { clearTimeout(timer); timer = null; } };

  card.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button > 0) return;      // right-click is not a hold
    const startX = e.clientX, startY = e.clientY;
    drop();
    timer = setTimeout(() => {
      timer = null;
      state.pickHeld = true;
      if (navigator.vibrate) navigator.vibrate(8);
      onHold();
    }, PICK_HOLD_MS);

    const move = (ev) => {
      if (Math.abs(ev.clientX - startX) > PICK_SLOP ||
          Math.abs(ev.clientY - startY) > PICK_SLOP) { drop(); done(); }
    };
    const done = () => {
      drop();
      card.removeEventListener("pointermove", move);
      for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
        card.removeEventListener(ev, done);
      }
    };
    card.addEventListener("pointermove", move);
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
      card.addEventListener(ev, done);
    }
  });

  /* A held card on a desktop otherwise opens the browser's own menu over the
     sleeve, and on iOS the image callout — both of them answering the gesture
     that was meant for us. */
  card.addEventListener("contextmenu", (e) => e.preventDefault());
}

function enterSelect(albumId) {
  state.select = { ids: [albumId] };
  paintSelection();
}

function togglePick(albumId) {
  if (!state.select) return;
  const ids = state.select.ids;
  const at = ids.indexOf(albumId);
  /* Tapping a chosen album again removes it. Without that the only way out of
     a mis-tap is Cancel and starting the whole selection again. */
  if (at === -1) ids.push(albumId);
  else ids.splice(at, 1);
  paintSelection();
}

/*
 * Leaving the mode. Cancel does it, and so does a finished action — a set of
 * albums that has just been played is not a set you are still choosing.
 */
function exitSelect() {
  state.select = null;
  paintSelection();
}

/*
 * Every card on the page, brought into line with the selection.
 *
 * Document-wide rather than scoped to a grid: Home's carousels, the search
 * results and an artist's albums are all cards outside #album-grid, and a
 * grid-scoped repaint would leave ticks behind on the screens the selection
 * was gathered from.
 */
function paintPicked() {
  for (const card of document.querySelectorAll(".album[data-album]")) {
    const on = picked(card.dataset.album);
    card.classList.toggle("is-picked", on);
    if (selecting()) card.setAttribute("aria-pressed", on ? "true" : "false");
    else card.removeAttribute("aria-pressed");
  }
}

function paintSelectBar() {
  const bar = $("select-bar");
  bar.classList.toggle("hidden", !selecting());
  if (!selecting()) return;
  const n = state.select.ids.length;
  $("select-count").textContent = n
    ? `${n} album${n === 1 ? "" : "s"} selected`
    : "Tap albums to select";
  /* With nothing chosen the mode is still on — Cancel is the documented way
     out — but there is nothing for the other two to act on. */
  $("select-play").disabled = !n;
  $("select-queue").disabled = !n;
}

/* The three things a change to the selection has to keep in step: the cards,
   the bar, and the mini transport the bar stands in for. */
function paintSelection() {
  paintPicked();
  paintSelectBar();
  syncMini();
}

async function playPicked(mode) {
  if (!selecting() || !state.select.ids.length) return;
  if (!await requireZone()) return;
  const ids = state.select.ids.slice();
  const buttons = [$("select-play"), $("select-queue")];
  for (const b of buttons) b.disabled = true;
  try {
    const result = await post("/api/play", { zone: state.zone.uuid, albumIds: ids, mode });
    const albums = `${ids.length} album${ids.length === 1 ? "" : "s"}`;
    toast(mode === "queue"
      ? `Added ${albums} to ${result.room}.`
      : (result.skipped
          ? `Playing ${albums} in ${result.room} — ${result.skipped} file(s) Sonos cannot play were skipped.`
          : `Playing ${albums} in ${result.room}.`));
    exitSelect();
    if (mode !== "queue") setTimeout(pollNow, 900);
  } catch (e) {
    toast(e.message, true);
    /* The selection is deliberately kept on a failure: the room was busy or the
       network dropped, and losing the albums somebody just picked one at a time
       would be the worse half of the two. */
    paintSelectBar();
  }
}

/* ------------------------------------------------------------------ */
/*  Album cards                                                        */
/* ------------------------------------------------------------------ */

/*
 * The artists named on one album line.
 *
 * Split on the separators tags actually use for a list — a semicolon, or a
 * slash with space around it. NOT on "&" and NOT on a comma: those live inside
 * real names, and splitting on them turns Earth, Wind & Fire into three
 * artists who have never recorded anything, and Simon & Garfunkel into two.
 * The cost of being conservative is a joined name occasionally left as one
 * link, which is a link that works; the cost of being greedy is links to
 * artists who do not exist.
 */
function splitArtists(artist) {
  return String(artist || "")
    .split(/\s*;\s*|\s+\/\s+/)
    .map(name => name.trim())
    .filter(Boolean);
}

/* Fill `host` with one tappable name per artist, and say how many there were
   so a caller can decide what to put after them. */
function renderArtistLinks(host, artist) {
  host.textContent = "";
  const names = splitArtists(artist);
  names.forEach((name, i) => {
    if (i) host.appendChild(document.createTextNode(", "));
    const link = el("button", "artist-link", name);
    link.type = "button";
    link.addEventListener("click", () => openArtist(name));
    host.appendChild(link);
  });
  return names;
}


function albumCard(album, { showReason = false } = {}) {
  const card = el("button", "album");
  card.type = "button";

  const wrap = el("div", "album-art-wrap");
  if (album.art) {
    const img = el("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.src = album.art;
    /* A cover that 404s (the file moved between a scan and now) must fall back
       to the placeholder rather than leaving a broken-image glyph. */
    img.addEventListener("error", () => { img.remove(); wrap.classList.add("no-image"); });
    wrap.appendChild(img);
  } else {
    wrap.classList.add("no-image");
  }

  /* Always built, shown by CSS only when this album is chosen. Painting it in
     and out as the selection changes would mean every repaint touching the
     card's children; a class on the card is one write. */
  const tick = el("span", "album-tick");
  tick.setAttribute("aria-hidden", "true");
  tick.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="20 6 9 17 4 12"/></svg>';
  wrap.appendChild(tick);

  const meta = el("div", "album-meta");
  meta.appendChild(el("div", "album-title", album.title));
  meta.appendChild(el("div", "album-artist", album.artist || "Unknown artist"));
  if (showReason && album.reason) meta.appendChild(el("div", "album-reason", album.reason));

  card.append(wrap, meta);

  /* The id on the element, so a selection that outlived this screen can find
     its cards again after the wall has been rebuilt — see paintPicked(). */
  card.dataset.album = album.id;
  if (picked(album.id)) card.classList.add("is-picked");
  if (selecting()) card.setAttribute("aria-pressed", picked(album.id) ? "true" : "false");

  card.addEventListener("click", () => {
    /* The hold already acted. The click behind it is the same gesture, and
       letting it through would toggle straight back off the album the hold
       just chose. */
    if (state.pickHeld) { state.pickHeld = false; return; }
    if (selecting()) return togglePick(album.id);
    openAlbum(album.id);
  });
  holdToPick(card, () => {
    if (selecting()) togglePick(album.id);
    else enterSelect(album.id);
  });
  return card;
}

function skeletonCard() {
  const card = el("div", "album skeleton");
  card.append(el("div", "album-art-wrap"), (() => {
    const m = el("div", "album-meta");
    m.append(el("div", "album-title", " "), el("div", "album-artist", " "));
    return m;
  })());
  return card;
}

/* ------------------------------------------------------------------ */
/*  The home screen's rows, arranged from the side menu                */
/* ------------------------------------------------------------------ */

/*
 * How long the pad has to be held before a drag starts.
 *
 * Long enough that scrolling the menu with a thumb that happens to land on a
 * pad still scrolls, short enough that it does not feel like the app is
 * ignoring you. Moving before it elapses cancels — that was a scroll.
 */
const DRAG_HOLD_MS = 320;
const DRAG_SLOP = 8;                     // movement that still counts as holding still

/* Rebuild the menu's row list from the order the server holds. */
async function loadMenuRows() {
  try {
    const { rows, titles } = await api("/api/rows");
    state.homeRows = rows || [];
    state.rowTitles = titles;
    renderMenuRows();
    renderHomeRows();
  } catch (e) {
    /* The menu still has Home, Library and Artists, and every row is reachable
       from the home screen itself, so this is a smaller loss than an empty
       menu. */
    console.warn("[rows] could not read the rows: " + e.message);
  }
}

/*
 * THE SIDE MENU'S ORDER IS FIXED, and it is not the home screen's.
 *
 * A menu whose entries move about is a menu you have to read rather than
 * reach for — the muscle memory of "Favourites is fourth" is worth more than
 * matching a home screen that is arranged for a different reason. Arranging
 * moved to Settings › Home screen; this list only ever answers WHICH of them
 * are on.
 *
 * Library and Artists are always here. Artists has no carousel to switch off,
 * and Library is the way into the whole collection — switching its carousel
 * off is a statement about the home screen, not about wanting to lose the
 * shelf.
 */
const MENU_ORDER = ["library", "artists", "favourites", "added", "picks",
                    "random", "unplayed", "played"];
const MENU_ALWAYS = new Set(["library", "artists"]);

function renderMenuRows() {
  const host = $("menu-rows");
  host.textContent = "";
  const on = new Set(state.homeRows.filter(r => r.on !== false).map(r => r.id));
  for (const key of MENU_ORDER) {
    /* A carousel somebody has switched off is not a place they want offered.
       The two staples stay whatever the home screen is doing. */
    if (!MENU_ALWAYS.has(key) && !on.has(key)) continue;
    const item = el("button", "menu-item",
                    key === "artists" ? "Artists" : (state.rowTitles[key] || key));
    item.type = "button";
    item.dataset.row = key;
    item.addEventListener("click", () => {
      closeMenu();
      if (key === "artists") openArtists();
      else openRow(key);
    });
    host.appendChild(item);
  }
}

/*
 * Settings › Home screen: which carousels show, and in what order.
 *
 * The same list the home screen loops, so a row cannot appear in one and not
 * the other. Each carries the pad that was on the menu entries until this
 * release, and a switch.
 */
function renderHomeRows() {
  const host = $("home-rows");
  if (!host) return;
  host.textContent = "";
  for (const row of state.homeRows) {
    const item = el("div", "home-row");
    item.dataset.row = row.id;

    const pad = el("button", "menu-grip");
    pad.type = "button";
    pad.setAttribute("aria-label", `Move ${state.rowTitles[row.id] || row.id}`);
    pad.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/>' +
      '<circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>' +
      '<circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
    pad.addEventListener("pointerdown", (e) => beginRowDrag(e, item));

    const name = el("span", "home-row-name", state.rowTitles[row.id] || row.id);

    const toggle = el("button", "toggle home-row-switch");
    toggle.type = "button";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", row.on !== false ? "true" : "false");
    toggle.setAttribute("aria-label", (state.rowTitles[row.id] || row.id) + " carousel");
    toggle.classList.toggle("is-on", row.on !== false);
    toggle.appendChild(el("span", "toggle-knob"));
    toggle.addEventListener("click", () => {
      /* Painted from the answer the server gives, not from the tap — the same
         rule the covers and radio switches follow. */
      saveHomeRows(state.homeRows.map(r =>
        r.id === row.id ? { id: r.id, on: r.on === false } : { id: r.id, on: r.on !== false }));
    });

    item.append(pad, name, toggle);
    host.appendChild(item);
  }
}

/*
 * Hold the pad, then drag.
 *
 * Pointer events rather than touch events, so one path covers a finger and a
 * mouse. The rows are moved in the DOM as the pointer passes their midpoints,
 * which is what makes the gap open where the row will land rather than after
 * it lands — there is no separate preview to keep in step with the list.
 */
function beginRowDrag(event, row) {
  if (event.button != null && event.button > 0) return;   // right-click is not a drag
  const host = $("home-rows");
  const pad = event.currentTarget;
  const startY = event.clientY;
  let dragging = false;

  const hold = setTimeout(() => {
    dragging = true;
    row.classList.add("is-dragging");
    host.classList.add("is-arranging");
    if (navigator.vibrate) navigator.vibrate(8);
  }, DRAG_HOLD_MS);

  const move = (e) => {
    if (!dragging) {
      /* Still deciding. Movement before the hold elapses was a scroll, not a
         drag, so let the menu have it. */
      if (Math.abs(e.clientY - startY) > DRAG_SLOP) cleanUp();
      return;
    }
    e.preventDefault();
    const over = [...host.querySelectorAll(".home-row")].find((other) => {
      if (other === row) return false;
      const box = other.getBoundingClientRect();
      return e.clientY >= box.top && e.clientY <= box.bottom;
    });
    if (!over) return;
    const box = over.getBoundingClientRect();
    const after = e.clientY > box.top + box.height / 2;
    host.insertBefore(row, after ? over.nextSibling : over);
  };

  const up = () => {
    const moved = dragging;
    cleanUp();
    if (!moved) return;
    const order = [...host.querySelectorAll(".home-row")].map((n) => n.dataset.row);
    if (order.join() === state.homeRows.map(r => r.id).join()) return;   // put back where it was
    /* Dropped somewhere new: the order changed and nothing else did, so each
       row keeps the switch it already had. */
    const on = new Map(state.homeRows.map(r => [r.id, r.on !== false]));
    saveHomeRows(order.map(id => ({ id, on: on.get(id) !== false })));
  };

  function cleanUp() {
    clearTimeout(hold);
    dragging = false;
    row.classList.remove("is-dragging");
    host.classList.remove("is-arranging");
    window.removeEventListener("pointermove", move, { capture: true });
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
  }

  /*
   * ON THE WINDOW, NOT ON THE PAD — and deliberately not with pointer capture.
   *
   * Capturing on the pad is the obvious way to keep a drag alive, and it is
   * wrong here: moving the row to its new place moves the pad with it, and
   * re-inserting a captured element releases the capture. The pad then stops
   * receiving anything and the drag dies one pixel in, which is exactly what
   * it did — lostpointercapture fired on the very first move. The window sees
   * every pointer wherever the DOM has been rearranged to.
   *
   * Not passive, because a held drag has to stop the menu scrolling under it.
   */
  window.addEventListener("pointermove", move, { capture: true, passive: false });
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  /* The pad itself is touch-action: none, so the gesture never becomes a
     scroll in the first place; this stops the press selecting or dragging the
     button on a desktop. */
  event.preventDefault();
}

/*
 * Saved whole, and painted from what came BACK.
 *
 * Both halves go together because the server keeps them together: sending an
 * order without the switches, or the other way round, is how the two drift
 * apart. The home screen behind the drawer is showing the old arrangement, so
 * it is told to rebuild — and the MENU is too, since switching a carousel off
 * takes its entry out of the list above.
 */
async function saveHomeRows(rows) {
  const previous = state.homeRows;
  state.homeRows = rows;
  renderHomeRows();
  try {
    const saved = await post("/api/rows", { rows });
    state.homeRows = saved.rows || rows;
    renderHomeRows();
    renderMenuRows();
    state.homeStale = true;
    if (state.view === "home") { state.homeStale = false; loadHome(); }
  } catch (e) {
    state.homeRows = previous;
    renderHomeRows();
    renderMenuRows();
    toast(e.message, true);
  }
}

/* ------------------------------------------------------------------ */
/*  Views                                                              */
/* ------------------------------------------------------------------ */

function showView(view, title) {
  if (view !== "grid") state.grid = null;
  /* One entry for "away from Home", however many browse screens you cross:
     Back from a grid, a search or an artist lands on the library, which is
     what the top-bar chevron has always done. */
  if (view !== "home") navOpen("view", goHomeView);
  state.view = view;
  for (const [name, id] of Object.entries({
    home: "home-view", grid: "grid-view", search: "search-view", artists: "artists-view"
  })) {
    $(id).classList.toggle("hidden", name !== view);
  }
  $("screen-title").textContent = title || "";
  $("topbar-back").classList.toggle("hidden", view === "home");
  /* The biography belongs to the artist screen, and every other grid — a home
     row opened in full — shares that screen's markup. Cleared HERE, once,
     rather than in each of the openers that do not want it: an opener that
     forgot would show the last artist's biography over a row of albums. */
  $("artist-info").textContent = "";
  $("artist-info").classList.add("hidden");
  /* Same reasoning for the sort bar, which belongs to the Library grid alone,
     and for the covers bar, which belongs to Missing covers. openRow() paints
     whichever the row it is opening owns. */
  $("sort-bar").classList.add("hidden");
  $("covers-bar").classList.add("hidden");
  window.scrollTo(0, 0);
}

/* Called by the navigation stack when a browse view is popped. */
function goHomeView() {
  state.homeStale = false;          // loadHome() below is the refresh it wanted
  $("search-input").value = "";
  $("topbar-search").classList.remove("is-open");
  document.querySelector(".topbar-row").classList.remove("searching");
  loadHome();
}

/* ---- Home -------------------------------------------------------- */

function renderHome(data) {
  const host = $("home-sections");
  host.textContent = "";
  state.rows = data.rows;

  for (const row of data.rows) {
    const section = el("section", "home-section");

    const heading = el("button", "home-section-link");
    heading.type = "button";
    heading.textContent = row.title;
    heading.addEventListener("click", () => openRow(row.key));
    section.appendChild(heading);

    if (row.albums.length) {
      const carousel = el("div", "home-carousel" + (row.key === "picks" ? " one-row" : ""));
      for (const album of row.albums) {
        carousel.appendChild(albumCard(album, { showReason: row.key === "picks" }));
      }
      section.appendChild(carousel);
    } else {
      section.appendChild(el("div", "home-carousel-empty",
        row.empty || "Nothing here yet."));
    }
    host.appendChild(section);
  }

  showView("home", "");
}

function homeSkeleton() {
  const host = $("home-sections");
  host.textContent = "";
  for (const key of ["library", "random", "added"]) {
    const section = el("section", "home-section");
    section.appendChild(el("h2", "home-section-title", ROW_TITLES[key]));
    const carousel = el("div", "home-carousel");
    for (let i = 0; i < 8; i++) carousel.appendChild(skeletonCard());
    section.appendChild(carousel);
    host.appendChild(section);
  }
}

async function loadHome() {
  homeSkeleton();
  try {
    renderHome(await api("/api/home"));
  } catch (e) {
    $("home-sections").textContent = "";
    banner("Could not load the library: " + e.message, true);
  }
}

/* ---- A full row -------------------------------------------------- */

/* How many albums a page of the grid holds. A library of any size arrives a
   page at a time as you scroll; a single capped request stopped at its limit
   and looked exactly like a scan that had missed the rest. */
const PAGE = 200;

/* Random and Smart Picks are computed per request, so a second page of either
   would repeat what is already on screen rather than continue it. Both are
   deliberately short rows and arrive complete. */
const PAGED_ROWS = new Set(["library", "added", "played", "unplayed", "nocover"]);

async function openRow(key) {
  showView("grid", ROW_TITLES[key] || "Albums");
  const grid = $("album-grid");
  const empty = $("grid-empty");
  grid.textContent = "";
  grid.classList.remove("is-sectioned");
  empty.classList.add("hidden");
  for (let i = 0; i < 18; i++) grid.appendChild(skeletonCard());

  state.grid = { key, offset: 0, done: false, loading: false, first: true };
  paintSortBar();
  paintCoversBar();
  await loadGridPage();
}

async function loadGridPage() {
  const g = state.grid;
  if (!g || g.loading || g.done) return;
  g.loading = true;

  const grid = $("album-grid");
  const empty = $("grid-empty");
  try {
    const data = await api(`/api/albums?row=${encodeURIComponent(g.key)}` +
                           `&limit=${PAGE}&offset=${g.offset}`);
    if (state.grid !== g) return;            // the user moved on while this was in flight
    if (g.first) { grid.textContent = ""; g.first = false; }

    for (const album of data.albums) {
      /* Smart Picks says why it picked an album; Missing covers says what the
         last automatic look made of one — "no artist to search on" is the
         difference between a wall of blank tiles and a wall somebody can act
         on. Same field, same line, two questions. */
      grid.appendChild(albumCard(album,
        { showReason: g.key === "picks" || g.key === "nocover" }));
    }
    g.offset += data.albums.length;
    /* A short page is the end of the row, and so is any page of a row that
       cannot be paged. */
    g.done = data.albums.length < PAGE || !PAGED_ROWS.has(g.key);

    if (!g.offset) {
      const note = state.rows.find(r => r.key === g.key);
      empty.textContent = (note && note.empty) || ROW_EMPTY[g.key] || "Nothing here yet.";
      empty.classList.remove("hidden");
    }
  } catch (e) {
    if (state.grid !== g) return;
    if (g.first) grid.textContent = "";
    empty.textContent = e.message;
    empty.classList.remove("hidden");
    g.done = true;
  } finally {
    g.loading = false;
  }
}

/*
 * Read the Missing covers wall again, if that is what is on screen.
 *
 * The one grid whose MEMBERSHIP changes under it: finding a cover — by sweep
 * or by hand — takes an album off it, and a wall still showing that album is a
 * list that lies. openRow() rather than a patch of the one card, because the
 * row's order is by artist and the count in the bar has moved too; and
 * re-opening a layer that is already on top replaces it rather than stacking
 * one, so this costs no history entry.
 */
function reloadCoversGrid() {
  if (state.view !== "grid" || !state.grid || state.grid.key !== "nocover") return;
  openRow("nocover");
}

/* Near the bottom of a grid, fetch the next page. A scroll listener rather than
   an IntersectionObserver because the grid has no trailing sentinel to observe
   and adding one would need removing again on every view change. */
function onScroll() {
  if (state.view !== "grid" || !state.grid || state.grid.done) return;
  const remaining = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
  if (remaining < window.innerHeight) loadGridPage();
}

/*
 * One artist's screen: the records they made, then the ones they turn up on.
 *
 * Two sections rather than one list, because they answer different questions —
 * "what did they make" and "where else will I hear them". The second is empty
 * far more often than not, and an empty heading is worse than no heading, so
 * it appears only when there is something under it.
 */
/*
 * Opening an artist from inside the album panel is a two-step move.
 *
 * The panel closes through the navigation stack, and that runs on popstate —
 * `history.back()` returns immediately and the layer is not gone until the
 * browser gets round to it. Closing and navigating in the same tick therefore
 * loses the race every time: the new screen paints, then the late pop unwinds
 * the layer under it and lands on Home. So the close does the opening.
 */
function openArtist(name) {
  if (!$("album-modal").classList.contains("hidden")) {
    state.afterModal = () => showArtist(name);
    closeModal();
    return;
  }
  showArtist(name);
}

async function showArtist(name) {
  showView("grid", name);
  loadInfo($("artist-info"), "artist:" + name,
    "/api/artist/" + encodeURIComponent(name) + "/info");
  /* An artist's albums arrive in one go, so there is no pager here — and a
     pager left over from the row the user came from would append that row's
     next page onto this screen. */
  state.grid = null;
  const grid = $("album-grid");
  grid.textContent = "";
  grid.classList.remove("is-sectioned");
  $("grid-empty").classList.add("hidden");
  try {
    const data = await api("/api/artist/" + encodeURIComponent(name));
    const sections = [
      ["Albums", data.albums || []],
      ["Appears on", data.appearsOn || []]
    ].filter(([, albums]) => albums.length);

    if (!sections.length) {
      $("grid-empty").textContent = "Nothing by this artist in the library.";
      $("grid-empty").classList.remove("hidden");
      return;
    }
    grid.classList.add("is-sectioned");
    for (const [title, albums] of sections) {
      /* The heading is skipped when there is only one section: a lone "Albums"
         over the only thing on the screen says nothing the title bar has not
         already said. */
      if (sections.length > 1) grid.appendChild(el("div", "grid-section", title));
      const row = el("div", "album-grid-inner");
      for (const album of albums) row.appendChild(albumCard(album));
      grid.appendChild(row);
    }
  } catch (e) {
    toast(e.message, true);
  }
}

/* ------------------------------------------------------------------ */
/*  How the Library screen is ordered                                  */
/* ------------------------------------------------------------------ */

/*
 * KEPT BY THE SERVER, NOT BY THIS PHONE.
 *
 * The order survives an update, a reboot and a restart because it lives in the
 * database — a browser's storage would lose it to a cleared cache or a re-added
 * home-screen shortcut, which is exactly the failure that reads as a
 * regression. It is shared between phones for the same reason the home rows'
 * order is: it describes the library, not the device.
 *
 * Fetched once at startup, so opening the Library screen costs no extra
 * request and the bar is right the first time it is painted.
 */
async function loadSort() {
  try {
    const data = await api("/api/sort");
    state.sort = data.view;
    state.sortOptions = data.options || [];
  } catch {
    /* Silent: the screen still works, in whatever order the server used. A
       toast at startup about a preference nobody has asked for yet would be
       the first thing a new install said. */
  }
  paintSortBar();
}

const sortDef = (id) => state.sortOptions.find(o => o.id === id) || null;

/* A seed the last one was not, so a reshuffle visibly reorders instead of
   repainting the same shuffle. The server clamps to 1..100000 and treats
   anything else as 1, which would silently mean "the same shuffle again". */
function nextSeed(current) {
  let seed = current;
  while (seed === current) seed = Math.floor(Math.random() * 100000) + 1;
  return seed;
}

/* What this order is CALLED in the direction it is in — "Newest first" and
   "Oldest first" are the same arrow on the same sort, so the label has to come
   from the option rather than from the word "descending". */
function sortDirLabel(view) {
  const def = sortDef(view && view.sort);
  if (!def || !def.directional) return "";
  return view.dir === "desc" ? def.desc : def.asc;
}

/*
 * The bar, on the Library screen and nowhere else.
 *
 * Every other grid IS an order: "Recently added" re-sorted by artist is a row
 * that no longer means what its name says, and a control that changes what a
 * screen is called is worse than no control.
 */
function paintSortBar() {
  const bar = $("sort-bar");
  const onLibrary = state.view === "grid" && state.grid && state.grid.key === "library";
  bar.classList.toggle("hidden", !onLibrary || !state.sort);
  if (!onLibrary || !state.sort) return;

  const def = sortDef(state.sort.sort);
  $("sort-label").textContent = def ? def.label : "Sort";
  $("sort-open").setAttribute("aria-label", "Sort by " + (def ? def.label : ""));

  const directional = !!(def && def.directional);
  /* Random has no direction, so the control becomes the only thing a shuffle
     needs: another shuffle. */
  $("sort-dir-label").textContent = directional ? sortDirLabel(state.sort) : "Shuffle";
  $("sort-dir").setAttribute("aria-label", directional
    ? "Direction — " + sortDirLabel(state.sort)
    : "Shuffle again");
}

/* Sent, stored, then repainted from what came BACK. The server decides what a
   valid view is, so painting from what was asked for could show an order the
   library is not actually in. */
async function saveSort(next) {
  try {
    const data = await post("/api/sort", next);
    state.sort = data.view;
    state.sortOptions = data.options || state.sortOptions;
  } catch (e) {
    toast(e.message, true);
    return;
  }
  /* The wall is re-read from the top: a new order makes every page boundary
     meaningless, and appending the next page of the old order underneath would
     interleave two sorts. openRow repaints the bar on its way through. */
  openRow("library");
}

function openSortSheet() {
  const host = $("sort-list");
  host.textContent = "";
  for (const option of state.sortOptions) {
    const row = el("button", "zone-row");
    row.type = "button";
    const on = !!(state.sort && state.sort.sort === option.id);
    row.classList.toggle("is-active", on);
    const label = el("span");
    label.appendChild(el("span", "", option.label));
    /* The chosen one says which way it is pointing. The others say nothing —
       promising a direction they have not been given yet would be a second
       thing to read on every row. */
    if (on && option.directional) {
      label.appendChild(el("span", "zone-sub", sortDirLabel(state.sort)));
    }
    row.appendChild(label);
    row.addEventListener("click", () => {
      closeSortSheet();
      if (on) return;                       // already this order: nothing to do
      /* A sort opens in ITS OWN default direction rather than keeping the last
         one: "sort by year" means newest first, and inheriting "A → Z" from the
         alphabetical sort would answer a different question. Leaving dir out is
         what asks the server for that default. */
      saveSort({ sort: option.id });
    });
    host.appendChild(row);
  }
  $("sort-sheet").classList.remove("hidden");
  navOpen("sheet", hideSortSheet);
}

function closeSortSheet() { navBack(); }
function hideSortSheet() { $("sort-sheet").classList.add("hidden"); }

/* ---- Artists ----------------------------------------------------- */

async function openArtists() {
  showView("artists", "Artists");
  const host = $("artist-list");
  host.textContent = "";
  try {
    const { artists } = await api("/api/artists");
    for (const a of artists) {
      const row = el("button", "artist-row");
      row.type = "button";
      row.appendChild(el("span", "", a.name));
      row.appendChild(el("span", "artist-count", `${a.albums} album${a.albums === 1 ? "" : "s"}`));
      row.addEventListener("click", () => openArtist(a.name));
      host.appendChild(row);
    }
    if (!artists.length) host.appendChild(el("div", "grid-empty", "No albums scanned yet."));
  } catch (e) {
    host.appendChild(el("div", "grid-empty", e.message));
  }
}

/* ---- Search ------------------------------------------------------ */

let searchTimer = null;

function runSearch(term) {
  clearTimeout(searchTimer);
  if (!term || term.trim().length < 2) {
    if (state.view === "search") showView("home", "MusicD");
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const results = await api("/api/search?q=" + encodeURIComponent(term));
      renderSearch(results, term);
    } catch (e) {
      toast(e.message, true);
    }
  }, 220);
}

function renderSearch(results, term) {
  showView("search", `“${term}”`);
  const host = $("search-results");
  host.textContent = "";

  const total = results.albums.length + results.artists.length + results.tracks.length;
  if (!total) {
    host.appendChild(el("div", "grid-empty", `Nothing in the library matches “${term}”.`));
    return;
  }

  /* Artists come FIRST, as a row of chips above the albums. An artist match is
     a place to go rather than a thing to look at, and burying it under a grid
     of album covers means the one tap that gets you their whole shelf is the
     one you have to scroll to find. */
  if (results.artists.length) {
    host.appendChild(el("div", "search-section-header", "Artists"));
    const row = el("div", "search-chip-row");
    for (const a of results.artists) {
      const chip = el("button", "search-chip");
      chip.type = "button";
      chip.appendChild(document.createTextNode(a.name));
      chip.appendChild(el("span", "chip-count", String(a.albums)));
      chip.addEventListener("click", () => openArtist(a.name));
      row.appendChild(chip);
    }
    host.appendChild(row);
  }

  if (results.albums.length) {
    host.appendChild(el("div", "search-section-header", "Albums"));
    const grid = el("div", "album-grid");
    for (const album of results.albums) grid.appendChild(albumCard(album));
    host.appendChild(grid);
  }

  if (results.tracks.length) {
    host.appendChild(el("div", "search-section-header", "Tracks"));
    for (const t of results.tracks) {
      const row = el("button", "result-row");
      row.type = "button";
      if (t.art) {
        const img = el("img", "result-art");
        img.src = t.art; img.alt = ""; img.loading = "lazy";
        row.appendChild(img);
      }
      const text = el("div", "result-text");
      text.append(el("div", "result-title", t.title),
                  el("div", "result-sub", [t.artist, t.album].filter(Boolean).join(" — ")));
      row.appendChild(text);
      row.addEventListener("click", () => openAlbum(t.albumId));
      host.appendChild(row);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Volume                                                             */
/* ------------------------------------------------------------------ */

/* The same control in two places: the mini bar's, and Now playing's. Every id
   is written out rather than built from the prefix, because the suite's check
   that app.js never reaches for an id the markup lacks reads literals — an id
   assembled at runtime is exactly the kind it cannot see. */
const VOL_SHEETS = [
  { sheet: "mt-vol-sheet", button: "mt-vol",     range: "mt-vol-range",
    value: "mt-vol-value", minus:  "mt-vol-minus", plus: "mt-vol-plus" },
  { sheet: "np-vol-sheet", button: "np-volbtn",  range: "np-vol-range",
    value: "np-vol-value", minus:  "np-vol-minus", plus: "np-vol-plus" }
];

/* What one tap of − or + moves. Sonos volume is a plain 0-100 integer and the
   slider steps by one, so the buttons do too: the slider is for getting
   roughly there, the buttons for the last little bit. */
const VOL_STEP = 1;

/* One writer for both sheets. They show the same speaker's volume, so a number
   painted into one and not the other is a bug waiting to be believed — open
   the other sheet and it would still say what the volume was a minute ago. */
function syncVolume(level) {
  const v = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  for (const ids of VOL_SHEETS) {
    const range = $(ids.range);
    range.value = v;
    range.style.setProperty("--vol-fill", v + "%");
    $(ids.value).textContent = v;
  }
}

/* Reading the level back off a slider is safe because syncVolume is the only
   thing that writes one, and the hold below keeps a poll from overwriting it
   mid-adjustment. */
function volumeNow() {
  return Number($(VOL_SHEETS[0].range).value) || 0;
}

/*
 * The volume you last ASKED for, held until the speaker says it agrees.
 *
 * A tap on + paints 51 and sends it, and the speaker needs a moment. Every
 * poll in between reports the pre-tap 50, and writing that back is the thumb
 * sliding away from the button you just pressed — up after −, down after +.
 * Guarding on the drag alone does not cover it: a tap has no drag.
 *
 * Held, not locked. It ends the moment the reading agrees, and lapses on its
 * own after VOL_ECHO_MS so a change made in the Sonos app or on the speaker
 * itself still reaches the slider.
 */
const VOL_ECHO_MS = 2500;

function holdVolume(level) {
  state.volPending = {
    level,
    until: Date.now() + VOL_ECHO_MS,
    zone: state.zone ? state.zone.uuid : null
  };
}

function volumeHeld() {
  if (state.volDragging) return true;
  if (!state.volPending) return false;
  return Date.now() <= state.volPending.until;
}

/* Retire a spent hold. Called once per poll, before the reading is painted —
   a hold belongs to the room it was taken for, so switching rooms inside the
   window must not leave the new room showing the old room's number. */
function settleVolumeHold(reported) {
  const held = state.volPending;
  if (!held) return;
  const zone = state.zone ? state.zone.uuid : null;
  if (held.zone !== zone || Date.now() > held.until || reported === held.level) {
    state.volPending = null;
  }
}

/* The two sheets are the same control in two places, so only ever one is open
   and closing means closing both. */
function closeVolSheet() {
  for (const ids of VOL_SHEETS) {
    $(ids.sheet).classList.add("hidden");
    $(ids.button).classList.remove("is-open");
    $(ids.button).setAttribute("aria-expanded", "false");
  }
}

function volSheetOpen() {
  return VOL_SHEETS.some(ids => !$(ids.sheet).classList.contains("hidden"));
}

async function sendVolume(level) {
  holdVolume(level);
  if (!state.zone) return;
  try { await post("/api/volume", { zone: state.zone.uuid, level }); }
  catch (e) { toast(e.message, true); }
}

/* A step paints first and sends after, so the reading answers the tap even
   though the speaker takes a moment to catch up. */
function stepVolume(delta) {
  const from = volumeNow();
  const next = Math.max(0, Math.min(100, from + delta * VOL_STEP));
  if (next === from) return;             // already at an end of the scale
  syncVolume(next);
  sendVolume(next);
}

function renderNow(now) {
  state.now = now;
  syncMini();

  if (!now || (!now.track && !now.foreign)) {
    /* Nothing playing. The bar stays, because it is how a room is chosen — so
       it says which room it would play to, or asks for one. */
    $("mt-title").textContent = state.zone ? "Nothing playing" : "Choose a room";
    $("mt-artist").textContent = state.zone ? state.zone.name : "";
    $("mt-art").classList.add("hidden");
    $("mt-fill").style.width = "0";
    setPlayIcons(false);
    $("mini").classList.add("is-idle");
    return;
  }
  $("mini").classList.remove("is-idle");

  const title = now.track ? now.track.title : "Playing from another app";
  const artist = now.track ? (now.track.artist || "") : now.zone.name;
  const album = now.album ? now.album.title : "";
  const art = now.album && now.album.art ? now.album.art : "";
  const playing = now.state === "PLAYING";

  /* Mini bar: the artist line carries the album too, which is the only place
     the bar has room to say what record this is. */
  $("mt-title").textContent = title;
  $("mt-artist").textContent = [artist, album].filter(Boolean).join(" · ");
  if (art) { $("mt-art").src = art; $("mt-art").classList.remove("hidden"); }
  else $("mt-art").classList.add("hidden");
  setPlayIcons(playing);

  /* Now playing face */
  $("np-track").textContent = title;
  /* Each artist is a way to the rest of their records, the same as on the
     album screen — and built the same way, so the two cannot drift about what
     counts as one artist. */
  renderArtistLinks($("np-artist"), artist);
  $("np-album").textContent = album;
  const npImg = $("np-img");
  if (art) { npImg.src = art; npImg.classList.remove("hidden"); }
  else { npImg.removeAttribute("src"); npImg.classList.add("hidden"); }

  $("np-seek").max = Math.max(1, Math.round(now.duration || 0));
  $("np-tot").textContent = mmss(now.duration);
  /* Before paintProgress below, so the first frame it draws already knows
     whether there is a waveform to split. */
  loadWaveform(now);
  /* Anchor the clock the ticker runs off, then let it do the drawing. */
  state.positionAt = Date.now();
  paintProgress();

  $("np-room").textContent = now.grouped
    ? `${now.coordinator.name} + ${now.members.length - 1}`
    : now.zone.name;

  /* PLAY MODES ARE NOT SHOWN. Shuffle and repeat were removed from this screen
     on request: an album is listened to in the order it was sequenced. The
     server still reads and reports both, and nothing here sets them — a mode
     set in the Sonos app is left exactly as it was rather than being silently
     corrected by a screen with no control for it. */

  settleVolumeHold(now.volume);
  if (now.volume !== null && !volumeHeld()) syncVolume(now.volume);
  for (const [vol, mute] of [["np-icon-vol", "np-icon-mute"], ["mt-icon-vol", "mt-icon-mute"]]) {
    $(vol).classList.toggle("hidden", !!now.muted);
    $(mute).classList.toggle("hidden", !now.muted);
  }
}

async function pollNow() {
  if (!state.zone) { renderNow(null); return; }
  try {
    const now = await api("/api/now?zone=" + encodeURIComponent(state.zone.uuid));
    renderNow(now.error ? null : now);
  } catch {
    /* A single failed poll is a speaker that was busy answering the app, not a
       reason to blank the screen. The next poll will correct it. */
  }
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (document.hidden) return;      // a backgrounded tab does not need the traffic
    pollNow();
  }, 4000);
  pollNow();
}

async function openNowPlaying(tab = "np") {
  if (!state.zone) { await openZoneSheet(); return; }
  setFace(tab);
  openModal();
  await pollNow();
  if (tab === "queue") loadQueue();
}

/*
 * The queue, as its own page.
 *
 * Sonos hands back the whole queue with a pointer at the current track, so
 * what is above that pointer has already been played. It is summarised rather
 * than listed: a queue that has run through two albums would otherwise open
 * scrolled past everything you can still act on.
 */
async function loadQueue() {
  const list = $("queue-list");
  const summary = $("queue-summary");
  const earlier = $("queue-earlier");
  const empty = $("queue-empty");

  list.textContent = "";
  earlier.textContent = "";
  empty.classList.add("hidden");
  summary.textContent = "Loading queue…";
  /* A selection describes POSITIONS in the queue that is about to be replaced
     by whatever the speaker now says, so it cannot survive the read. */
  qClearSelection();
  state.queueItems = [];
  if (!state.zone) { $("queue-clear-all").disabled = true; return; }

  try {
    const q = await api("/api/queue?zone=" + encodeURIComponent(state.zone.uuid));
    /* Kept so Play now can turn positions back into track ids without asking
       the speaker again for a list it was just given. */
    state.queueItems = q.items || [];
    $("queue-clear-all").disabled = !q.items.length;
    const current = Math.max(1, q.index || 1);
    const upcoming = q.items.filter(i => i.index >= current);
    const played = q.items.filter(i => i.index < current);

    if (!q.items.length) {
      summary.textContent = "";
      empty.classList.remove("hidden");
      return;
    }

    const remaining = upcoming.reduce((total, i) => total + (i.duration || 0), 0);
    summary.textContent = upcoming.length
      ? `${upcoming.length} track${upcoming.length === 1 ? "" : "s"} · ${mmss(remaining)} remaining`
      : "Nothing more queued";
    earlier.textContent = played.length
      ? `· ${played.length} played earlier`
      : "";

    for (const item of upcoming) {
      if (item.index === current) {
        const divider = el("li", "q-divider");
        divider.setAttribute("aria-hidden", "true");
        divider.append(el("span", "q-divider-line"),
                       el("span", "q-divider-label", "Now playing"),
                       el("span", "q-divider-line"));
        list.appendChild(divider);
      }
      list.appendChild(queueRow(item, item.index === current));
    }
  } catch (e) {
    summary.textContent = "";
    $("queue-clear-all").disabled = true;
    empty.textContent = e.message;
    empty.classList.remove("hidden");
  }
}

function queueRow(item, isNow) {
  const li = el("li");
  if (isNow) li.classList.add("is-now");

  const img = el("img", "q-art");
  img.alt = ""; img.loading = "lazy";
  if (item.art) img.src = item.art; else img.style.visibility = "hidden";

  const text = el("div", "q-text");
  text.append(el("div", "q-title", item.title),
              el("div", "q-sub", [item.artist, item.album].filter(Boolean).join(" · ")));

  li.append(img, text, el("span", "q-len", item.duration ? mmss(item.duration) : ""));
  li.dataset.at = String(item.index);
  if (qPicked(item.index)) li.classList.add("is-picked");
  if (qSelecting()) li.setAttribute("aria-pressed", qPicked(item.index) ? "true" : "false");

  /* Held: start picking, or add to what is already picked. The track already
     playing can be picked like any other — removing it is a thing somebody
     means, and Sonos moves on when it goes. */
  holdToPick(li, () => {
    if (qSelecting()) qToggle(item.index);
    else qEnter(item.index);
  });

  li.addEventListener("click", () => {
    /* The hold already acted, and the click arriving behind the finger is the
       same gesture — the rule the album wall follows, for the same reason. */
    if (state.pickHeld) { state.pickHeld = false; return; }
    if (qSelecting()) return qToggle(item.index);
    /* The track already playing is not a jump target. */
    if (!isNow) jumpTo(item);
  });
  return li;
}

/* ---- Picking tracks out of the queue ------------------------------ */

function qSelecting() { return !!state.qsel; }
function qPicked(at) { return !!state.qsel && state.qsel.at.includes(at); }

function qEnter(at) {
  state.qsel = { at: [at] };
  paintQueuePicks();
}

function qToggle(at) {
  if (!state.qsel) return;
  const list = state.qsel.at;
  const found = list.indexOf(at);
  if (found >= 0) list.splice(found, 1); else list.push(at);
  /* Nothing picked is not a mode worth being in — the bar would say "0" and
     every tap would be a jump nobody could make. */
  if (!list.length) state.qsel = null;
  paintQueuePicks();
}

function qClearSelection() {
  state.qsel = null;
  paintQueuePicks();
}

/*
 * The rows are painted FROM the selection, never the other way round — the
 * same rule the album wall follows, and what makes a re-read of the queue
 * simply drop a selection that no longer describes anything.
 */
function paintQueuePicks() {
  const on = qSelecting();
  $("qsel-bar").classList.toggle("hidden", !on);
  /* The bar stands where the mini transport does, so the mini transport goes.
     Without this it is drawn OVER the buttons: visible, and unpressable. */
  syncMini();
  for (const li of $("queue-list").children) {
    const at = Number(li.dataset.at);
    if (!at) continue;                       // the "Now playing" divider
    const picked = on && qPicked(at);
    li.classList.toggle("is-picked", picked);
    if (on) li.setAttribute("aria-pressed", picked ? "true" : "false");
    else li.removeAttribute("aria-pressed");
  }
  if (!on) return;
  /* Shorter than the album wall's wording on purpose: three buttons and a
     count is a tight bar on a phone, and "tracks" is not in doubt on a screen
     that is nothing but tracks. */
  const n = state.qsel.at.length;
  $("qsel-count").textContent = `${n} selected`;
}

/* What the picked positions are, in queue order rather than tap order — both
   removing and playing them want the record's own sequence. */
function qChosen() {
  return state.qsel ? [...state.qsel.at].sort((a, b) => a - b) : [];
}

async function qPlayNow() {
  const items = qChosen()
    .map(at => (state.queueItems || []).find(i => i.index === at))
    .filter(i => i && i.trackId);
  if (!items.length) return toast("Those tracks are not from this library.", true);
  try {
    await post("/api/play", {
      zone: state.zone.uuid, trackIds: items.map(i => i.trackId), mode: "play"
    });
    qClearSelection();
    setTimeout(() => { pollNow(); loadQueue(); }, 700);
  } catch (e) { toast(e.message, true); }
}

async function qRemove() {
  const at = qChosen();
  if (!at.length) return;
  try {
    await post("/api/queue", { zone: state.zone.uuid, action: "remove", indexes: at });
    qClearSelection();
    setTimeout(() => { pollNow(); loadQueue(); }, 500);
  } catch (e) { toast(e.message, true); }
}

async function qClearAll() {
  try {
    await post("/api/queue", { zone: state.zone.uuid, action: "clear" });
    qClearSelection();
    setTimeout(() => { pollNow(); loadQueue(); }, 500);
  } catch (e) { toast(e.message, true); }
}

async function jumpTo(item) {
  try {
    await post("/api/transport", { zone: state.zone.uuid, action: "seek_track", value: item.index });
    setTimeout(() => { pollNow(); loadQueue(); }, 700);
  } catch (e) {
    toast(e.message, true);
  }
}

/* ------------------------------------------------------------------ */
/*  Album modal                                                        */
/* ------------------------------------------------------------------ */

function b64url(s) {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/*
 * Three faces share the one panel: the album, Now playing, and the queue.
 *
 * The album face is reached from a card and gets a Back control. Now playing
 * and the queue are two TABS of one screen — they are the same thing seen two
 * ways, which is why the tabs appear only for them, and why the left-hand
 * control becomes Home there: you did not come from anywhere in particular.
 */
function setFace(face) {
  state.face = face;
  const onNp = face === "np" || face === "queue";
  if (onNp) state.npTab = face;

  /* The volume sheet belongs to the bar that opened it, and moving between
     screens can take that bar away — the mini bar is hidden on Now playing.
     A sheet left floating over a bar that is no longer there is the same
     mistake as the sheet being in flow, seen from the other side. */
  closeVolSheet();
  /* And the sleeve's menu belongs to the album face. Closed here rather than
     in both hideModal() and every opener: this runs on every face change,
     opening an album included, so there is one place that ends it. */
  closeAlbumMenu();

  /* The panel carries which face it is showing, because the Now playing
     layout is a different SHAPE, not just different contents — it fills the
     screen and never scrolls, and only CSS can express that. */
  const panel = $("album-modal");
  panel.classList.toggle("face-album", face === "album");
  panel.classList.toggle("face-np", face === "np");
  panel.classList.toggle("face-queue", face === "queue");

  $("album-face").classList.toggle("hidden", face !== "album");
  $("np-screen").classList.toggle("hidden", face !== "np");
  $("queue-pane").classList.toggle("hidden", face !== "queue");

  $("modal-tabs").classList.toggle("hidden", !onNp);
  paintModalLeft();
  /* One corner, two jobs: the heart belongs to an album, the share card to
     what is playing. */
  $("modal-fave").classList.toggle("hidden", onNp);
  $("modal-share").classList.toggle("hidden", !onNp);

  for (const tab of document.querySelectorAll(".modal-tab")) {
    tab.classList.toggle("is-active", tab.getAttribute("data-tab") === face);
  }
  $("album-modal").querySelector(".modal-panel").scrollTop = 0;
  syncMini();
}

/*
 * WHICH CONTROL SITS IN THE CORNER, AND WHY IT IS A CHOICE.
 *
 * The album face has always shown Back: you came from a card, and Back is
 * where you came from. Now playing showed Home, on the reasoning that you did
 * not come from anywhere in particular — the mini bar is on every screen, so
 * the face can be reached from anywhere and there is no obvious "back".
 *
 * That reasoning holds until somebody searches an artist, opens their albums,
 * taps the bar to see what is playing, and then wants to be back at the
 * artist. Home is exactly wrong there, and it is not wrong in general — so it
 * is a preference rather than a fix. Whichever is chosen, the OTHER control is
 * hidden: they share grid column 1 of the panel's header, and two controls in
 * one cell is one control on top of another.
 *
 * Both already do the right thing and neither needed changing: Back carries
 * data-close-modal, which pops one layer off the navigation stack, and Home
 * unwinds the whole of it.
 */
function paintModalLeft() {
  const onNp = state.face === "np" || state.face === "queue";
  const showBack = !onNp || state.npLeft === "back";
  $("modal-back").classList.toggle("hidden", !showBack);
  $("modal-home").classList.toggle("hidden", showBack);
}

/*
 * Whether the mini bar is on screen.
 *
 * Two conditions, and they are decided together because they disagree: there
 * has to be something playing, AND the Now playing face has to not be the one
 * showing — that face carries the full transport, so the bar would be a second
 * set of the same controls a centimetre below the first.
 */
function syncMini() {
  /* Always on screen, playing or not — it carries the room picker, and since
     the top bar no longer does, hiding the bar on a fresh install would leave
     nowhere to choose a speaker from. The one face that hides it is Now
     playing, which has the full transport on it already. */
  const onNpFace = state.face === "np" && !$("album-modal").classList.contains("hidden");
  /* And two more: not while the soft keyboard is up (see trackTyping() — the
     bar was always meant to be behind the keys, and being absent is the only
     version of that which no viewport can paint wrong), and not while albums
     are being chosen, because the selection bar is standing in its place. */
  /* …and while tracks are being picked out of the QUEUE, for the same reason:
     that selection has a bar of its own standing in the same place. */
  $("mini").classList.toggle("hidden",
    onNpFace || state.typing || selecting() || qSelecting());
}

function openModal() {
  $("album-modal").classList.remove("hidden");
  navOpen("modal", hideModal);
  syncMini();
}

/* The actual close, called only by the navigation stack. */
function hideModal() {
  $("album-modal").classList.add("hidden");
  closeVolSheet();
  state.face = "album";
  syncMini();

  /* Something asked to be opened once the panel was out of the way — an artist
     link, which cannot navigate while the panel is still on the stack. It takes
     over from here, so the Home refresh below is left to whenever Home is
     actually returned to. */
  const next = state.afterModal;
  state.afterModal = null;
  if (next) return next();

  if (state.homeStale && state.view === "home") {
    state.homeStale = false;
    loadHome();
  }
  /*
   * BACK FROM AN ALBUM LANDS ON THE WALL IT WAS OPENED FROM, and on the
   * Missing covers wall that is only half the promise: a cover found by hand
   * has taken that album off the list, and leaving its tile there says the
   * search did not work. `homeStale` is already the flag for "an album changed
   * while a wall sat behind this panel" — Home reads it above, and this is the
   * one grid whose contents it can change. It is left SET for Home, which has
   * not been repainted yet.
   */
  if (state.homeStale) reloadCoversGrid();
}
function closeModal() { navBack(); }

async function openAlbum(id) {
  try {
    const album = await api("/api/album/" + b64url(id));
    state.album = album;
    renderAlbum(album);
    setFace("album");
    openModal();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---- Favourites -------------------------------------------------- */

function setFave(on) {
  const button = $("modal-fave");
  button.classList.toggle("is-on", !!on);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.setAttribute("aria-label", on ? "Remove from favourites" : "Add to favourites");
  button.title = on ? "In favourites" : "Favourite";
}

/*
 * Marked here first, then on the server.
 *
 * A heart that waits for a round trip before it fills feels broken on a phone,
 * so the paint leads and the request follows; if the request fails the heart
 * goes back to what the server still thinks, which is the truth. The album
 * object is updated too, so leaving the screen and coming back does not show
 * the state the tap replaced.
 */
async function toggleFave(album) {
  const next = !album.favourite;
  album.favourite = next;
  setFave(next);
  try {
    await post("/api/favourite", { album: b64url(album.id), favourite: next });
    /* Favourites is a row on Home, and Home may be sitting behind this panel
       with the old row still painted on it. Leaving a browse screen already
       reloads Home; closing the panel does not, so it is told to. */
    state.homeStale = true;
  } catch (e) {
    album.favourite = !next;
    setFave(!next);
    toast(e.message, true);
  }
}

/* The copy of the record whose track list is on screen. An album with only
   one version answers with itself, which is why nothing else has to ask. */
function playing(album) {
  return (album && (album.selected || album.id)) || null;
}

/*
 * The version tabs.
 *
 * Switching one is NOT a navigation: the screen stays the same album, so this
 * refetches in place rather than pushing a layer, and Back still leaves the
 * album rather than walking through every version that was looked at. The
 * request is the same /api/album call the screen opened with — asking for a
 * version returns the same record with that version's track list, so one code
 * path paints both.
 */
function renderVersions(album) {
  const host = $("album-versions");
  host.textContent = "";
  const versions = album.versions || [];
  host.classList.toggle("hidden", versions.length < 2);
  if (versions.length < 2) return;

  const current = playing(album);
  for (const version of versions) {
    const tab = el("button", "version-tab", version.label);
    tab.type = "button";
    tab.setAttribute("role", "tab");
    const on = version.id === current;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.title = version.title;
    if (!on) {
      tab.addEventListener("click", async () => {
        try {
          const next = await api("/api/album/" + b64url(version.id));
          state.album = next;
          renderAlbum(next);
        } catch (e) { toast(e.message, true); }
      });
    }
    host.appendChild(tab);
  }
}

function renderAlbum(album) {
  const img = $("modal-img");
  if (album.art) { img.src = album.art; img.classList.remove("hidden"); }
  else { img.removeAttribute("src"); img.classList.add("hidden"); }

  $("modal-title").textContent = album.title;

  const subtitle = $("modal-subtitle");
  const names = renderArtistLinks(subtitle, album.artist);
  if (album.year) {
    subtitle.appendChild(document.createTextNode((names.length ? " · " : "") + album.year));
  }

  setFave(album.favourite);
  $("modal-fave").onclick = () => toggleFave(album);

  const bits = [
    `${album.trackCount} track${album.trackCount === 1 ? "" : "s"}`,
    runtime(album.duration)
  ];
  if (album.genre) bits.push(album.genre);
  const stats = [bits.join(" · ")];
  stats.push(`Added ${ago(album.addedAt)}`);
  stats.push(album.lastPlayedAt
    ? `Last played ${ago(album.lastPlayedAt)} · ${album.playCount} play${album.playCount === 1 ? "" : "s"}`
    : "Never played");
  $("modal-stats").innerHTML = "";
  for (const line of stats) $("modal-stats").appendChild(el("div", "", line));

  const list = $("track-list");
  list.textContent = "";
  /*
   * A NUMBER COLUMN ONLY WHERE THERE ARE NUMBERS.
   *
   * Decided once for the whole list rather than per row, so a record where one
   * file lost its tag does not have that one title sitting out of line with
   * the other eleven. Where no file carries a number at all — very common on a
   * rip whose numbering is in the filename, which is where the title comes
   * from too — the column was a stack of placeholder dots pushing every title
   * 38px in from a left edge that already had more air than the right.
   */
  const numbered = album.tracks.some(t => t.no);
  let disc = null;
  for (const track of album.tracks) {
    if (album.multiDisc && track.disc !== disc) {
      disc = track.disc;
      list.appendChild(el("li", "is-disc", `Disc ${disc}`));
    }
    const li = el("li");
    /* The server decides this — see lib/library.js. Working it out again here
       is how the two ended up disagreeing about Opus. */
    const unplayable = track.playable === false;
    if (unplayable) li.classList.add("is-unplayable");

    if (numbered) li.appendChild(el("span", "t-no", track.no ? String(track.no) : "·"));
    const text = el("div", "t-text");
    text.appendChild(el("div", "t-title", track.title));
    const sub = [];
    if (track.artist && track.artist !== album.artist) sub.push(track.artist);
    if (track.playCount) sub.push(`${track.playCount} play${track.playCount === 1 ? "" : "s"}`);
    text.appendChild(el("div", "t-sub", sub.join(" · ")));
    li.appendChild(text);

    if (unplayable) li.appendChild(el("span", "t-badge", "No Sonos"));
    li.appendChild(el("span", "t-len", mmss(track.duration)));

    /* Tapping a track plays the album FROM that track rather than the track
       alone — an album you started in the middle should keep going. */
    li.addEventListener("click", () => playAlbum(playing(album), album.tracks.indexOf(track)));
    list.appendChild(li);
  }
  $("tracks-label").textContent = album.multiDisc ? "Tracks" : `Tracks (${album.tracks.length})`;
  renderVersions(album);

  /* Keyed on album.id, which is the PRIMARY's — /api/album answers with the
     record's identity whichever version was asked for. So switching version
     tabs re-paints the same write-up rather than fetching a second one. */
  loadInfo($("album-info"), "album:" + album.id,
    "/api/album/" + b64url(album.id) + "/info");
}

/* ------------------------------------------------------------------ */
/*  What a record is, and who made it                                  */
/* ------------------------------------------------------------------ */

/*
 * ONE RENDERER, TWO SCREENS.
 *
 * An album's write-up and an artist's biography are the same object — some
 * prose, a source, a licence and a link — so they are painted by the same
 * function. The album's carries a second part, the critical reception, and
 * that is the only difference between them.
 */

/*
 * THE CREDIT IS NOT PART OF WHAT COLLAPSES.
 *
 * Wikipedia and Last.fm both give their prose away on one condition: that it
 * is credited and linked. So the credit line sits OUTSIDE the clamped text and
 * is painted before it — a licence that is only visible after somebody presses
 * "Read more" is a licence that is usually not visible at all.
 */
function creditFor(info) {
  const line = el("p", "info-credit");
  line.appendChild(document.createTextNode("From "));
  const link = el("a", "", info.source === "lastfm" ? "Last.fm" : "Wikipedia");
  link.href = info.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  line.appendChild(link);
  if (info.title) {
    /* What the SOURCE calls it, which is not always what the library does:
       "Hex (Bark Psychosis album)" is the article, "Hex" is the record. Saying
       so is how somebody spots a wrong match. */
    line.appendChild(document.createTextNode(" · " + info.title));
  }
  if (info.licence) line.appendChild(document.createTextNode(" · " + info.licence));
  return line;
}

/* Paragraphs, not one block of text with newlines in it — an article's blank
   lines are paragraph breaks and reading them as spaces makes a wall. */
function prose(text, cls) {
  const host = el("div", cls);
  for (const para of String(text || "").split(/\n{2,}/)) {
    const line = para.trim();
    if (line) host.appendChild(el("p", "", line));
  }
  return host;
}

function renderInfo(host, info) {
  host.textContent = "";
  host.classList.toggle("hidden", !info || !info.summary);
  host.classList.remove("is-open");
  if (!info || !info.summary) return;

  const body = el("div", "info-body");
  body.appendChild(prose(info.summary, "info-summary"));
  if (info.review) {
    body.appendChild(el("div", "section-label", "Critical reception"));
    body.appendChild(prose(info.review, "info-review"));
  }
  host.appendChild(body);

  /* The button appears only when there is something folded away. A "Read more"
     over three lines that are all already on screen is a control that does
     nothing, and this is measured after the paint rather than guessed from the
     character count — the same text is two lines on a tablet and six on a
     phone. */
  const more = el("button", "info-more", "Read more");
  more.type = "button";
  more.addEventListener("click", () => {
    const open = host.classList.toggle("is-open");
    more.textContent = open ? "Show less" : "Read more";
  });
  host.appendChild(more);
  host.appendChild(creditFor(info));

  requestAnimationFrame(() => {
    more.classList.toggle("hidden", body.scrollHeight <= body.clientHeight + 4);
  });
}

/*
 * Fetched when the screen opens, and never blocking it.
 *
 * `state.infoFor` is which write-up the app currently wants. An answer that
 * comes back for anything else is dropped: the album screen can be closed and
 * another one opened while a request is still out, and painting a late answer
 * onto the screen that replaced it is how the wrong band's biography ends up
 * under the right band's albums.
 */
async function loadInfo(host, key, path) {
  host.textContent = "";
  host.classList.add("hidden");
  state.infoFor = key;
  try {
    const data = await api(path);
    if (state.infoFor !== key) return;
    renderInfo(host, data.info);
  } catch {
    /* Silent on purpose, and the one place in this app where that is right: a
       write-up is not what anybody opened the screen for, and a toast about a
       failed biography would interrupt somebody who came here to press play. */
  }
}

/* ------------------------------------------------------------------ */
/*  The overflow menu on the sleeve                                    */
/* ------------------------------------------------------------------ */

/*
 * A MENU, NOT A PLACE YOU WENT.
 *
 * Off the navigation stack, for the same reason the side menu is: a history
 * entry for it would mean the phone's Back gesture dismissed a popup instead
 * of leaving the album — and choosing Edit would then have to unwind that
 * entry and open a dialog in the same breath, which is exactly the ordering
 * the artist link needed state.afterModal to get right. It is dismissed by its
 * own catch, by Escape, or by picking something off it.
 */
function albumMenuOpen() { return !$("album-menu").classList.contains("hidden"); }

function openAlbumMenu() {
  $("album-menu").classList.remove("hidden");
  $("album-more").setAttribute("aria-expanded", "true");
}

function closeAlbumMenu() {
  $("album-menu").classList.add("hidden");
  $("album-more").setAttribute("aria-expanded", "false");
}

/* ------------------------------------------------------------------ */
/*  Correcting the album's name                                        */
/* ------------------------------------------------------------------ */

/*
 * The album the open dialog belongs to.
 *
 * Held here rather than read back off the panel when Save is pressed: the
 * version tabs refetch in place, so what the screen is showing can change
 * under a dialog that is already open.
 */
let editing = null;
/* True from the moment Save is sent until the answer is back. Enter in a field
   does not go through the button, so the button being disabled does not stop a
   second press — see saveEdit(). */
let savingEdit = false;

/* ------------------------------------------------------------------ */
/*  Looking for a cover by hand                                        */
/* ------------------------------------------------------------------ */

/*
 * IN THE SAME DIALOG THE NAME IS CORRECTED IN, and that is the point.
 *
 * The background sweep refuses to search for an album whose files name no
 * artist — there is no query that would not match half a catalogue — so the
 * albums it leaves behind are very often the ones somebody would have to name
 * by hand anyway. Type the artist, press Find, choose the sleeve.
 *
 * The search uses what is IN THE FIELDS rather than what is saved, so a
 * correction can be tried before it is committed.
 *
 * A candidate is chosen by its POSITION in the list the server just handed
 * over, never by its URL. A server that will fetch a URL a client gives it is
 * an open proxy onto the network it sits in.
 */

function resetCoverSearch() {
  const grid = $("edit-grid"), why = $("edit-why");
  grid.textContent = "";
  grid.classList.add("hidden");
  why.textContent = "";
  why.classList.add("hidden");
  $("edit-find").disabled = false;
  $("edit-find").textContent = "Find cover";

  const matches = $("edit-matches");
  matches.textContent = "";
  matches.classList.add("hidden");
  $("edit-identify").disabled = false;
  $("edit-identify").textContent = "Identify";
}

/*
 * WHICH RECORD THIS ALBUM IS, said in one line.
 *
 * A confirmation and a tag are different answers and the line says which: a
 * person about to change one wants to know whether they are overruling a file
 * or their own earlier tap.
 */
function paintIdentity(current) {
  const on = !!(state.identify && state.identify.available);
  $("edit-ident").classList.toggle("hidden", !on);
  if (!on) return;
  const c = current || {};
  $("edit-ident-now").textContent =
    c.from === "chosen" ? "Confirmed — covers for this album are exact. Identify again to change it."
    : c.from === "tags" ? "Your files already name a release, so covers for this album are exact."
    : "Not identified. Covers are searched for by name, which is how the wrong sleeve arrives.";
}

let coverReq = 0;

async function findCovers() {
  if (!editing) return;
  /* Newest answer wins — see findMatches() above. */
  const mine = ++coverReq;
  const button = $("edit-find");
  const grid = $("edit-grid"), why = $("edit-why");
  button.disabled = true;
  button.textContent = "Looking…";
  grid.textContent = "";
  grid.classList.add("hidden");
  why.classList.add("hidden");
  try {
    const query = "?title=" + encodeURIComponent($("edit-title").value.trim()) +
                  "&artist=" + encodeURIComponent($("edit-artist").value.trim());
    const out = await api("/api/album/" + b64url(playing(editing)) + "/covers" + query);
    if (mine !== coverReq) return;
    const found = (out && out.candidates) || [];
    if (!found.length) {
      /* The reason the sweep recorded, where there is one — otherwise a plain
         "nothing", which is still an answer and better than an empty grid. */
      why.textContent = out && out.reason
        ? "Nothing found. The last automatic search said: " + out.reason
        : "Nothing found for that name. Try the artist as it is spelled on the record.";
      why.classList.remove("hidden");
      return;
    }
    for (const cand of found) {
      const cell = el("button", "edit-cand");
      cell.type = "button";
      cell.setAttribute("aria-label", "Use this cover from " + cand.source);
      const img = el("img");
      img.loading = "lazy";
      img.alt = "";
      img.src = cand.thumb;
      /* A candidate whose thumbnail will not load is one whose full image
         probably will not either, so it is removed rather than left as a hole
         somebody can still press. When the LAST one goes — a release the Cover
         Art Archive knows by name but holds no picture for — the dialog says
         so, because a grid that appears and then empties itself reads as the
         app breaking rather than as an answer. */
      img.addEventListener("error", () => {
        cell.remove();
        if (grid.children.length) return;
        grid.classList.add("hidden");
        why.textContent = "Nothing usable came back — the covers offered could not be loaded.";
        why.classList.remove("hidden");
      });
      cell.appendChild(img);
      cell.appendChild(el("span", "edit-cand-src", cand.source));
      cell.addEventListener("click", () => chooseCover(cand.i, cell));
      grid.appendChild(cell);
    }
    grid.classList.remove("hidden");
  } catch (e) {
    if (mine !== coverReq) return;
    why.textContent = e.message;
    why.classList.remove("hidden");
  } finally {
    if (mine === coverReq) {
      button.disabled = false;
      button.textContent = "Find cover";
    }
  }
}

/*
 * Ask MusicBrainz which releases this could be.
 *
 * Searched with what is IN THE FIELDS rather than what is saved — the same
 * rule Find cover follows above, and for the same reason: the albums worth
 * identifying are the ones whose stored names are wrong, and correcting the
 * name in the box is how somebody says so.
 */
let matchReq = 0;

async function findMatches() {
  if (!editing) return;
  /*
   * WHOSE ANSWER IS THIS. A slow request that finally fails lands after a
   * newer one has already painted — which is how "This operation was aborted"
   * came to sit above a list of results that had arrived perfectly well. The
   * same discipline loadGridPage() uses: anything but the newest is dropped.
   */
  const mine = ++matchReq;
  const button = $("edit-identify");
  const host = $("edit-matches");
  button.disabled = true;
  button.textContent = "Looking…";
  host.textContent = "";
  host.classList.add("hidden");
  try {
    const query = "?title=" + encodeURIComponent($("edit-title").value.trim()) +
                  "&artist=" + encodeURIComponent($("edit-artist").value.trim());
    const out = await api("/api/album/" + b64url(playing(editing)) + "/identify" + query);
    if (mine !== matchReq) return;
    paintIdentity(out.current);
    const found = (out && out.candidates) || [];
    if (!found.length) {
      $("edit-ident-now").textContent =
        "No release matched that name and artist. Correct them above and look again.";
      return;
    }
    for (const match of found) {
      const row = el("button", "edit-match");
      row.type = "button";
      row.appendChild(el("span", "edit-match-name", match.title));
      row.appendChild(el("span", "edit-match-why",
        [match.artist, match.why].filter(Boolean).join(" · ")));
      /* The one fact a person can check at a glance without knowing anything
         about MusicBrainz. */
      if (match.sameLength) {
        row.appendChild(el("span", "edit-match-fit", "Same number of tracks as your folder"));
      }
      row.addEventListener("click", () => chooseMatch(match.i, row));
      host.appendChild(row);
    }
    host.classList.remove("hidden");
  } catch (e) {
    if (mine === matchReq) $("edit-ident-now").textContent = e.message;
  } finally {
    if (mine === matchReq) {
      button.disabled = false;
      button.textContent = "Identify";
    }
  }
}

let choosingMatch = false;

/* By POSITION, never by id — the server holds the list it offered. */
async function chooseMatch(index, row) {
  if (choosingMatch || !editing) return;
  choosingMatch = true;
  row.classList.add("is-busy");
  try {
    const out = await post("/api/album/" + b64url(playing(editing)) + "/identify", { index });
    const host = $("edit-matches");
    host.textContent = "";
    host.classList.add("hidden");
    paintIdentity(out.current);
    toast("Release confirmed. Find cover will be exact now.");
  } catch (e) {
    toast(e.message, true);
    row.classList.remove("is-busy");
  } finally {
    choosingMatch = false;
  }
}

let choosingCover = false;

async function chooseCover(index, cell) {
  /* One at a time. Two taps on two sleeves would race to be the album's
     cover and the loser would still have downloaded an image. */
  if (choosingCover || !editing) return;
  choosingCover = true;
  cell.classList.add("is-busy");
  try {
    await post("/api/album/" + b64url(playing(editing)) + "/cover", { index });
    toast("Cover saved.");
    /* Re-read and repaint, the same way a corrected NAME does — the panel is
       showing the placeholder this just replaced, and the album may be a
       version, so the refetch asks for what is actually on screen. */
    const next = await api("/api/album/" + b64url(playing(editing)));
    state.album = next;
    renderAlbum(next);
    /* The wall behind the panel and the home rows are still showing the empty
       tile; this is the flag that has them re-read on the way back. */
    state.homeStale = true;
    editing = null;
    closeEditDialog();
  } catch (e) {
    toast(e.message, true);
    cell.classList.remove("is-busy");
  } finally {
    choosingCover = false;
  }
}

function openEditDialog() {
  const album = state.album;
  if (!album) return;
  closeAlbumMenu();
  editing = album;

  /* Prefilled with the name ON SHOW, which is the corrected one where there
     is a correction — the field has to open saying what the screen says, or
     the first thing it does is offer to undo an edit nobody asked to undo. */
  const tags = album.tags || { title: album.title, artist: album.artist };
  const title = $("edit-title"), artist = $("edit-artist");
  title.value = album.title || "";
  artist.value = album.artist || "";
  /* The placeholder is what the field falls back to when it is left empty:
     what the file tags say. An album whose files name no artist at all shows
     the same two words the card shows rather than an empty hint. */
  title.placeholder = tags.title || "";
  artist.placeholder = tags.artist || "Unknown artist";
  /* What this album is believed to BE, painted from what the album screen was
     already given rather than from a request of its own. */
  paintIdentity(album.identity);

  $("edit-err").classList.add("hidden");
  $("edit-save").disabled = false;
  /* The cover half starts closed every time. Leaving the last album's results
     up would offer somebody another record's sleeves for this one. */
  resetCoverSearch();
  $("edit-overlay").classList.remove("hidden");
  navOpen("edit", hideEditDialog);
  /* Focused on a pointer, never on a phone. The album's title is usually the
     right one already — the artist is what people come here to fix — so a
     keyboard raised over the fields before either has been chosen covers the
     dialog to answer a question nobody asked. */
  if (window.matchMedia("(min-width: 720px)").matches) title.focus();
}

function closeEditDialog() { navBack(); }

/* The actual close, called only by the navigation stack. */
function hideEditDialog() {
  $("edit-overlay").classList.add("hidden");
  editing = null;
}

/*
 * SAVED, THEN RE-READ.
 *
 * The heart paints first and asks the server afterwards, because a heart that
 * waits for a round trip feels broken. A name is the other way round: the
 * server decides whether what was typed is a correction at all or the tags
 * typed back, and painting a guess would show a correction that was never
 * stored. So this waits, then refetches the album and repaints from the
 * answer.
 */
async function saveEdit() {
  /*
   * TWO GUARDS, BECAUSE ENTER DOES NOT GO THROUGH THE BUTTON.
   *
   * Disabling the button stops a second tap and nothing else: a second Enter
   * while the first save is still in flight would post the same correction
   * twice and then call navBack() twice, which unwinds TWO layers — the
   * dialog and the album screen behind it. So an in-flight save is refused,
   * and a finished one has already let go of the album it belonged to.
   */
  if (!editing || savingEdit) return;
  savingEdit = true;
  const button = $("edit-save");
  const err = $("edit-err");
  button.disabled = true;
  err.classList.add("hidden");
  try {
    await post("/api/album/name", {
      album: b64url(editing.id),
      title: $("edit-title").value,
      artist: $("edit-artist").value
    });
    /* The panel may be showing a VERSION while the correction went to the
       primary, so the refetch asks for what was on screen — the same call the
       version tabs make, which returns the record with that version's tracks
       and the primary's name. */
    const next = await api("/api/album/" + b64url(playing(editing)));
    state.album = next;
    renderAlbum(next);
    /* Let go before the close, not after it: the close is a history.back() and
       the dialog is not actually hidden until the popstate arrives, which
       leaves a window where a stray Enter would still find something to save. */
    editing = null;
    closeEditDialog();
    /* Every row on Home carries this album's name on a card. Leaving a browse
       screen already reloads Home; closing the panel does not, so it is told
       to — the same reason the heart says it. */
    state.homeStale = true;
    toast("Saved.");
  } catch (e) {
    /* On the dialog rather than in a toast: the dialog stays open so the name
       can be corrected and sent again, and a message that floats away from the
       fields it is about is one the user has to remember. */
    err.textContent = e.message;
    err.classList.remove("hidden");
  } finally {
    /* Cleared whatever happened — a save that failed has to be retryable, and
       `editing` is what says whether there is still anything to retry. */
    savingEdit = false;
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Playing                                                            */
/* ------------------------------------------------------------------ */

async function requireZone() {
  if (state.zone) return state.zone;
  await openZoneSheet();
  return null;
}

async function playAlbum(albumId, startIndex = 0) {
  if (!await requireZone()) return;
  const btn = $("btn-play");
  btn.disabled = true;
  try {
    const result = await post("/api/play", {
      zone: state.zone.uuid, albumId, startIndex, mode: "play"
    });
    toast(result.skipped
      ? `Playing in ${result.room} — ${result.skipped} file(s) Sonos cannot play were skipped.`
      : `Playing in ${result.room}.`);
    setTimeout(pollNow, 900);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function queueAlbum(albumId) {
  if (!await requireZone()) return;
  try {
    const result = await post("/api/play", { zone: state.zone.uuid, albumId, mode: "queue" });
    toast(`Added ${result.queued} track${result.queued === 1 ? "" : "s"} to ${result.room}.`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function transport(action, value) {
  if (!state.zone) { await openZoneSheet(); return; }
  try {
    await post("/api/transport", { zone: state.zone.uuid, action, value });
    setTimeout(pollNow, 600);
  } catch (e) {
    toast(e.message, true);
  }
}

/* ------------------------------------------------------------------ */
/*  Now playing                                                        */
/* ------------------------------------------------------------------ */

function setPlayIcons(playing) {
  for (const [play, pause] of [["np-icon-play", "np-icon-pause"], ["mt-icon-play", "mt-icon-pause"]]) {
    $(play).classList.toggle("hidden", playing);
    $(pause).classList.toggle("hidden", !playing);
  }
}

/*
 * The progress bar runs on a clock, not on the poll.
 *
 * Position only arrives when the speaker is asked for it, every few seconds,
 * and painting it only then made the bar sit still and then jump — a visual
 * stutter over perfectly smooth playback. The last answer is kept with the
 * time it arrived, and the bar is drawn from that plus however long ago it
 * was, four times a second. Each poll re-anchors it, so it can drift by at
 * most one poll's worth and never accumulates error.
 */
function paintProgress() {
  const now = state.now;
  if (!now || !now.track) return;

  const elapsed = now.state === "PLAYING" ? (Date.now() - state.positionAt) / 1000 : 0;
  const position = Math.min(now.duration || 0, (now.position || 0) + elapsed);

  $("mt-fill").style.width = now.duration ? `${(position / now.duration) * 100}%` : "0";

  /* Not while a finger is on the seek bar — the poll must not yank the thumb
     out from under it. */
  if (state.seeking) return;
  const seek = $("np-seek");
  seek.value = Math.round(position);
  /* The waveform carries the same progress, from the same number, so the two
     can never disagree about where the track is. Drawn FIRST because this is
     what adds and removes .has-wave, which fillRange() reads. */
  drawWave(position);
  fillRange(seek, position, Number(seek.max) || 1);
  $("np-cur").textContent = mmss(position);
}

function startProgressTicker() {
  clearInterval(state.progressTimer);
  state.progressTimer = setInterval(() => {
    if (document.hidden) return;      // nothing to paint behind another app
    paintProgress();
  }, 250);
}

function fillRange(input, value, max) {
  /*
   * WITH A WAVEFORM SHOWING, THE PROPERTY IS REMOVED RATHER THAN OVERRIDDEN.
   *
   * The stylesheet says `--fill: transparent` for .has-wave and that alone does
   * nothing: this function writes --fill INLINE four times a second, and an
   * inline custom property beats any stylesheet rule however specific. Setting
   * it here unconditionally is what drew a grey line straight through the
   * middle of the waveform in MusicD Remote v1.7.90 — both halves are needed,
   * and this is the half that is easy to leave out.
   *
   * Asked HERE rather than at the two call sites, so there is one place that
   * knows and they cannot drift.
   */
  const host = input.closest(".np-progress");
  if (host && host.classList.contains("has-wave")) {
    input.style.removeProperty("--fill");
    return;
  }
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  input.style.setProperty("--fill",
    `linear-gradient(90deg, var(--accent) 0 ${pct}%, var(--border) ${pct}% 100%)`);
}

/* ------------------------------------------------------------------ */
/*  The shape of the track                                             */
/* ------------------------------------------------------------------ */

/*
 * The waveform under the seek bar.
 *
 * DECORATION UNDER THE RANGE INPUT, never a replacement for it. The input keeps
 * the drag, the keyboard, the thumb and the disabled state; if the fetch fails,
 * the canvas is unsupported, or the file cannot be decoded, what is left is
 * exactly the bar that was there before this existed.
 *
 * Every file this server plays is a local file, so unlike MusicD Remote — which
 * has to keep a plain bar for the Qobuz and TIDAL tracks Roon never hands an
 * extension any audio for — there is no second case to carry here.
 */

function drawWave(at) {
  const canvas = $("np-wave"), host = $("np-progress");
  const peaks = state.wave;
  if (!peaks || !peaks.length) {
    canvas.classList.add("hidden");
    host.classList.remove("has-wave");
    return;
  }
  canvas.classList.remove("hidden");
  host.classList.add("has-wave");

  /* Size the backing store to the DEVICE pixels actually on screen, or the bars
     are soft on every phone made in the last decade. */
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth));
  const h = Math.max(1, Math.round(canvas.clientHeight));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  /* No 2d context is a browser this cannot draw on. The plain bar is already
     underneath, so there is nothing to report and nothing to fall back to. */
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cs = getComputedStyle(document.documentElement);
  const played = cs.getPropertyValue("--accent").trim();
  /* The track ahead is drawn in the TEXT colour rather than the border colour:
     it is the shape of the music and it should be as legible as the title above
     it. Both are tokens, so both follow the theme. */
  const ahead = cs.getPropertyValue("--text").trim();

  const seek = $("np-seek");
  const max = Number(seek.max) || 0;
  const pos = Number.isFinite(at) ? at : (Number(seek.value) || 0);
  const frac = max > 0 ? Math.max(0, Math.min(1, pos / max)) : 0;

  /*
   * WHERE THE THUMB ACTUALLY IS, which is not frac * width.
   *
   * A range input cannot let its thumb hang off either end, so the CENTRE
   * travels from thumbW/2 to width - thumbW/2 rather than from 0 to width.
   * Colouring the bars at frac * width instead put the dot half a thumb AHEAD
   * of the shape at the start and half a thumb behind it at the end — measured
   * at +6px, +3, 0, -3, -6 across a track, which reads as the waveform failing
   * to keep up. Zero in the middle, which is why it survived being looked at.
   */
  /* Read from the PROGRESS block, which is where it is declared — a custom
     property inherits downward, and documentElement is its ancestor rather
     than its descendant, so asking there would silently get nothing. */
  const thumbW = parseFloat(getComputedStyle(host).getPropertyValue("--seek-thumb")) || 14;
  const head = thumbW / 2 + frac * (w - thumbW);

  /* One bar per 2 CSS pixels. The stored waveform holds 1000 values and a phone
     is ~390 CSS px wide, so a wider step throws most of them away; below 2px
     the bars stop being separable and it reads as a filled shape rather than a
     waveform. */
  const barW = 1, step = 2;
  const bars = Math.max(1, Math.floor(w / step));
  const mid = h / 2;
  for (let i = 0; i < bars; i++) {
    /* Max across the peaks this bar covers, for the same reason the server
       resamples by max: averaging flattens exactly what is worth seeing. */
    const a = Math.floor(i * peaks.length / bars);
    const b = Math.max(a + 1, Math.floor((i + 1) * peaks.length / bars));
    let v = 0;
    for (let j = a; j < b && j < peaks.length; j++) if (peaks[j] > v) v = peaks[j];
    /* A floor of 1px so silence is a line rather than a gap — a gap reads as
       "the waveform stopped loading", which is a different thing entirely. */
    const barH = Math.max(1, (v / 255) * (h - 2));
    /* A bar counts as played once its MIDDLE is behind the playhead, so the
       boundary lands where the dot is rather than a bar's width either side. */
    const done = (i * step + barW / 2) <= head;
    ctx.fillStyle = done ? played : ahead;
    /* The played side goes to full strength so the accent still reads as the
       position marker against a bright track ahead of it. */
    ctx.globalAlpha = done ? 1 : 0.72;
    ctx.fillRect(i * step, mid - barH / 2, barW, barH);
  }
  ctx.globalAlpha = 1;
}

/*
 * Ask for the shape of whatever is playing.
 *
 * Keyed on the TRACK ID, which this server has and MusicD Remote does not — it
 * matches a title and a duration against a streaming service because Roon never
 * tells it what the file is. Here the id is the file, so there is nothing to
 * guess and nothing that can resolve to the wrong recording.
 */
async function loadWaveform(now) {
  const id = now && now.track ? now.track.id : "";
  if (!id) {
    state.wave = null; state.waveKey = "";
    drawWave();
    return;
  }
  if (id === state.waveKey) return;          // same track: what we have applies
  state.waveKey = id;
  state.wave = null;
  drawWave();                                // the plain bar while we ask
  const mine = ++state.waveReq;
  try {
    const out = await api("/api/track/" + b64url(id) + "/waveform");
    /* The track may have moved on while the server was decoding. Landing a
       stale waveform under a different song is worse than none: it looks
       authoritative and it is simply the wrong shape. */
    if (mine !== state.waveReq || state.waveKey !== id) return;
    if (!out || !out.peaks) return;
    const bin = atob(out.peaks);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    state.wave = u8;
    drawWave();
  } catch {
    /* No waveform is an ORDINARY answer — an undecodable file, the feature
       switched off, a server that is busy. The plain bar is already showing and
       a toast about a decoration nobody asked for would be noise. */
  }
}

/* ------------------------------------------------------------------ */
/*  Share card                                                         */
/* ------------------------------------------------------------------ */

const SHARE_ICONS = {
  share: '<polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'
};

function shareIcon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
         `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SHARE_ICONS[name]}</svg>`;
}

function resetShare() {
  $("share-frame").innerHTML =
    '<div class="share-placeholder"><div class="share-spinner"></div><div>Generating card…</div></div>';
  $("share-actions").textContent = "";
  $("share-hint").textContent = "";
  $("share-err").textContent = "";
}

function closeShare() {
  $("share-overlay").classList.add("hidden");
  resetShare();
}

/*
 * Which album the card is of.
 *
 * On the album face it is the album you are looking at. On Now playing or the
 * Queue it is read from the LIVE state rather than from whatever the panel was
 * opened with — three tracks later that is a different record, and a card of
 * the album that happened to be playing when you opened the screen is a
 * confusing thing to have shared.
 */
function shareTarget() {
  if (state.face === "album" && state.album) return state.album.id;
  if (state.now && state.now.album) return state.now.album.id;
  if (state.album) return state.album.id;
  return null;
}

async function openShareCard() {
  const albumId = shareTarget();
  if (!albumId) { toast("Nothing to make a card from yet."); return; }

  resetShare();
  $("share-overlay").classList.remove("hidden");
  navOpen("share", closeShare);

  try {
    const album = await api("/api/album/" + b64url(albumId));
    const blob = await ShareCard.render({
      coverUrl: album.art || "",
      title: album.title,
      artist: album.artist,
      year: album.year,
      releaseDate: album.releaseDate
    });
    const dataUrl = await blobToDataUrl(blob);
    const img = el("img");
    img.src = dataUrl;
    img.alt = `Share card for ${album.title}`;
    $("share-frame").textContent = "";
    $("share-frame").appendChild(img);
    buildShareActions(blob, album);
  } catch (e) {
    $("share-frame").innerHTML = '<div class="share-placeholder">Could not generate the card.</div>';
    $("share-err").textContent = e.message || String(e);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("could not read the generated card"));
    reader.readAsDataURL(blob);
  });
}

/*
 * Only the actions this browser can actually perform are offered.
 *
 * Sharing files and writing images to the clipboard are both behind capability
 * checks that vary by browser and by whether the page is secure — a button
 * that throws when tapped is worse than one that was never there. Download is
 * always offered, because an anchor always works.
 */
function buildShareActions(blob, album) {
  const actions = $("share-actions");
  actions.textContent = "";

  const fileName =
    `${(album.artist || "artist").replace(/[^a-z0-9]+/gi, "_")}-` +
    `${(album.title || "card").replace(/[^a-z0-9]+/gi, "_")}.png`;

  const canShare = (() => {
    try {
      if (!navigator.share || !navigator.canShare) return false;
      const probe = new File([new Uint8Array([0])], "probe.png", { type: "image/png" });
      return navigator.canShare({ files: [probe] });
    } catch { return false; }      // no File constructor, or a refusal to probe
  })();
  const canCopy = typeof window.ClipboardItem !== "undefined" &&
                  navigator.clipboard && typeof navigator.clipboard.write === "function";

  const button = (cls, iconName, label) => {
    const b = el("button", cls);
    b.type = "button";
    b.innerHTML = shareIcon(iconName) + "<span>" + label + "</span>";
    return b;
  };
  const relabel = (b, text) => { b.querySelector("span").textContent = text; };

  if (canCopy) {
    const copy = button("", "copy", "Copy image");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.write([new window.ClipboardItem({ "image/png": blob })]);
        relabel(copy, "Copied");
        setTimeout(() => relabel(copy, "Copy image"), 2000);
      } catch (e) { $("share-err").textContent = e.message || String(e); }
    });
    actions.appendChild(copy);
  }

  if (canShare) {
    const share = button("primary", "share", "Share…");
    share.addEventListener("click", async () => {
      try {
        await navigator.share({ files: [new File([blob], fileName, { type: "image/png" })] });
      } catch (e) {
        /* Dismissing the system share sheet is an AbortError, and is not a
           failure worth reporting back to the user. */
        if (e && e.name !== "AbortError") $("share-err").textContent = e.message || String(e);
      }
    });
    actions.appendChild(share);
  }

  const download = el("a");
  download.href = URL.createObjectURL(blob);
  download.download = fileName;
  download.innerHTML = shareIcon("download") + "<span>Download</span>";
  actions.appendChild(download);

  $("share-hint").textContent = canShare || canCopy
    ? "Tap a button above, or long-press the card to save it."
    : "Long-press the card to save it, or tap Download.";
}

/* ------------------------------------------------------------------ */
/*  Rooms                                                              */
/* ------------------------------------------------------------------ */

async function openZoneSheet(refresh = false) {
  $("zone-sheet").classList.remove("hidden");
  navOpen("sheet", hideSheet);
  const list = $("zone-list");
  const note = $("zone-note");
  list.textContent = "";
  note.textContent = "Looking for Sonos rooms…";

  try {
    const data = await api("/api/zones" + (refresh ? "?refresh=1" : ""));
    state.rooms = data.rooms;
    list.textContent = "";

    for (const room of data.rooms) {
      const row = el("button", "zone-row");
      row.type = "button";
      if (state.zone && state.zone.uuid === room.uuid) row.classList.add("is-active");
      const label = el("span");
      label.appendChild(el("span", "", room.name));
      if (room.grouped) {
        label.appendChild(el("span", "zone-sub", "Grouped with " +
          room.members.filter(m => m !== room.name).join(", ")));
      }
      row.appendChild(label);
      row.addEventListener("click", () => {
        state.zone = { uuid: room.uuid, name: room.name };
        saveZone(state.zone);
        closeSheet();
        startPolling();
        if (state.face === "queue") loadQueue();
      });
      list.appendChild(row);
    }

    note.textContent = data.rooms.length
      ? ""
      : (data.error || "No Sonos players answered. The container needs host networking " +
                       "for discovery, or set SONOS_HOSTS to a player's IP address.");
  } catch (e) {
    note.textContent = e.message;
  }
}

function closeSheet() { navBack(); }
function hideSheet() { $("zone-sheet").classList.add("hidden"); }

/* ------------------------------------------------------------------ */
/*  Status, scanning, theme                                            */
/* ------------------------------------------------------------------ */

function banner(text, isError = false) {
  const node = $("status-banner");
  if (!text) { node.classList.add("hidden"); return; }
  node.textContent = text;
  node.classList.toggle("error", isError);
  node.classList.remove("hidden");
}

/*
 * The cover-lookup row in the side menu.
 *
 * One line that says what is happening and one tap that turns it off, which is
 * the whole of the interface — the point of this feature is that it is not a
 * manual fetch, so there is no picker, no candidate grid and nothing to
 * choose. An album whose folder has a picture in it is never touched.
 *
 * The row is absent, not disabled, when the container was started with cover
 * lookup off: a switch that cannot do anything is a worse answer than no
 * switch.
 */
/*
 * The two Random Album Radio rows.
 *
 * The genre row is ABSENT rather than dimmed while the radio is off, because
 * it is not a setting that is currently unavailable — it is a setting that
 * describes something not happening. The same rule the covers row follows for
 * a container with the lookup switched off: a control that cannot do anything
 * is worse than no control.
 *
 * Painted from /api/status like every other row here, so a second phone that
 * turned it on is reflected on this one within the poll rather than the two
 * disagreeing until a reload.
 */
/*
 * Which way a two-state row is set, shown as well as said.
 *
 * One place that knows how, because five rows do it and five copies of two
 * lines is five chances for one of them to stop agreeing with its own words.
 */
function paintToggle(rowId, on) {
  const row = $(rowId);
  /* The element may BE the switch — the covers one is a button in its own
     right — or contain it, where the row is the button and the switch is
     decoration inside it. querySelector alone finds only the second, and the
     first then had its aria set and its appearance left saying the opposite. */
  const knob = row.classList.contains("toggle") ? row : row.querySelector(".toggle");
  if (knob) knob.classList.toggle("is-on", !!on);
  /* The ROW carries the state for a screen reader — the switch inside it is
     decoration, and announcing both would say everything twice. */
  if (row.getAttribute("role") === "switch") {
    row.setAttribute("aria-checked", on ? "true" : "false");
  }
}

/* Which of a named pair is chosen. */
function paintPair(pairId, chosen) {
  for (const opt of $(pairId).querySelectorAll(".pair-opt")) {
    opt.classList.toggle("is-on", opt.dataset.opt === chosen);
  }
}

function showRadio(radio) {
  state.radio = radio;
  const row = $("menu-radio");
  row.classList.toggle("is-off", !radio.enabled);
  /* No words: the switch says which way it is set, and a line repeating that
     is a line to read on every visit. */
  paintToggle("menu-radio", radio.enabled);

  const genre = $("menu-radio-genre");
  genre.classList.toggle("hidden", !radio.enabled);
  genre.classList.toggle("is-off", !radio.matchGenre);
  paintToggle("menu-radio-genre", radio.matchGenre);
}

function showCovers(covers) {
  const was = state.covers;
  state.covers = covers;
  $("menu-covers-row").classList.toggle("hidden", !covers.available);
  if (!covers.available) return;

  const row = $("menu-covers");
  row.classList.toggle("is-off", !covers.enabled);
  paintToggle("menu-covers-auto", covers.enabled);
  /*
   * It SAYS it is automatic now. The sweep has always run by itself — after
   * every scan, and scans run every six hours — but nothing on this row
   * mentioned it, so the switch read as decoration and the count read as the
   * only thing happening.
   */
  const count = covers.missing
    ? `${covers.missing} still without one`
    : "every album has a cover";
  $("covers-sub").textContent =
    covers.running ? `Looking — ${covers.done} of ${covers.total}`
    : covers.enabled ? `Looking automatically · ${count}`
    : `Not looking · ${count}`;
  /* The grid may be open behind the menu, or the sweep may have moved on while
     it is; either way the bar says the same thing this row does. */
  paintCoversBar();

  /*
   * A sweep that is running is watched at the rate a scan is watched, and only
   * while it runs — the same shape as state.scanTimer above, and it switches
   * itself off. Thirty seconds is right for a settings row and useless for a
   * progress line somebody is standing in front of.
   */
  if (covers.running && !state.coverTimer) {
    state.coverTimer = setInterval(refreshStatus, 2000);
  } else if (!covers.running && state.coverTimer) {
    clearInterval(state.coverTimer);
    state.coverTimer = null;
  }
  /* On the TRANSITION only. A sweep that has just finished has taken albums off
     the missing wall; re-reading that wall on every poll instead would throw
     somebody's scroll away twice a minute for nothing. */
  if (was && was.running && !covers.running) reloadCoversGrid();
}

/*
 * The Missing covers grid's own bar.
 *
 * Painted from `state.covers`, which every /api/status poll refreshes — so the
 * line follows a sweep that is already running without this screen asking for
 * anything of its own. Hidden on every other grid: it is this row's bar, the
 * way the sort controls are the Library's.
 */
function paintCoversBar() {
  const on = state.view === "grid" && state.grid && state.grid.key === "nocover";
  $("covers-bar").classList.toggle("hidden", !on);
  if (!on) return;
  const c = state.covers || {};
  $("covers-bar-note").textContent =
    c.running ? `Looking — ${c.done} of ${c.total}`
    : c.enabled ? "Looked for automatically, after every scan"
    : "The automatic look is switched off";
  /* Nothing to look for, and nothing to look WITH on a container started with
     COVER_LOOKUP=false. */
  $("covers-bar-now").disabled = !c.available || !!c.running;
}

/*
 * The Last.fm row.
 *
 * Absent unless the container was given a key: Last.fm has no anonymous mode
 * and no OAuth 2, so a server without one has nothing this row could do, and a
 * row that explains why it cannot work is worse than no row.
 *
 * Connecting is two taps because Last.fm's flow is two steps — approve MusicD
 * on last.fm's own page, then come back — and the row says which tap it is
 * waiting for. Holding it disconnects, the same gesture as the covers row.
 */
/*
 * What the Settings row promises.
 *
 * Built from what is actually behind it rather than written out: covers and
 * Last.fm are each absent on a container that was not given them, and naming a
 * setting that is not there is how somebody ends up hunting for it.
 */
function describeSettings() {
  const bits = ["Scanning", "the home screen", "theme"];
  if (state.covers && state.covers.available) bits.push("covers");
  if (state.lastfm && state.lastfm.configured) bits.push("Last.fm");
  bits.push("updates");
  $("settings-sub").textContent =
    bits.slice(0, -1).join(", ") + " and " + bits[bits.length - 1];
}

function showLastfm(lastfm) {
  state.lastfm = lastfm;
  const row = $("menu-lastfm");
  row.classList.toggle("hidden", !lastfm.configured);
  if (!lastfm.configured) return;

  row.classList.toggle("is-off", !lastfm.connected);
  const waiting = lastfm.queued
    ? ` · ${lastfm.queued} waiting to send` : "";
  $("lastfm-sub").textContent =
    lastfm.connected ? `Scrobbling as ${lastfm.user}${waiting} · hold to disconnect`
    : lastfm.pending ? "Approve MusicD in the tab that opened, then tap to finish"
    : "Not connected · tap to connect";
}

async function refreshStatus() {
  try {
    const status = await api("/api/status");
    const bar = $("scan-progress-bar");

    if (status.scan.running) {
      bar.classList.remove("hidden");
      const pct = status.scan.total ? (status.scan.done / status.scan.total) * 100 : 4;
      $("scan-progress-fill").style.width = `${Math.max(4, pct)}%`;
      $("rescan-sub").textContent = `Scanning — ${status.scan.done} of ${status.scan.total || "?"} folders`;
      banner(`Scanning your library — ${status.stats.albums} albums found so far.`);
      if (!state.scanTimer) state.scanTimer = setInterval(refreshStatus, 2000);
    } else {
      bar.classList.add("hidden");
      if (state.scanTimer) {
        clearInterval(state.scanTimer);
        state.scanTimer = null;
        banner("");
        loadHome();                        // the scan just finished; show what it found
      }
      $("rescan-sub").textContent = status.scan.last
        ? `${status.stats.albums} albums · last scanned ${ago(status.scan.last.at)}`
        : "";
      if (!status.stats.albums && !status.scan.running) {
        banner(`No music found in ${status.musicDirs.join(", ")}. ` +
               `Check the folder is mounted into the container.`, true);
      } else {
        banner("");
      }
    }

    if (status.covers) showCovers(status.covers);
    /* A container started with IDENTIFY=false offers nothing rather than
       offering a button that cannot work — the same shape as the covers row. */
    state.identify = status.identify || null;
    if (status.radio) showRadio(status.radio);
    if (status.lastfm) showLastfm(status.lastfm);
    describeSettings();

    state.build = status.build;
    $("version-sub").textContent = describeBuild(status.build);
    $("menu-foot").textContent =
      `${status.stats.albums} albums, ${status.stats.tracks} tracks · ` +
      `${status.sonos.rooms} Sonos room${status.sonos.rooms === 1 ? "" : "s"} · ` +
      `${status.time.zone}`;

    /* Once per load, on the first status that comes back. There is an order to
       these: an update already running is the most important thing the banner
       could say, then a stale page — reloading is what to do first, and it is
       what an update has just finished asking for — then a new release. Two
       banners at once is one too many. */
    if (!state.checkedForUpdate) {
      state.checkedForUpdate = true;
      resumeUpdateIfRunning().then((running) => {
        if (running) return;
        if (SHELL_VERSION && SHELL_VERSION !== status.version) showStaleShell(status.version);
        else checkForUpdate(status.build);
      });
    }
  } catch (e) {
    banner("Cannot reach the server: " + e.message, true);
  }
}

/* ------------------------------------------------------------------ */
/*  Which build this is, and whether there is a newer one               */
/* ------------------------------------------------------------------ */

const REPO = "meltface-80/MusicD-Server";

/* Which version this DOCUMENT is, stamped in by the server when it built the
   page. If it disagrees with what the server reports, the browser is showing a
   shell it cached before the update. */
const SHELL_VERSION = (() => {
  const meta = document.querySelector('meta[name="musicd-build"]');
  return meta ? meta.getAttribute("content") || "" : "";
})();

/*
 * The page itself is out of date.
 *
 * Nothing else can detect this. A shell cached under the old rules will not
 * revalidate until its stored lifetime runs out, so a correctly updated server
 * goes on serving a previous release's interface with no sign of it — which is
 * exactly how "I updated and nothing changed" happens twice in a row. The
 * reload uses a fresh URL rather than location.reload(), because a reload can
 * itself be answered from the very cache entry that is the problem.
 */
function showStaleShell(serverVersion) {
  $("update-text").textContent =
    `This page is from version ${SHELL_VERSION}; the server is running ${serverVersion}.`;
  const link = $("update-link");
  link.textContent = "Reload";
  link.removeAttribute("target");
  link.href = location.pathname + "?r=" + Date.now();
  $("update-dismiss").onclick = () => $("update-banner").classList.add("hidden");
  $("update-banner").classList.remove("hidden");
}

/* Compare two dotted versions numerically. "0.10.0" is newer than "0.9.0",
   which a string comparison gets backwards. */
function isNewer(candidate, running) {
  const parse = (v) => String(v || "").replace(/^v/, "").split(".").map(n => parseInt(n, 10) || 0);
  const a = parse(candidate), b = parse(running);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

function describeBuild(build) {
  if (!build) return "";
  const parts = ["v" + build.version];
  if (build.commit) parts.push(build.commit);
  if (build.date) parts.push("built " + String(build.date).slice(0, 10));
  return parts.join(" · ");
}

/*
 * Ask GitHub whether there is a newer release.
 *
 * From the BROWSER, not the server: this is the app's own updater, and the
 * server has no business reaching the internet on its own. It runs once per
 * load, fails silently when offline, and remembers a dismissal per version so
 * it does not become a nag.
 */
/*
 * How long the automatic check waits before asking GitHub again.
 *
 * GitHub allows sixty unauthenticated requests an hour PER ADDRESS, and every
 * phone in the house shares one — so an installed app that asks on every
 * launch is a household spending that allowance on a question whose answer
 * changes a few times a week. Running out is a 403, which is what an update
 * refusing to install looks like from the outside. Asking is still free the
 * moment somebody asks for it: a manual check ignores this entirely.
 */
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function checkedRecently() {
  try {
    const at = Number(localStorage.getItem("musicd.lastUpdateCheck") || 0);
    return at > 0 && Date.now() - at < UPDATE_CHECK_EVERY_MS;
  } catch {
    /* Storage off. Then there is nothing to remember and the check runs, which
       is the behaviour this replaced — no worse than before. */
    return false;
  }
}

function rememberCheck() {
  try { localStorage.setItem("musicd.lastUpdateCheck", String(Date.now())); }
  catch { /* storage off — the next load asks again, as it always did */ }
}

async function checkForUpdate(build, { manual = false } = {}) {
  if (!build || !build.version) return;
  if (!manual && checkedRecently()) return;
  let dismissed = "";
  try { dismissed = localStorage.getItem("musicd.dismissedUpdate") || ""; }
  catch { /* storage off — the notice simply reappears next load */ }

  try {
    if (manual) toast("Checking for updates…");
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { cache: "no-store" });
    if (res.status === 403 || res.status === 429) {
      /* Sixty an hour per address, shared with every other phone here. Not a
         fault, and not worth a banner on an automatic check. */
      rememberCheck();
      throw new Error("GitHub is rate-limiting this address — try again later.");
    }
    if (!res.ok) throw new Error("GitHub answered " + res.status);
    const release = await res.json();
    rememberCheck();
    const latest = String(release.tag_name || "").replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error("no released version to compare with");
    if (!isNewer(latest, build.version)) {
      if (manual) toast(`You are on the latest version (${build.version}).`);
      return;
    }
    /* A dismissal is remembered for the automatic check only. Asking for the
       check is asking to see the answer. */
    if (!manual && dismissed === latest) return;

    offerUpdate(latest, build.version, release.html_url || `https://github.com/${REPO}/releases`);
  } catch (e) {
    /* Offline, rate-limited, or no release yet. The automatic check says
       nothing — the app does not depend on the answer — but somebody who
       asked deserves to be told it could not be got. */
    if (manual) toast("Could not check for updates: " + e.message, true);
  }
}

/* ------------------------------------------------------------------ */
/*  Installing an update                                                */
/* ------------------------------------------------------------------ */

/*
 * The banner does not just report a new version, it installs it.
 *
 * The server downloads the release, writes it over itself and restarts, so
 * everything here is: ask it to start, then watch. The watching is the awkward
 * part — the server goes away in the middle, on purpose, so a failed request
 * is the expected halfway point rather than an error.
 */
const UPDATE_PHASES = {
  checking:   "Checking the release…",
  downloading: "Downloading…",
  unpacking:  "Unpacking…",
  installing: "Installing dependencies…",
  restarting: "Restarting…"
};

const UPDATE_POLL_MS = 1500;
/* Long enough for a Raspberry Pi to rebuild better-sqlite3 from source, which
   is the slowest thing an update here can have to do. */
const UPDATE_GIVE_UP_MS = 6 * 60 * 1000;

function updateBanner() { return $("update-banner"); }

function showUpdateProgress(phase) {
  updateBanner().classList.remove("hidden", "is-error");
  updateBanner().classList.add("is-busy");
  $("update-text").textContent = UPDATE_PHASES[phase] || "Updating…";
}

/*
 * An update that failed, and enough to know why.
 *
 * The server names the step it died in and gathers what it could and could not
 * do at that moment — reach GitHub, run tar, write to its own directory. That
 * goes behind the Release notes link, which becomes a way to copy the lot:
 * "the update fails" is not a report anybody can act on, and the person who
 * has to act on it is usually not standing next to the container's log.
 */
function showUpdateFailed(message, diagnosis) {
  updateBanner().classList.remove("is-busy");
  updateBanner().classList.add("is-error");
  $("update-text").textContent = "The update failed: " + message;
  $("update-now").disabled = false;
  $("update-now").textContent = "Try again";

  const link = $("update-link");
  if (!diagnosis) return;
  link.textContent = "Copy details";
  link.removeAttribute("target");
  link.removeAttribute("href");
  link.onclick = (e) => {
    e.preventDefault();
    const detail = [`MusicD Server ${state.build ? state.build.version : "?"}`,
                    `failed: ${message}`,
                    ...Object.entries(diagnosis).map(([k, v]) => `${k}: ${v}`)].join("\n");
    copyText(detail, "Details copied.");
  };
}

/* Offer the update, with the button that takes it. */
function offerUpdate(latest, running, notesUrl) {
  const banner = updateBanner();
  banner.classList.remove("hidden", "is-busy", "is-error");
  $("update-text").textContent =
    `Version ${latest} is out — you are running ${running}.`;
  const link = $("update-link");
  link.textContent = "Release notes";
  link.target = "_blank";
  link.href = notesUrl;
  link.onclick = null;                 // a previous failure may have taken it over

  const button = $("update-now");
  button.disabled = false;
  button.textContent = "Update now";
  button.onclick = () => startUpdate(running);

  $("update-dismiss").onclick = () => {
    banner.classList.add("hidden");
    try { localStorage.setItem("musicd.dismissedUpdate", latest); }
    catch { /* storage off — dismissing lasts for this visit only */ }
  };
}

async function startUpdate(runningVersion) {
  $("update-now").disabled = true;
  showUpdateProgress("checking");
  try {
    await post("/api/update/apply", {});
  } catch (e) {
    /* The server may already have restarted under the request. That is a
       successful start, not a failure, so watching begins either way and the
       watch below is what decides which it was. */
    console.warn("[update] the apply request did not come back: " + e.message);
  }
  watchUpdate(runningVersion);
}

/*
 * Watch an update through to the other side.
 *
 * What ends the wait is the SERVER REPORTING A DIFFERENT VERSION, not the
 * server going away and coming back. Watching for the outage looks like the
 * obvious signal and is not one: a fast machine finishes the whole update
 * inside a single poll interval, so there is no moment at which a request
 * fails, and a watch waiting for one waits for ever on exactly the setups
 * where the update went best. A failed request only changes what the banner
 * says while it keeps waiting.
 */
function watchUpdate(runningVersion) {
  clearInterval(state.updateTimer);
  const startedAt = Date.now();

  state.updateTimer = setInterval(async () => {
    if (Date.now() - startedAt > UPDATE_GIVE_UP_MS) {
      clearInterval(state.updateTimer);
      showUpdateFailed("it is taking too long. Check the container's logs.");
      return;
    }
    let status;
    try {
      status = await api("/api/update");
    } catch {
      /* Unreachable — the restart, most likely. Say so and keep waiting; the
         version check above is what actually finishes this. */
      showUpdateProgress("restarting");
      return;
    }

    if (runningVersion && status.current && status.current !== runningVersion) {
      /* A different build is answering: the update landed. Reloading with a
         fresh URL rather than location.reload(), for the same reason the
         stale-shell banner does — a reload can be answered from the very
         cache entry holding the old shell. */
      clearInterval(state.updateTimer);
      location.replace(location.pathname + "?updated=" + status.current);
      return;
    }

    const phase = (status.apply && status.apply.phase) || "idle";
    if (phase === "error") {
      clearInterval(state.updateTimer);
      showUpdateFailed(status.apply.error || "no reason given", status.apply.diagnosis);
      return;
    }
    if (UPDATE_PHASES[phase]) showUpdateProgress(phase);
  }, UPDATE_POLL_MS);
}

/* If the server was already updating when this page loaded — a second phone,
   or a reload mid-update — join the watch rather than showing a stale offer. */
async function resumeUpdateIfRunning() {
  try {
    const status = await api("/api/update");
    const phase = (status.apply && status.apply.phase) || "idle";
    if (!UPDATE_PHASES[phase]) return false;
    showUpdateProgress(phase);
    watchUpdate(status.current);
    return true;
  } catch {
    /* Nothing to resume, or the server is not answering. Either way the
       ordinary check runs next and reports what it finds. */
    return false;
  }
}

/*
 * Say the update worked.
 *
 * The reload after an update carries the version it landed on, because that is
 * the only moment the app can tell the difference between "you reloaded" and
 * "you updated" — and after all the trouble this project has had with updates
 * that appeared to do nothing, finishing one in silence is the wrong ending.
 *
 * It does not simply read the address bar and stop there. The new build ships a
 * new service worker, which takes over and reloads the page a second time
 * moments later — so a message shown once and forgotten is gone before it can
 * be read. It moves into storage that survives that reload, and is cleared only
 * once it has been on screen long enough to have been seen.
 */
const JUST_UPDATED_KEY = "musicd.justUpdated";

function announceUpdateIfJustDone() {
  let version = new URLSearchParams(location.search).get("updated");
  if (version) {
    /* Out of the address bar at once, so a bookmark or a share never carries
       it and no ordinary reload repeats the message. */
    history.replaceState(null, "", location.pathname);
    try { sessionStorage.setItem(JUST_UPDATED_KEY, version); }
    catch { /* storage off — the message shows now and only now */ }
  } else {
    try { version = sessionStorage.getItem(JUST_UPDATED_KEY) || ""; }
    catch { /* storage off — nothing was kept, so there is nothing to say */ }
  }
  if (!version) return;

  toast(`Updated to version ${version}.`);
  setTimeout(() => {
    try { sessionStorage.removeItem(JUST_UPDATED_KEY); }
    catch { /* storage off — nothing was stored to remove */ }
  }, 4000);
}

/* ------------------------------------------------------------------ */
/*  Keeping an installed app up to date                                 */
/* ------------------------------------------------------------------ */

/*
 * Register the service worker, and reload once when a new one takes over.
 *
 * Deliberately NOT a <link rel="manifest"> or any <head> tag: iOS reads those
 * at add-to-home-screen time and bakes the result into the shortcut, and this
 * project has already been bitten by that. A registration call is script, runs
 * after layout, and changes nothing about how the window is sized.
 */
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    /* A new worker took over. The document in front of the user is the OLD
       shell, so it is replaced — once, because controllerchange can fire more
       than once and a reload loop is worse than a stale page. */
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker.register("/sw.js").then((reg) => {
    /* Ask on every load, rather than waiting for the browser's own 24-hour
       check — on a home-screen app that check is what "it never updates"
       actually means. */
    reg.update().catch(() => { /* offline; the next load will try again */ });
    reg.addEventListener("updatefound", () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          /* An update is ready and something is already controlling the page,
             so this is a genuine upgrade rather than the first install. */
          installing.postMessage("skip-waiting");
        }
      });
    });
  }).catch(() => {
    /* Registration needs a secure context; over plain HTTP on a LAN address
       this is refused, and the app works exactly as it did before. */
  });
}

/*
 * Kept on the DEVICE, like the theme and not like the row order.
 *
 * The rows are the library's arrangement and belong in the database, where
 * every phone in the house sees the same one. This is about how one person's
 * thumb gets out of a screen, and a phone held one-handed and a tablet on a
 * table can reasonably disagree — so it lives beside the theme, in the same
 * storage, read the same way at startup.
 */
const NP_LEFT_KEY = "musicd.npLeft";

function applyNpLeft(mode) {
  state.npLeft = mode === "back" ? "back" : "home";
  /* The pair names the choice; Home and Back need no explaining. */
  paintPair("npleft-pair", state.npLeft);
  try { localStorage.setItem(NP_LEFT_KEY, state.npLeft); } catch { /* storage off */ }
  /* Repainted rather than left until the next face change: the panel can be
     open behind the menu, and a setting that only takes effect next time reads
     as one that did not work. */
  paintModalLeft();
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelector('meta[name="theme-color"]')
    .setAttribute("content", theme === "light" ? "#f6f5f2" : "#1d2125");
  /* No sub-line: it said "Dark", which is exactly what the pair now shows. */
  paintPair("theme-pair", theme === "light" ? "light" : "dark");
  try { localStorage.setItem("musicd.theme", theme); } catch { /* storage off */ }
}

/* ------------------------------------------------------------------ */
/*  Wiring                                                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  The soft keyboard                                                  */
/* ------------------------------------------------------------------ */

/*
 * How much of the bottom of the page the keyboard is covering.
 *
 * A fixed element is anchored to the LAYOUT viewport, which does not shrink
 * when the keyboard opens — so the mini transport correctly ends up behind the
 * keys. But iOS re-anchors fixed elements to the VISUAL viewport while the
 * page is scrolling, and with the search box focused that lifted the bar out
 * of the page and left it floating on top of the keyboard.
 *
 * So everything pinned to the bottom subtracts this, which holds it where it
 * was before the keyboard opened however the browser decides to paint it. The
 * bar does not move for the keyboard; the keyboard covers it.
 */
const KB_MIN = 60;
let keyboardInset = 0;

function measureKeyboard(viewport) {
  /*
   * HOW TALL THE KEYBOARD IS — not where the visual viewport happens to be
   * sitting this frame. The two are different measurements and only the first
   * one belongs here.
   *
   * The keyboard SHRINKS the visual viewport; scrolling MOVES it. So its
   * height is the difference between the two viewports, and window.innerHeight
   * is the one that does not change when the keyboard opens, which is what
   * makes that difference the keyboard.
   *
   * offsetTop — how far the visual viewport has slid down inside the layout
   * viewport — is deliberately NOT subtracted, though it looks like it should
   * be. It is the scroll position, and including it made this measurement
   * decay to nothing over the course of a flick (266 → 226 → 146 → 0) while
   * the keyboard stood perfectly still. That is the worst possible moment for
   * the correction to switch off: a scroll is exactly when iOS re-anchors
   * fixed elements to the visual viewport, so the bar sprang up onto the keys
   * on the way past. The keyboard's height cannot change during a scroll, and
   * now neither can this.
   */
  const covered = window.innerHeight - viewport.height;
  /* No keyboard is 60 pixels tall. Anything smaller is browser chrome, a
     rounding difference or a pinch-zoom, and moving the bar for it would be a
     twitch with no cause the user can see. */
  return covered >= KB_MIN ? Math.round(covered) : 0;
}

function trackKeyboard() {
  const viewport = window.visualViewport;
  /* Without it there is only one viewport, so there is nothing to correct and
     the bar already stays where it is put. */
  if (!viewport) return;
  const apply = () => {
    const next = measureKeyboard(viewport);
    /* Written only on a change: these events fire on every frame of a visual
       viewport scroll, and a style write per frame is a layout per frame. */
    if (next === keyboardInset) return;
    keyboardInset = next;
    document.documentElement.style.setProperty("--kb-inset", next + "px");
  };
  /* Resize is the event that means something: the keyboard opening, closing or
     changing height is the only thing that moves this number. Scroll is
     listened to as a backstop — iOS does not always fire resize when a
     keyboard is dismissed by a scroll — and it is safe to listen to precisely
     because what apply() reads no longer varies with the scroll. */
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);
  apply();
}

/*
 * IS THE SOFT KEYBOARD UP — asked of the FOCUS, not of a viewport.
 *
 * --kb-inset above holds the bar behind the keys by arithmetic, and that has
 * now been reported twice as a bar that appears over the search results
 * anyway. The arithmetic depends on which viewport iOS chooses to resize, and
 * it does not choose the same one everywhere: Safari shrinks the visual
 * viewport and leaves the layout viewport alone, an installed home-screen app
 * has been seen to shrink both, and a fixed element is re-anchored to the
 * visual viewport mid-scroll in either. Every one of those makes the same
 * subtraction land somewhere different.
 *
 * So stop approximating the intent and state it. The intent was always "the
 * bar does not move for the keyboard; the keyboard covers it" — a bar that is
 * covered is a bar you cannot see or press, so while you are typing there is
 * no bar. That is one rule, it is true in every viewport model, and it cannot
 * be off by a hundred pixels.
 *
 * The focus is the signal because it is the actual cause: a soft keyboard is
 * open exactly when a text field has it. Coarse pointers only — a desktop
 * keyboard is always up and covers nothing, and hiding the bar whenever
 * somebody clicked the search box would be a bug of its own.
 */
function trackTyping() {
  if (!window.matchMedia || !window.matchMedia("(pointer: coarse)").matches) return;
  const update = () => {
    const el = document.activeElement;
    const next = !!(el && el.matches && el.matches("input, textarea"));
    if (next === state.typing) return;
    state.typing = next;
    syncMini();
  };
  document.addEventListener("focusin", update);
  /* focusout runs BEFORE the next element takes focus, when activeElement is
     still the body — so read it a tick later, or moving between two fields
     would blink the bar back on between them. */
  document.addEventListener("focusout", () => setTimeout(update, 0));
}

/*
 * Which of the menu's two views is showing.
 *
 * Settings is deliberately NOT on the navigation stack, for the same reason
 * the menu itself is not: it is a drawer you opened, not a place you went, and
 * pushing history for it would mean the phone's Back gesture walked out of a
 * menu instead of leaving the screen behind it. Escape and the back row step
 * through it directly.
 */
function showMenuView(view) {
  /* Three views: the places, the settings, and arranging the home screen
     behind those. Named rather than a pair of booleans so adding a fourth is
     one more line rather than a rewrite. Missing covers is deliberately NOT
     one of them — it is a wall of albums, so it is a grid screen. */
  $("menu-main").classList.toggle("hidden", view !== "main");
  $("menu-settings").classList.toggle("hidden", view !== "settings");
  $("menu-home").classList.toggle("hidden", view !== "home");
  $("menu-settings-open").setAttribute("aria-expanded", view === "settings" ? "true" : "false");
  $("menu-home-open").setAttribute("aria-expanded", view === "home" ? "true" : "false");
  /* Back at the top of whichever list is now showing. Leaving Settings
     scrolled halfway down and returning to a main menu at the same offset is
     how a two-view panel loses people. */
  const scroll = document.querySelector(".menu-scroll");
  if (scroll) scroll.scrollTop = 0;
}

function openMenu() {
  /* Always on the first view. A menu that reopens on the settings you last
     looked at is a menu that has hidden Home from you. */
  showMenuView("main");
  $("menu-overlay").classList.remove("hidden");
}

function closeMenu() {
  $("menu-overlay").classList.add("hidden");
  showMenuView("main");
}

function menuIsOpen() {
  return !$("menu-overlay").classList.contains("hidden");
}

function wire() {
  trackKeyboard();
  trackTyping();

  /* Menu */
  $("menu-toggle").addEventListener("click", openMenu);
  $("menu-settings-open").addEventListener("click", () => showMenuView("settings"));
  $("menu-settings-back").addEventListener("click", () => showMenuView("main"));
  /* Back from arranging goes to Settings, which is where it was opened from —
     not to the main list, which would be one step too far out. */
  $("menu-home-open").addEventListener("click", () => showMenuView("home"));
  $("menu-home-back").addEventListener("click", () => showMenuView("settings"));
  for (const node of document.querySelectorAll("[data-close-menu]")) {
    node.addEventListener("click", closeMenu);
  }
  for (const node of document.querySelectorAll("[data-go]")) {
    node.addEventListener("click", () => {
      closeMenu();
      const target = node.getAttribute("data-go");
      if (target === "home") navReset();
      else if (target === "artists") openArtists();
      else if (target.startsWith("row:")) openRow(target.slice(4));
    });
  }

  $("menu-rescan").addEventListener("click", async () => {
    closeMenu();
    try {
      const r = await post("/api/rescan", {});
      toast(r.already ? "A scan is already running." : "Scanning your library…");
      refreshStatus();
    } catch (e) { toast(e.message, true); }
  });

  $("menu-update").addEventListener("click", () => {
    closeMenu();
    checkForUpdate(state.build, { manual: true });
  });

  $("menu-version").addEventListener("click", () => {
    const text = $("version-sub").textContent;
    if (!text) return;
    /* The one thing anybody wants from a version line is to paste it into a
       message about something not working. */
    copyText("MusicD Server " + text, "Version copied.");
  });

  for (const [id, field] of [["menu-radio", "enabled"], ["menu-radio-genre", "matchGenre"]]) {
    $(id).addEventListener("click", async () => {
      const now = state.radio || { enabled: false, matchGenre: true };
      try {
        /* Painted from what the SERVER says it did, not from what was asked
           for: this setting lives in the database and drives a loop nothing on
           this phone can see, so the server's answer is the only true one. */
        showRadio(await post("/api/radio", { [field]: !now[field] }));
      } catch (e) { toast(e.message, true); }
    });
  }

  /*
   * THE HOLD IS GONE. Turning the sweep off and on used to be a 500ms hold on
   * this row, which is a switch you have to be told about — and the row's tap
   * looked now, so nothing on screen ever said the sweep also runs by itself.
   * The switch is a switch, and the name opens the list of what is still
   * missing, where looking now belongs.
   */
  $("menu-covers-auto").addEventListener("click", async () => {
    const on = !(state.covers && state.covers.enabled);
    try {
      /* sweep:false — switching it on should not also start one before the
         screen that shows what it is doing has been opened. */
      showCovers(await post("/api/covers", { enabled: on, sweep: false }));
      toast(on ? "Covers will be looked for automatically."
               : "Covers will not be looked for.");
    } catch (e) { toast(e.message, true); }
  });

  /* Out of the drawer and onto a wall. These are albums, and the thing
     somebody wants to do with one of them — open it, and use Find cover — is
     what tapping an album tile has always meant. It leaves the menu on the
     navigation stack the same way every other named row here does, which is
     what makes Back from the album panel land on this grid rather than on
     Home. */
  $("menu-covers").addEventListener("click", () => {
    closeMenu();
    openRow("nocover");
  });

  $("covers-bar-now").addEventListener("click", async () => {
    if (!state.covers || !state.covers.available) return;
    try {
      /* The same sweep the scan runs. It answers immediately and works in the
         background, so the wall is re-read a moment later rather than awaited —
         and again by the status poll, which is what moves the count. */
      showCovers(await post("/api/covers", {}));
      toast(state.covers.enabled ? "Looking for missing covers…"
                                 : "Switch it on to look automatically as well.");
      setTimeout(reloadCoversGrid, 1500);
    } catch (e) { toast(e.message, true); }
  });

  /* Held to disconnect, tapped to move the connection along — the same pair
     of gestures as the covers row above, for the same reason: the rarer and
     less reversible intention takes the more deliberate one. */
  let lastfmHold = null;
  $("menu-lastfm").addEventListener("pointerdown", () => {
    lastfmHold = setTimeout(async () => {
      lastfmHold = null;
      state.lastfmHeld = true;
      if (!state.lastfm || !state.lastfm.connected) return;
      try {
        showLastfm(await post("/api/lastfm/disconnect", {}));
        toast("Disconnected from Last.fm. Anything not yet sent is kept.");
      } catch (e) { toast(e.message, true); }
    }, 500);
  });
  for (const event of ["pointerup", "pointercancel", "pointerleave"]) {
    $("menu-lastfm").addEventListener(event, () => {
      if (lastfmHold) { clearTimeout(lastfmHold); lastfmHold = null; }
    });
  }
  $("menu-lastfm").addEventListener("click", async () => {
    if (state.lastfmHeld) { state.lastfmHeld = false; return; }
    const lastfm = state.lastfm;
    if (!lastfm) return;
    if (lastfm.connected) { toast(`Scrobbling as ${lastfm.user}.`); return; }
    try {
      if (lastfm.pending) {
        showLastfm(await post("/api/lastfm/finish", {}));
        toast(state.lastfm.connected
          ? `Connected to Last.fm as ${state.lastfm.user}.`
          : "Last.fm did not confirm that yet — approve it and tap again.");
        return;
      }
      /* Opened EMPTY and synchronously, inside the tap, then pointed at the
         page once the token comes back. A window opened after an await has
         lost the gesture that justified it and is blocked as a pop-up on
         every phone — which looked exactly like the connection failing. */
      const tab = window.open("", "_blank");
      let begun;
      try { begun = await post("/api/lastfm/start", {}); }
      catch (e) { if (tab) tab.close(); throw e; }
      if (tab) {
        tab.opener = null;                       // the new page gets no handle back
        tab.location.replace(begun.url);
      } else {
        /* Pop-ups are blocked outright. Going there in this tab is worse —
           it leaves the app — but it is the only way left to approve it, and
           Back returns. */
        window.location.href = begun.url;
        return;
      }
      showLastfm({ ...lastfm, pending: true });
      toast("Approve MusicD on the Last.fm page, then tap Last.fm again.");
    } catch (e) { toast(e.message, true); }
  });

  $("menu-theme").addEventListener("click", () => {
    applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
  });

  /* Choosing several albums */
  $("select-play").addEventListener("click", () => playPicked("play"));
  $("select-queue").addEventListener("click", () => playPicked("queue"));
  $("select-cancel").addEventListener("click", exitSelect);

  $("qsel-play").addEventListener("click", qPlayNow);
  $("qsel-remove").addEventListener("click", qRemove);
  $("qsel-cancel").addEventListener("click", qClearSelection);
  $("queue-clear-all").addEventListener("click", qClearAll);

  $("edit-find").addEventListener("click", findCovers);
  $("edit-identify").addEventListener("click", findMatches);

  $("sort-open").addEventListener("click", openSortSheet);
  for (const node of document.querySelectorAll("[data-close-sort]")) {
    node.addEventListener("click", closeSortSheet);
  }
  $("sort-dir").addEventListener("click", () => {
    const def = sortDef(state.sort && state.sort.sort);
    if (!def) return;
    /* A shuffle's control is another shuffle; everything else flips. */
    saveSort(def.directional
      ? { sort: state.sort.sort, dir: state.sort.dir === "desc" ? "asc" : "desc" }
      : { sort: state.sort.sort, seed: nextSeed(state.sort.seed) });
  });

  $("menu-npleft").addEventListener("click", () => {
    applyNpLeft(state.npLeft === "back" ? "home" : "back");
  });

  /* Navigation */
  $("topbar-back").addEventListener("click", navBack);

  /* Search */
  $("search-open").addEventListener("click", () => {
    $("topbar-search").classList.add("is-open");
    document.querySelector(".topbar-row").classList.add("searching");
    $("search-input").focus();
  });
  $("search-input").addEventListener("input", (e) => runSearch(e.target.value));
  $("search-clear").addEventListener("click", () => {
    if (state.view === "search") return navBack();
    $("search-input").value = "";
    $("topbar-search").classList.remove("is-open");
    document.querySelector(".topbar-row").classList.remove("searching");
  });

  /* Modal */
  for (const node of document.querySelectorAll("[data-close-modal]")) {
    node.addEventListener("click", closeModal);
  }
  /* playing() rather than .id — the album screen can be showing a version of
     the record, and Play means the one whose track list is on screen. */
  $("btn-play").addEventListener("click", () => state.album && playAlbum(playing(state.album), 0));
  $("btn-queue").addEventListener("click", () => state.album && queueAlbum(playing(state.album)));
  $("np-album").addEventListener("click", () => {
    if (state.now && state.now.album) openAlbum(state.now.album.id);
  });

  /* Transport */
  $("mt-open").addEventListener("click", () => openNowPlaying("np"));
  for (const [id, action] of [["np-prev", "previous"], ["np-next", "next"]]) {
    $(id).addEventListener("click", () => transport(action));
  }
  for (const id of ["mt-playpause", "np-playpause"]) {
    $(id).addEventListener("click", () => {
      const playing = state.now && state.now.state === "PLAYING";
      setPlayIcons(!playing);                 // move now, reconcile on the next poll
      if (state.now) {
        /* Bank the position reached so far, so resuming does not replay the
           seconds that passed while it was paused. */
        if (playing) state.now.position = Math.min(state.now.duration || 0,
          (state.now.position || 0) + (Date.now() - state.positionAt) / 1000);
        state.now.state = playing ? "PAUSED_PLAYBACK" : "PLAYING";
        state.positionAt = Date.now();
      }
      transport(playing ? "pause" : "play");
    });
  }


  /* Tabs, and the two controls that replace Back on the Now playing face. */
  for (const tab of document.querySelectorAll(".modal-tab")) {
    tab.addEventListener("click", () => {
      const which = tab.getAttribute("data-tab");
      setFace(which);
      if (which === "queue") loadQueue();
    });
  }
  /* Home from Now playing unwinds everything, rather than stepping back one
     layer into whatever screen happened to open the panel. */
  $("modal-home").addEventListener("click", navReset);
  $("modal-share").addEventListener("click", openShareCard);

  for (const node of document.querySelectorAll("[data-share-close]")) {
    node.addEventListener("click", navBack);
  }

  /* Seeking. The value is held while the thumb is down so an in-flight poll
     cannot yank it back under the finger. */
  const seek = $("np-seek");
  const holdSeek = () => { state.seeking = true; };
  seek.addEventListener("pointerdown", holdSeek);
  seek.addEventListener("keydown", holdSeek);
  seek.addEventListener("input", () => {
    /* Dragging, so the ticker is not painting: the waveform's played/unplayed
       split has to follow the thumb from here or it would sit frozen at the
       position the finger started from. */
    drawWave(Number(seek.value));
    fillRange(seek, Number(seek.value), Number(seek.max));
    $("np-cur").textContent = mmss(seek.value);
  });
  seek.addEventListener("change", () => {
    state.seeking = false;
    transport("seek", Number(seek.value));
  });

  /* Each speaker button opens the sheet belonging to its own bar. The mini
     bar's used to open Now playing and show that screen's slider, which took
     you off the screen you were on to change the volume on it. */
  for (const ids of VOL_SHEETS) {
    $(ids.button).addEventListener("click", (e) => {
      e.stopPropagation();
      const opening = $(ids.sheet).classList.contains("hidden");
      closeVolSheet();
      if (!opening) return;
      $(ids.sheet).classList.remove("hidden");
      $(ids.button).classList.add("is-open");
      $(ids.button).setAttribute("aria-expanded", "true");
    });

    const range = $(ids.range);
    range.addEventListener("pointerdown", () => { state.volDragging = true; });
    range.addEventListener("input", () => syncVolume(Number(range.value)));
    range.addEventListener("change", () => {
      state.volDragging = false;
      sendVolume(Number(range.value));
    });

    $(ids.minus).addEventListener("click", () => stepVolume(-1));
    $(ids.plus).addEventListener("click", () => stepVolume(+1));
  }

  /* A tap anywhere else puts the sheet away, the way the room sheet's backdrop
     does. The buttons stop their own clicks above, so opening never closes. */
  document.addEventListener("click", (e) => {
    if (!volSheetOpen()) return;
    if (e.target.closest(".vol-sheet")) return;
    closeVolSheet();
  });

  /* The room picker, from either bar. */
  $("np-device").addEventListener("click", () => openZoneSheet());
  $("mt-zone").addEventListener("click", () => openZoneSheet());

  /* Rooms */
  $("zone-refresh").addEventListener("click", () => openZoneSheet(true));
  for (const node of document.querySelectorAll("[data-close-sheet]")) {
    node.addEventListener("click", closeSheet);
  }

  /* The sleeve's overflow menu, and the one thing on it */
  $("album-more").addEventListener("click", openAlbumMenu);
  for (const node of document.querySelectorAll("[data-menu-close]")) {
    node.addEventListener("click", closeAlbumMenu);
  }
  $("album-edit").addEventListener("click", openEditDialog);

  /* Correcting a name */
  $("edit-save").addEventListener("click", saveEdit);
  for (const node of document.querySelectorAll("[data-edit-close]")) {
    node.addEventListener("click", closeEditDialog);
  }
  /* Enter saves, from either field. A dialog of two short fields is one a
     phone keyboard's Done key should be able to finish. */
  for (const field of [$("edit-title"), $("edit-artist")]) {
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveEdit(); }
    });
  }

  /* Escape closes whatever is on top, innermost first. */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    /* The side menu is not on the navigation stack — it is a menu, not a place
       you went — so it is closed here directly, one level at a time: Settings
       goes back to the menu, and the menu goes away. Everything else unwinds
       through the same Back the phone's gesture uses. */
    if (menuIsOpen()) {
      if (!$("menu-settings").classList.contains("hidden")) return showMenuView("main");
      return closeMenu();
    }
    /* The sleeve's menu, for the same reason and in the same way: it is not on
       the stack, so it is closed here rather than unwound. It cannot be open
       at the same time as the edit dialog — picking Edit closes it. */
    if (albumMenuOpen()) return closeAlbumMenu();
    if (volSheetOpen()) return closeVolSheet();
    navBack();
  });

  document.addEventListener("visibilitychange", () => { if (!document.hidden) pollNow(); });
  window.addEventListener("scroll", onScroll, { passive: true });
}

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

(function start() {
  let saved = "dark";
  try { saved = localStorage.getItem("musicd.theme") || "dark"; } catch { /* storage off */ }
  applyTheme(saved);

  /* Home is the default, because it is what every existing install already
     does — a preference that changes behaviour for people who never open it is
     not a preference. */
  let corner = "home";
  try { corner = localStorage.getItem(NP_LEFT_KEY) || "home"; } catch { /* storage off */ }
  applyNpLeft(corner);

  announceUpdateIfJustDone();
  state.zone = loadZone();

  wire();
  loadMenuRows();
  loadSort();
  startProgressTicker();
  registerServiceWorker();
  loadHome();
  refreshStatus();
  setInterval(refreshStatus, 30000);
  startPolling();
})();
