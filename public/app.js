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
  const mins = Math.round((Number(seconds) || 0) / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h} hr ${mins % 60} min`;
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
  volumeHeld: false,
  pollTimer: null,
  scanTimer: null
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
  state.view = view;
  for (const [name, id] of Object.entries({
    home: "home-view", grid: "grid-view", search: "search-view", artists: "artists-view"
  })) {
    $(id).classList.toggle("hidden", name !== view);
  }
  $("screen-title").textContent = title || "MusicD";
  $("topbar-back").classList.toggle("hidden", view === "home");
  window.scrollTo(0, 0);
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

  showView("home", "MusicD");
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
  const playing = state.now && (state.now.track || state.now.foreign);
  const onNpFace = state.face === "np" && !$("album-modal").classList.contains("hidden");
  $("mini").classList.toggle("hidden", !playing || onNpFace);
}

function openModal() { $("album-modal").classList.remove("hidden"); syncMini(); }
function closeModal() {
  $("album-modal").classList.add("hidden");
  closeVolSheet();
  setFace("album");
  syncMini();
}

function closeVolSheet() {
  $("np-vol-sheet").classList.add("hidden");
  $("np-volbtn").classList.remove("is-open");
  $("np-volbtn").setAttribute("aria-expanded", "false");
}

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

function fillRange(input, value, max) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  input.style.setProperty("--fill",
    `linear-gradient(90deg, var(--accent) 0 ${pct}%, var(--border) ${pct}% 100%)`);
}

function renderNow(now) {
  state.now = now;

  if (!now || (!now.track && !now.foreign)) {
    syncMini();
    return;
  }
  syncMini();

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
  $("mt-fill").style.width = now.duration ? `${(now.position / now.duration) * 100}%` : "0";
  setPlayIcons(playing);

  /* Now playing face */
  $("np-track").textContent = title;
  $("np-artist").textContent = artist;
  $("np-album").textContent = album;
  const npImg = $("np-img");
  if (art) { npImg.src = art; npImg.classList.remove("hidden"); }
  else { npImg.removeAttribute("src"); npImg.classList.add("hidden"); }

  const seek = $("np-seek");
  seek.max = Math.max(1, Math.round(now.duration || 0));
  if (!state.seeking) seek.value = Math.round(now.position || 0);
  fillRange(seek, Number(seek.value), Number(seek.max));
  $("np-cur").textContent = mmss(seek.value);
  $("np-tot").textContent = mmss(now.duration);

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

  if (now.volume !== null && !state.volumeHeld) {
    $("np-volume").value = now.volume;
    $("np-vol-value").textContent = now.volume;
    fillRange($("np-volume"), now.volume, 100);
  }
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
/*  Rooms                                                              */
/* ------------------------------------------------------------------ */

async function openZoneSheet(refresh = false) {
  $("zone-sheet").classList.remove("hidden");
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
        $("zone-btn").classList.add("is-set");
        $("zone-btn").title = room.name;
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

function closeSheet() { $("zone-sheet").classList.add("hidden"); }

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

    $("menu-foot").textContent =
      `MusicD Server v${status.version} · ${status.stats.albums} albums, ` +
      `${status.stats.tracks} tracks · ${status.sonos.rooms} Sonos room` +
      `${status.sonos.rooms === 1 ? "" : "s"} · ${status.time.zone}`;
  } catch (e) {
    banner("Cannot reach the server: " + e.message, true);
  }
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
      if (target === "home") loadHome();
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

  $("menu-theme").addEventListener("click", () => {
    applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
  });

  /* Navigation */
  $("topbar-back").addEventListener("click", () => {
    $("search-input").value = "";
    $("topbar-search").classList.remove("is-open");
    document.querySelector(".topbar-row").classList.remove("searching");
    loadHome();
  });

  /* Search */
  $("search-open").addEventListener("click", () => {
    $("topbar-search").classList.add("is-open");
    document.querySelector(".topbar-row").classList.add("searching");
    $("search-input").focus();
  });
  $("search-input").addEventListener("input", (e) => runSearch(e.target.value));
  $("search-clear").addEventListener("click", () => {
    $("search-input").value = "";
    $("topbar-search").classList.remove("is-open");
    document.querySelector(".topbar-row").classList.remove("searching");
    if (state.view === "search") loadHome();
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
  $("modal-home").addEventListener("click", () => { closeModal(); loadHome(); });

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

  const vol = $("np-volume");
  vol.addEventListener("pointerdown", () => { state.volumeHeld = true; });
  vol.addEventListener("input", () => {
    fillRange(vol, Number(vol.value), 100);
    $("np-vol-value").textContent = vol.value;
  });
  vol.addEventListener("change", async () => {
    state.volumeHeld = false;
    if (!state.zone) return;
    try { await post("/api/volume", { zone: state.zone.uuid, level: Number(vol.value) }); }
    catch (e) { toast(e.message, true); }
  });

  /* One speaker button, two jobs: it opens the slider, and a long press mutes.
     Keeping mute off the tap means the volume you were reaching for is never a
     mistap away from silence. */
  for (const id of ["np-volbtn", "mt-vol"]) {
    $(id).addEventListener("click", () => {
      const sheet = $("np-vol-sheet");
      const opening = sheet.classList.contains("hidden");
      if (id === "mt-vol" && opening) openNowPlaying("np");
      sheet.classList.toggle("hidden", !opening);
      $("np-volbtn").classList.toggle("is-open", opening);
      $("np-volbtn").setAttribute("aria-expanded", opening ? "true" : "false");
    });
  }

  /* The room picker, from either bar. */
  $("np-device").addEventListener("click", () => openZoneSheet());
  $("mt-zone").addEventListener("click", () => openZoneSheet());

  /* Rooms */
  $("zone-btn").addEventListener("click", () => openZoneSheet());
  $("zone-refresh").addEventListener("click", () => openZoneSheet(true));
  for (const node of document.querySelectorAll("[data-close-sheet]")) {
    node.addEventListener("click", closeSheet);
  }

  /* Escape closes whatever is on top, innermost first. */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("zone-sheet").classList.contains("hidden")) return closeSheet();
    if (!$("np-vol-sheet").classList.contains("hidden")) return closeVolSheet();
    if (!$("album-modal").classList.contains("hidden")) return closeModal();
    if (!$("menu-overlay").classList.contains("hidden")) return $("menu-overlay").classList.add("hidden");
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

  state.zone = loadZone();
  if (state.zone) {
    $("zone-btn").classList.add("is-set");
    $("zone-btn").title = state.zone.name;
  }

  wire();
  loadHome();
  refreshStatus();
  setInterval(refreshStatus, 30000);
  startPolling();
})();
