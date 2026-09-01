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
  now: null,
  grid: null,            // the row on screen, and how far into it we have read
  seeking: false,
  volDragging: false,    // a finger is on the volume slider
  volPending: null,      // { level, until, zone } — asked for, not yet echoed
  pollTimer: null,
  scanTimer: null,
  progressTimer: null,
  updateTimer: null,     // the poll watching an update through its restart
  positionAt: 0,
  build: null,
  checkedForUpdate: false
};

const ROW_TITLES = {
  library: "Library",
  random: "Random albums",
  added: "Recently added",
  played: "Recently played",
  unplayed: "Not played in 6 months",
  picks: "Smart Picks"
};

/* What an empty row means. Reaching one of these screens from the side menu
   skips Home, so the copy cannot live only in the Home payload — an empty
   grid with no explanation reads as a fault, and neither of these is one. */
const ROW_EMPTY = {
  library: "No albums scanned yet. Check your music folder is mounted, then rescan.",
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
  while (nav.length > depth) {
    const layer = nav.pop();
    try { layer.close(); }
    catch { /* a layer whose DOM has already gone — nothing left to close */ }
  }
});

/* ------------------------------------------------------------------ */
/*  Album cards                                                        */
/* ------------------------------------------------------------------ */

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

  const meta = el("div", "album-meta");
  meta.appendChild(el("div", "album-title", album.title));
  meta.appendChild(el("div", "album-artist", album.artist || "Unknown artist"));
  if (showReason && album.reason) meta.appendChild(el("div", "album-reason", album.reason));

  card.append(wrap, meta);
  card.addEventListener("click", () => openAlbum(album.id));
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
  window.scrollTo(0, 0);
}

