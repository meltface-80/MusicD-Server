"use strict";
/*
 * artfind.js — looking for a missing cover on the web.
 *
 * Three catalogues with open, key-free search: Apple's (iTunes Search), Deezer
 * and MusicBrainz with the Cover Art Archive. Each hit is scored against the
 * album as it is on disk — its title, its artist and, most tellingly, its
 * track names: a record with the same songs in it is the same record, however
 * the title is spelled. Only a hit that agrees on all three is "sure" and
 * picked without asking; anything less is offered as a suggestion.
 */
const N = require("./normalize");
const META = require("../meta");

const SURE = { tracks: 0.6, artist: 0.8, title: 0.8 };

// ------------------------------------------------------------ comparison

// Drops every bracketed part, not just edition noise: "Untitled #1 (Vaka)"
// and "Untitled 1" are one song across catalogues.
function bare(s) {
  return N.fold(String(s || "").replace(/\s*[([][^)\]]*[)\]]\s*/g, " "));
}

function dice(a, b) {
  const A = a.split(" ").filter(Boolean), B = b.split(" ").filter(Boolean);
  if (!A.length || !B.length) return 0;
  const pool = B.slice();
  let hit = 0;
  for (const t of A) {
    const i = pool.indexOf(t);
    if (i >= 0) { hit++; pool.splice(i, 1); }
  }
  return (2 * hit) / (A.length + B.length);
}

function sameText(a, b) {
  const la = N.loose(a), lb = N.loose(b);
  if (!la && !lb) return 1;
  if (!la || !lb) return 0;
  if (la === lb || bare(a) === bare(b)) return 1;
  return dice(la, lb);
}

function sameArtist(a, b) {
  const fa = N.fold(a), fb = N.fold(b);
  if (!fa || !fb) return 0;
  if (fa === fb) return 1;
  const sa = N.sortName(a), sb = N.sortName(b);
  if (sa === sb) return 1;
  if (fa.includes(fb) || fb.includes(fa)) return 0.9;
  const names = N.splitArtists(a).map(N.fold);
  if (names.includes(fb)) return 0.9;
  return dice(fa, fb);
}

// What share of the album's own tracks turn up in the candidate's list.
function trackMatch(local, remote) {
  if (!local.length || !remote || !remote.length) return null;
  const r = remote.map(t => ({ l: N.loose(t), b: bare(t) }));
  let hit = 0;
  for (const t of local) {
    const l = N.loose(t), b = bare(t);
    if (!l && !b) continue;
    if (r.some(x => x.l === l || (b && x.b === b) || dice(l, x.l) >= 0.8)) hit++;
  }
  return hit / local.length;
}

function score(c, al, localTracks) {
  const titleKnown = !!N.loose(al.title);
  c.match = {
    title: titleKnown ? sameText(al.title, c.title) : null,
    artist: sameArtist(al.artist, c.artist),
    tracks: trackMatch(localTracks, c.trackList)
  };
  const t = c.match.title == null ? 0.5 : c.match.title;
  c.score = c.match.tracks == null
    ? 0.9 * (0.55 * t + 0.45 * c.match.artist)
    : 0.3 * t + 0.25 * c.match.artist + 0.45 * c.match.tracks;
  c.sure = c.match.tracks != null && c.match.tracks >= SURE.tracks &&
           c.match.artist >= SURE.artist && (c.match.title == null || c.match.title >= SURE.title);
  return c;
}

// --------------------------------------------------------------- sources

const hi = url => String(url || "").replace(/\/\d+x\d+(bb)?\.(jpg|png|webp)$/i, "/1200x1200bb.jpg");

async function itunes(al, localTracks, get) {
  const out = new Map();
  const add = (r) => {
    if (!r || !r.collectionId || !r.artworkUrl100 || out.has(r.collectionId)) return;
    out.set(r.collectionId, {
      source: "Apple Music", id: String(r.collectionId),
      title: r.collectionName || "", artist: r.artistName || "",
      year: r.releaseDate ? Number(String(r.releaseDate).slice(0, 4)) : null,
      trackCount: r.trackCount || null,
      url: hi(r.artworkUrl100), thumb: String(r.artworkUrl100).replace(/100x100bb/, "300x300bb"),
      tracks: () => get(`https://itunes.apple.com/lookup?id=${r.collectionId}&entity=song&limit=200`)
        .then(j => (j.results || []).filter(x => x.wrapperType === "track").map(x => x.trackName))
    });
  };
  const term = [al.artist, al.title].filter(Boolean).join(" ");
  const jobs = [get(`https://itunes.apple.com/search?media=music&entity=album&limit=8&term=${encodeURIComponent(term)}`)
    .then(j => (j.results || []).forEach(add))];
  // By a song as well: finds the record when its title is a symbol, a blank
  // or spelled differently from the catalogue's.
  const song = localTracks.find(t => bare(t).length > 3);
  if (song) {
    jobs.push(get(`https://itunes.apple.com/search?media=music&entity=song&limit=10&term=${encodeURIComponent(al.artist + " " + song)}`)
      .then(j => (j.results || []).forEach(add)));
  }
  await Promise.allSettled(jobs);
  return [...out.values()];
}