/* Called by the navigation stack when a browse view is popped. */
function goHomeView() {
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
const PAGED_ROWS = new Set(["library", "added", "played", "unplayed"]);

async function openRow(key) {
  showView("grid", ROW_TITLES[key] || "Albums");
  const grid = $("album-grid");
  const empty = $("grid-empty");
  grid.textContent = "";
  empty.classList.add("hidden");
  for (let i = 0; i < 18; i++) grid.appendChild(skeletonCard());

  state.grid = { key, offset: 0, done: false, loading: false, first: true };
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
      grid.appendChild(albumCard(album, { showReason: g.key === "picks" }));
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

/* Near the bottom of a grid, fetch the next page. A scroll listener rather than
   an IntersectionObserver because the grid has no trailing sentinel to observe
   and adding one would need removing again on every view change. */
function onScroll() {
  if (state.view !== "grid" || !state.grid || state.grid.done) return;
  const remaining = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
  if (remaining < window.innerHeight) loadGridPage();
}

async function openArtist(name) {
  showView("grid", name);
  /* An artist's albums arrive in one go, so there is no pager here — and a
     pager left over from the row the user came from would append that row's
     next page onto this screen. */
  state.grid = null;
  const grid = $("album-grid");
  grid.textContent = "";
  $("grid-empty").classList.add("hidden");
  try {
    const data = await api("/api/artist/" + encodeURIComponent(name));
    for (const album of data.albums) grid.appendChild(albumCard(album));
  } catch (e) {
    toast(e.message, true);
  }
}

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
  $("np-artist").textContent = artist;
  $("np-album").textContent = album;
  const npImg = $("np-img");
  if (art) { npImg.src = art; npImg.classList.remove("hidden"); }
  else { npImg.removeAttribute("src"); npImg.classList.add("hidden"); }

  $("np-seek").max = Math.max(1, Math.round(now.duration || 0));
  $("np-tot").textContent = mmss(now.duration);
  /* Anchor the clock the ticker runs off, then let it do the drawing. */
  state.positionAt = Date.now();
  paintProgress();

  $("np-room").textContent = now.grouped
    ? `${now.coordinator.name} + ${now.members.length - 1}`
    : now.zone.name;

  /* Shuffle and repeat come back from the server already split out of Sonos'
     single play-mode enum. */
  $("np-shuffle").classList.toggle("is-on", !!now.shuffle);
  $("np-shuffle").setAttribute("aria-pressed", now.shuffle ? "true" : "false");

  const repeat = now.repeat || "off";
  $("np-repeat").classList.toggle("is-on", repeat !== "off");
  $("np-repeat").setAttribute("aria-pressed", repeat !== "off" ? "true" : "false");
  $("np-repeat").setAttribute("aria-label",
    repeat === "one" ? "Repeat one" : repeat === "all" ? "Repeat all" : "Repeat off");
  $("np-repeat-badge").classList.toggle("hidden", repeat !== "one");

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
  if (!state.zone) return;

  try {
    const q = await api("/api/queue?zone=" + encodeURIComponent(state.zone.uuid));
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
  /* The track already playing is not a jump target. */
  if (!isNow) li.addEventListener("click", () => jumpTo(item));
  return li;
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
  $("modal-back").classList.toggle("hidden", onNp);
  $("modal-home").classList.toggle("hidden", !onNp);

  for (const tab of document.querySelectorAll(".modal-tab")) {
    tab.classList.toggle("is-active", tab.getAttribute("data-tab") === face);
  }
  $("album-modal").querySelector(".modal-panel").scrollTop = 0;
  syncMini();
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
  $("mini").classList.toggle("hidden", onNpFace);
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

function renderAlbum(album) {
  const img = $("modal-img");
  if (album.art) { img.src = album.art; img.classList.remove("hidden"); }
  else { img.removeAttribute("src"); img.classList.add("hidden"); }

  $("modal-title").textContent = album.title;
  $("modal-subtitle").textContent = [album.artist, album.year].filter(Boolean).join(" · ");

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

    li.appendChild(el("span", "t-no", track.no ? String(track.no) : "·"));
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
    li.addEventListener("click", () => playAlbum(album.id, album.tracks.indexOf(track)));
    list.appendChild(li);
  }
  $("tracks-label").textContent = album.multiDisc ? "Tracks" : `Tracks (${album.tracks.length})`;
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
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  input.style.setProperty("--fill",
    `linear-gradient(90deg, var(--accent) 0 ${pct}%, var(--border) ${pct}% 100%)`);
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
      year: album.year
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
async function checkForUpdate(build, { manual = false } = {}) {
  if (!build || !build.version) return;
  let dismissed = "";
  try { dismissed = localStorage.getItem("musicd.dismissedUpdate") || ""; }
  catch { /* storage off — the notice simply reappears next load */ }

  try {
    if (manual) toast("Checking for updates…");
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { cache: "no-store" });
    if (!res.ok) throw new Error("GitHub answered " + res.status);
    const release = await res.json();
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

function showUpdateFailed(message) {
  updateBanner().classList.remove("is-busy");
  updateBanner().classList.add("is-error");
  $("update-text").textContent = "The update failed: " + message;
  $("update-now").disabled = false;
  $("update-now").textContent = "Try again";
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
      showUpdateFailed(status.apply.error || "no reason given");
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

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelector('meta[name="theme-color"]')
    .setAttribute("content", theme === "light" ? "#f6f5f2" : "#1d2125");
  $("theme-sub").textContent = theme === "light" ? "Light" : "Dark";
  try { localStorage.setItem("musicd.theme", theme); } catch { /* storage off */ }
}

/* ------------------------------------------------------------------ */
/*  Wiring                                                             */
/* ------------------------------------------------------------------ */

function wire() {
  /* Menu */
  $("menu-toggle").addEventListener("click", () => $("menu-overlay").classList.remove("hidden"));
  for (const node of document.querySelectorAll("[data-close-menu]")) {
    node.addEventListener("click", () => $("menu-overlay").classList.add("hidden"));
  }
  for (const node of document.querySelectorAll("[data-go]")) {
    node.addEventListener("click", () => {
      $("menu-overlay").classList.add("hidden");
      const target = node.getAttribute("data-go");
      if (target === "home") navReset();
      else if (target === "artists") openArtists();
      else if (target.startsWith("row:")) openRow(target.slice(4));
    });
  }

  $("menu-rescan").addEventListener("click", async () => {
    $("menu-overlay").classList.add("hidden");
    try {
      const r = await post("/api/rescan", {});
      toast(r.already ? "A scan is already running." : "Scanning your library…");
      refreshStatus();
    } catch (e) { toast(e.message, true); }
  });

  $("menu-update").addEventListener("click", () => {
    $("menu-overlay").classList.add("hidden");
    checkForUpdate(state.build, { manual: true });
  });

  $("menu-version").addEventListener("click", () => {
    const text = $("version-sub").textContent;
    if (!text) return;
    /* The one thing anybody wants from a version line is to paste it into a
       message about something not working. */
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText("MusicD Server " + text)
        .then(() => toast("Version copied."), () => toast(text));
    } else {
      toast(text);
    }
  });

  $("menu-theme").addEventListener("click", () => {
    applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
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
  $("btn-play").addEventListener("click", () => state.album && playAlbum(state.album.id, 0));
  $("btn-queue").addEventListener("click", () => state.album && queueAlbum(state.album.id));
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

  /* Shuffle toggles; repeat cycles off → all → one. Both are decided on the
     server, which reads the player's current mode before writing the new one —
     the two live in a single Sonos enum and would otherwise clear each other. */
  $("np-shuffle").addEventListener("click", () => transport("shuffle"));
  $("np-repeat").addEventListener("click", () => transport("repeat"));

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

  /* Escape closes whatever is on top, innermost first. */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    /* The side menu is not on the navigation stack — it is a menu, not a place
       you went — so it is closed here directly. Everything else unwinds
       through the same Back the phone's gesture uses. */
    if (!$("menu-overlay").classList.contains("hidden")) {
      return $("menu-overlay").classList.add("hidden");
    }
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

  announceUpdateIfJustDone();
  state.zone = loadZone();

  wire();
  startProgressTicker();
  registerServiceWorker();
  loadHome();
  refreshStatus();
  setInterval(refreshStatus, 30000);
  startPolling();
})();