async function deezer(al, localTracks, get) {
  const q = N.loose(al.title)
    ? `artist:"${al.artist}" album:"${al.title}"`
    : `${al.artist} ${localTracks[0] || ""}`;
  let j = await get(`https://api.deezer.com/search/album?limit=8&q=${encodeURIComponent(q)}`).catch(() => null);
  if (!j || !(j.data || []).length) {
    j = await get(`https://api.deezer.com/search/album?limit=8&q=${encodeURIComponent(al.artist + " " + al.title)}`).catch(() => null);
  }
  return ((j && j.data) || []).filter(r => r.cover_xl).map(r => ({
    source: "Deezer", id: String(r.id),
    title: r.title || "", artist: (r.artist && r.artist.name) || "",
    year: null, trackCount: r.nb_tracks || null,
    url: r.cover_xl, thumb: r.cover_big || r.cover_medium || r.cover_xl,
    tracks: () => get(`https://api.deezer.com/album/${r.id}/tracks?limit=200`).then(t => (t.data || []).map(x => x.title))
  }));
}

async function musicbrainz(al, localTracks, get) {
  if (!N.loose(al.title)) return [];
  const q = `release:"${al.title.replace(/"/g, "")}" AND artist:"${al.artist.replace(/"/g, "")}"`;
  const j = await get(`https://musicbrainz.org/ws/2/release/?fmt=json&limit=6&query=${encodeURIComponent(q)}`, true);
  const out = [], seen = new Set();
  for (const r of (j.releases || [])) {
    const rg = r["release-group"] && r["release-group"].id;
    if (!rg || seen.has(rg)) continue;
    seen.add(rg);
    out.push({
      source: "MusicBrainz", id: rg,
      title: r.title || "", artist: ((r["artist-credit"] || [])[0] || {}).name || "",
      year: r.date ? Number(String(r.date).slice(0, 4)) || null : null,
      trackCount: r["track-count"] || null,
      url: `https://coverartarchive.org/release-group/${rg}/front-1200`,
      thumb: `https://coverartarchive.org/release-group/${rg}/front-250`,
      // Not every release group has a cover: ask the archive before offering it.
      check: () => get(`https://coverartarchive.org/release-group/${rg}`).then(x => !!(x.images || []).length).catch(() => false)
    });
    if (out.length >= 3) break;
  }
  return out;
}

// ------------------------------------------------------------------ find

function defaultGet(url, isMb) {
  return META.httpJson(url, { "User-Agent": META.MB_USER_AGENT, "Accept": "application/json" }, 9000);
}

/* → { sure: candidate|null, candidates: [...] }, best first. */
async function find(al, trackTitles, { get = defaultGet, log = () => {} } = {}) {
  const local = (trackTitles || []).filter(Boolean);
  const lists = await Promise.allSettled([
    itunes(al, local, get), deezer(al, local, get), musicbrainz(al, local, get)
  ]);
  lists.forEach((l, i) => { if (l.status === "rejected") log(`[art] ${["itunes", "deezer", "musicbrainz"][i]}: ${l.reason && l.reason.message}`); });
  let all = lists.flatMap(l => l.status === "fulfilled" ? l.value : []);

  // A first pass on names alone decides whose track lists are worth fetching.
  all.forEach(c => score(c, al, local));
  all.sort((a, b) => b.score - a.score);
  const detail = all.slice(0, 8);
  await Promise.allSettled(detail.map(async c => {
    if (c.tracks) { c.trackList = await c.tracks().catch(() => null); score(c, al, local); }
    if (c.check && !(await c.check())) c.dead = true;
  }));
  all = all.filter(c => !c.dead);
  all.sort((a, b) => (b.sure - a.sure) || (b.score - a.score));

  const seen = new Set();
  const candidates = [];
  for (const c of all) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    candidates.push({
      source: c.source, title: c.title, artist: c.artist, year: c.year,
      tracks: c.trackList ? c.trackList.length : c.trackCount,
      url: c.url, thumb: c.thumb,
      score: Math.round(c.score * 100) / 100,
      match: {
        title: c.match.title == null ? null : Math.round(c.match.title * 100) / 100,
        artist: Math.round(c.match.artist * 100) / 100,
        tracks: c.match.tracks == null ? null : Math.round(c.match.tracks * 100) / 100
      },
      sure: !!c.sure
    });
    if (candidates.length >= 12) break;
  }
  return { sure: candidates[0] && candidates[0].sure ? candidates[0] : null, candidates };
}

module.exports = { find, trackMatch, sameText, sameArtist, bare };
