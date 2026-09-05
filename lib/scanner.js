/*
 * MusicD Server — the library scan.
 *
 * The rule this file exists to enforce: an album is a folder. There is no
 * metadata service, no release matching, no disambiguation pass. Whatever the
 * tags say is what the library shows, and where the tags say nothing the
 * folder name is used. A folder that holds audio files is an album; a folder
 * that holds only other folders is not.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { albumKey, trackKey, TAG_SCHEMA } = require("./db");

const AUDIO_EXT = new Set([
  ".flac", ".mp3", ".m4a", ".aac", ".alac", ".wav", ".wave",
  ".aif", ".aiff", ".aifc", ".ogg", ".oga", ".opus", ".wma", ".mpc"
]);

const MIME_BY_EXT = {
  ".mp3": "audio/mpeg",   ".m4a": "audio/mp4",  ".aac": "audio/aac",
  ".alac": "audio/mp4",   ".flac": "audio/flac", ".wav": "audio/wav",
  ".wave": "audio/wav",   ".aif": "audio/aiff", ".aiff": "audio/aiff",
  ".aifc": "audio/aiff",  ".ogg": "audio/ogg",  ".oga": "audio/ogg",
  ".opus": "audio/ogg",   ".wma": "audio/x-ms-wma", ".mpc": "audio/x-musepack"
};

/* Sonos will not play what it cannot decode, and a silent failure at the
   speaker is much harder to explain than a badge in the UI. These are the
   containers current S2 firmware accepts over HTTP. */
const SONOS_PLAYABLE = new Set([
  ".flac", ".mp3", ".m4a", ".aac", ".alac", ".wav", ".wave",
  ".aif", ".aiff", ".aifc", ".ogg", ".oga"
]);

/* Cover files, in the order a folder is searched. Names are matched
   case-insensitively — "Folder.jpg" is what Windows writes. */
const ART_NAMES = ["cover", "folder", "front", "album", "albumart", "artwork"];
const ART_EXT = [".jpg", ".jpeg", ".png", ".webp"];

const IGNORE_DIRS = new Set([
  "@eaDir", ".git", ".svn", "#recycle", "$RECYCLE.BIN",
  "lost+found", ".AppleDouble", ".Trashes", "node_modules"
]);

function mimeFor(ext) { return MIME_BY_EXT[ext] || "audio/mpeg"; }
function playableBySonos(ext) { return SONOS_PLAYABLE.has(ext); }

/* Sorting keys. A leading article is dropped so "The Beatles" files under B,
   which is what a record shelf does and what the browse rows assume. */
function sortKey(s) {
  return String(s || "").toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
}

/* ------------------------------------------------------------------ */
/*  Multi-disc folders                                                 */
/* ------------------------------------------------------------------ */

/*
 * A disc marker: "Disc", "Disk" or "CD", then a number, with or without a
 * space between them, in any case. An optional "of 3" is allowed because
 * "Disc 1 of 3" is a common way to write it.
 */
const DISC_WORD = "(?:disc|disk|cd)";
const DISC_NUMBER = "\\s*[-_.]?\\s*(\\d{1,3})(?:\\s*(?:of|/)\\s*\\d{1,3})?";

/* The whole folder name is a disc marker — "Disc 1", "CD2", "cd 3 of 4" —
   optionally followed by a subtitle after a dash or colon, as in
   "CD1 - Early Sessions". The album is then the folder ABOVE this one. */
const PURE_DISC = new RegExp(
  `^[([\\[]?\\s*${DISC_WORD}${DISC_NUMBER}\\s*[)\\]]?(?:\\s*[-–—:_.]\\s*.*)?$`, "i");

/* The folder names the album AND a disc — "Kid A Disc 1", "Kid A - CD2",
   "Kid A (Disc 1)". Sibling folders sharing that album name are one album.
   The marker has to be at the END; anything before it is the album's name. */
const NAMED_DISC = new RegExp(
  `^(.*?)[\\s._\\-–—]*[([\\[]?\\s*${DISC_WORD}${DISC_NUMBER}\\s*[)\\]]?\\s*$`, "i");

/*
 * Read a folder name as a disc of some album.
 *
 * Returns `{ album, disc }` — `album` empty when the folder names only a disc
 * (so the album is its parent), or the album's name when the folder carries
 * both. `null` when the name is not a disc folder at all.
 *
 * "Discovery" and "Disco 2000" do not match: the word has to be followed by a
 * number, with only a separator allowed between them.
 */
function parseDiscFolder(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;

  const pure = PURE_DISC.exec(trimmed);
  if (pure) return { album: "", disc: Number(pure[1]) };

  const named = NAMED_DISC.exec(trimmed);
  if (named && named[1].trim()) {
    return { album: named[1].trim().replace(/[-–—_.\s]+$/, ""), disc: Number(named[2]) };
  }
  return null;
}

/*
 * Walk a music root.
 *
 * `seen` holds the real path of every directory already visited, which is what
 * makes following symlinks safe: a library assembled out of links to a NAS is
 * completely ordinary, and readdir reports a link as neither a file nor a
 * directory, so testing isDirectory() alone makes those albums invisible. The
 * depth limit stays as a second line of defence.
 */
async function walk(root, out, depth = 0, seen = new Set()) {
  if (depth > 12) return out;
  let real;
  try { real = await fsp.realpath(root); }
  catch (e) {
    console.warn("[scan] cannot resolve " + root + " — " + e.message);
    return out;
  }
  if (seen.has(real)) return out;                  // a link back up the tree
  seen.add(real);

  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch (e) {
    /* Not silent: an unreadable subtree (permissions, a half-mounted NAS) would
       otherwise be indistinguishable from an empty one, and the absent-marking
       pass at the end of the scan would quietly take those albums out of the UI
       with nothing in the log to connect the two. */
    console.warn("[scan] cannot read " + root + " — " + e.message);
    return out;
  }

  const files = [];
  for (const e of entries) {
    if (e.name.startsWith("._")) continue;         // macOS resource forks
    const full = path.join(root, e.name);

    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const st = await fsp.stat(full);           // follows the link
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        /* A broken link. Nothing to scan and nothing to warn about — a dangling
           symlink in a music folder is housekeeping, not a fault. */
        continue;
      }
    }

    if (isDir) {
      if (IGNORE_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      await walk(full, out, depth + 1, seen);
    } else if (isFile) {
      files.push(e.name);
    }
  }
  const audio = files.filter(n => AUDIO_EXT.has(path.extname(n).toLowerCase()));
  if (audio.length) out.push({ dir: root, files: audio, all: files });
  return out;
}

/* A conventionally named cover — cover.jpg, folder.png — in this folder. */
function namedArtFile(folder) {
  const lower = new Map();
  for (const n of folder.all) lower.set(n.toLowerCase(), n);
  for (const base of ART_NAMES) {
    for (const ext of ART_EXT) {
      const hit = lower.get(base + ext);
      if (hit) return path.join(folder.dir, hit);
    }
  }
  return "";
}

/* Nothing conventionally named — take the first image in the folder rather
   than showing a blank tile when a cover is plainly sitting there. */
function anyArtFile(folder) {
  for (const n of folder.all) {
    if (ART_EXT.includes(path.extname(n).toLowerCase())) return path.join(folder.dir, n);
  }
  return "";
}

/*
 * The album artist, decided once for the whole folder.
 *
 * Tags disagree far more often than they agree, so this works down a ladder
 * and stops at the first rung that gives a straight answer:
 *
 *   1. the album-artist tag, if the folder agrees about it;
 *   2. the album-artist tag that MOST tracks carry, when a few disagree —
 *      one mistagged track on a twelve-track album should not rename it;
 *   3. the track artist, if the folder agrees about that;
 *   4. Various Artists, when the track artists genuinely differ;
 *   5. the folder the album sits in, because `Artist/Album/` is how most
 *      libraries are laid out and the name is right there.
 *
 * Only a folder that offers none of those is left blank.
 */
function deriveAlbumArtist(tracks, dir, roots) {
  const albumArtists = tracks.map(t => t.albumartist).filter(Boolean);
  const distinctAlbumArtists = new Set(albumArtists);
  if (distinctAlbumArtists.size === 1) return albumArtists[0];
  if (distinctAlbumArtists.size > 1) {
    /* A clear majority is the album's artist; a real split is a compilation. */
    const winner = commonest(albumArtists);
    const votes = albumArtists.filter(a => a === winner).length;
    if (votes / albumArtists.length > 0.6) return winner;
    return "Various Artists";
  }

  const artists = tracks.map(t => t.artist).filter(Boolean);
  const distinctArtists = new Set(artists);
  if (distinctArtists.size === 1) return artists[0];
  if (distinctArtists.size > 1) return "Various Artists";

  return artistFromFolder(dir, roots);
}

/*
 * A FOLDER THAT HOLDS AN ARTIST'S RECORDS RATHER THAN ONE RECORD.
 *
 * "R.E.M. - Discography", "Peter Gabriel - Studio Discography", or plain
 * "Discography" under the artist's own folder. It is a very common way to keep
 * a collection, and it is how a library ends up filing every Peter Gabriel
 * album under an artist called "Peter Gabriel - Studio Discography" — a name
 * that matches nothing at MusicBrainz, nothing at the iTunes store and nothing
 * in a Wikipedia search, so every album under it loses its cover and its
 * write-up at once.
 *
 * Nothing is looked up. The name is read exactly the way titleFromFolder reads
 * a trailing year: by a vocabulary that has to match WHOLLY, so a word that is
 * not in it means "this is part of the name" and the folder is left alone.
 *
 * Returns the artist the folder names, "" when the folder is nothing BUT a
 * container (so the artist is a level further up), and null when it is not a
 * container at all.
 */
const CONTAINER_WORDS = new Set([
  "discography", "discographies", "discografia", "albums", "collection",
  "collections", "anthology", "works", "catalogue", "catalog"
]);
/* Only ever allowed to keep a container word company. A tail of nothing but
   these — "(The Studio)" — is not a container. */
const CONTAINER_FILLERS = new Set([
  "studio", "full", "complete", "entire", "the", "of", "all", "official",
  "box", "set", "part", "and", "eps", "singles"
]);

function readContainer(name) {
  const words = String(name || "").trim().split(/[\s_]+/).filter(Boolean);
  if (!words.length) return null;
  /* Walk in from the END: the longest run of container-vocabulary words that
     includes at least one word actually MEANING a container. */
  let i = words.length;
  let seenContainer = false;
  while (i > 0) {
    const word = words[i - 1].toLowerCase().replace(/^[([]|[)\]]$/g, "");
    if (CONTAINER_WORDS.has(word)) { seenContainer = true; i--; continue; }
    if (CONTAINER_FILLERS.has(word)) { i--; continue; }
    break;
  }
  if (!seenContainer) return null;
  /* What is left in front of it, with the separator that introduced the
     container taken off: "R.E.M. -" becomes "R.E.M.". */
  const head = words.slice(0, i).join(" ").replace(/[\s\-–—:_.]+$/, "").trim();
  return head;
}

/* The album's parent directory, when it looks like an artist name rather than
   a music root or a drive. No lookup and no guessing at what the name MEANS —
   just the one piece of information the layout is already carrying. */
function artistFromFolder(dir, roots = []) {
  const isRoot = (p) => roots.some(root => path.resolve(root) === path.resolve(p));
  /* At most two levels: the album's parent, and its parent when that one turns
     out to be a container and nothing else. Deeper than that and the name is
     no longer describing this record. */
  let parent = path.dirname(dir);
  for (let up = 0; up < 2; up++) {
    if (!parent || parent === path.dirname(parent)) return "";
    /* The folder directly under a music root is the album itself, so its
       parent is the root and names no artist. */
    if (isRoot(parent)) return "";
    const name = path.basename(parent).trim();
    /* Names that mean "no artist" rather than naming one, plus the obvious
       container folders. A directory called Unknown is saying the same thing a
       missing tag says. */
    if (!name || /^(music|albums?|media|library|flac|mp3|various(\s*artists)?|va|compilations?|unknown(\s*artists?)?|disc\s*\d+|cd\s*\d+)$/i.test(name)) {
      return "";
    }
    const head = readContainer(name);
    if (head === null) return name;      // an ordinary folder: it is the artist
    if (head) return head;               // "R.E.M. - Discography" names R.E.M.
    parent = path.dirname(parent);       // just "Discography": look one higher
  }
  return "";
}

function deriveAlbumTitle(tracks, dir, artist = "") {
  const titles = tracks.map(t => t.album).filter(Boolean);
  const distinct = new Set(titles);
  if (distinct.size === 1) return titles[0];
  if (distinct.size > 1) {
    const winner = commonest(titles);
    if (titles.filter(t => t === winner).length / titles.length > 0.6) return winner;
  }
  /* Disagreeing or absent album tags: the folder name is the honest answer —
     minus the artist, when the folder repeats it. A TAG is left exactly as it
     is; this is the fallback path only, because a record really called
     "Peter Gabriel" exists and a tag saying so is evidence while a folder in
     an artist's own directory saying so is a filing convention. */
  return withoutArtist(titleFromFolder(dir).title, artist);
}

/*
 * "Peter Gabriel - Scratch My Back 2010" under an artist folder is an album
 * called "Scratch My Back". The prefix is a filing habit, and left in it is
 * searched for verbatim — which finds nothing, at every source this app has.
 *
 * Only when the artist is named IN FULL and something is left after it, so
 * "Peter Gabriel" the album keeps its name and "Peter Gabriel - 1" does not
 * become "1"... it does, and that is right: the folder said which record it is.
 */
function withoutArtist(title, artist) {
  const who = String(artist || "").trim();
  if (!who || !title) return title;
  const sep = "[\\s]*[-–—:_][\\s]*";
  const re = new RegExp("^" + who.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + sep, "i");
  const rest = title.replace(re, "").trim();
  return rest || title;
}

/* A folder name, tidied into an album title. Two conventions are common enough
   to be worth reading rather than showing raw: a leading "01 - " index, and a
   trailing year — "Deceiver (2021)" is an album called Deceiver released in
   2021, and showing the year inside the title puts it in the sort order too. */
function titleFromFolder(dir) {
  const raw = path.basename(dir);
  let name = raw.replace(/^\d{1,4}\s*[-–.]\s*/, "").trim();
  let year = null;
  /*
   * A trailing year has to be MARKED as one — bracketed, or set off by a dash,
   * underscore or dot. A bare space and four digits is part of the title far
   * too often to strip: "Disco 2000", "Blade Runner 2049", "Summer 1993".
   */
  const trailing = /(?:[([]((?:19|20)\d{2})[)\]]|[\s]*[-–—_.][\s]*((?:19|20)\d{2}))$/.exec(name);
  if (trailing) {
    const stripped = name.slice(0, trailing.index).trim().replace(/[-–_.\s]+$/, "");
    /* Only when something is left: a folder actually named "1999" keeps it. */
    if (stripped) { name = stripped; year = Number(trailing[1] || trailing[2]); }
  }
  return { title: name || raw, year };
}

/*
 * A release date, normalised to ISO and kept only as precisely as the tag
 * gives it: "2025-09-23", "2025-09" or "2025".
 *
 * Tags are written by hand as often as by a ripper, so this is deliberately
 * narrow — anything that is not plainly a date is no date at all rather than
 * something to guess at. A day of 00, which some taggers write to mean "no
 * day", is dropped rather than turned into the last of the month before.
 */
function isoDate(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  const m = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?$/.exec(raw);
  if (!m) return "";
  const year = Number(m[1]);
  if (year < 1000 || year > 2999) return "";
  if (m[2] === undefined) return String(year);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return String(year);
  const pad = (n) => String(n).padStart(2, "0");
  if (m[3] === undefined) return `${year}-${pad(month)}`;
  const day = Number(m[3]);
  if (day < 1 || day > new Date(year, month, 0).getDate()) return `${year}-${pad(month)}`;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/* The album's date is the one its files agree on, and only when it agrees with
   the year already worked out — a compilation whose tracks each carry their
   own original release date has no one date, and the year is what it gets. */
function deriveReleaseDate(rows, year) {
  const dates = rows.map(r => r.releaseDate).filter(Boolean);
  if (!dates.length) return "";
  const winner = commonest(dates);
  if (!winner || dates.some(d => d !== winner)) return "";
  if (year && Number(winner.slice(0, 4)) !== Number(year)) return "";
  return winner;
}

function commonest(values) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = "", bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}

/*
 * Fold the audio folders into albums, so a record split across "Disc 1" and
 * "Disc 2" is one album rather than two.
 *
 * Two layouts, both common:
 *   Album/Disc 1/, Album/Disc 2/     — the disc folders sit inside the album
 *   Album Disc 1/, Album Disc 2/     — siblings, each carrying the album name
 *
 * The first collapses onto the parent; the second onto the parent plus the
 * album name the folders share, which is a path that need not exist on disk —
 * it is an identity, not a location. A folder that is only a disc marker
 * sitting directly in a music root has no album above it, so it stays its own
 * album rather than swallowing the root.
 */
function groupIntoAlbums(folders, roots) {
  const groups = new Map();
  for (const folder of folders) {
    const parsed = parseDiscFolder(path.basename(folder.dir));
    let albumDir = folder.dir;
    let disc = 0;

    if (parsed) {
      const parent = path.dirname(folder.dir);
      const parentIsRoot = roots.some(root => path.resolve(root) === path.resolve(parent));
      if (parsed.album) {
        albumDir = path.join(parent, parsed.album);
        disc = parsed.disc;
      } else if (!parentIsRoot) {
        albumDir = parent;
        disc = parsed.disc;
      }
    }

    if (!groups.has(albumDir)) groups.set(albumDir, { dir: albumDir, parts: [] });
    groups.get(albumDir).parts.push({ folder, disc });
  }
  /* Lowest disc first, so the album's own folder — or disc one — leads, and
     the cover found there is the one used. */
  for (const group of groups.values()) {
    group.parts.sort((a, b) => a.disc - b.disc || a.folder.dir.localeCompare(b.folder.dir));
  }
  return groups;
}

/* The folder above a set of disc folders is where most rips put the cover, and
   the walk never listed it as an album, so it has to be read here. The path
   may not exist at all: a sibling layout's album folder is an identity worked
   out from the names, not a place. */
function listAlbumDir(dir) {
  try { return { dir, all: fs.readdirSync(dir) }; }
  catch { return { dir, all: [] }; }   /* no such folder, or unreadable */
}

/*
 * One pass over the configured roots. Existing rows are matched by path, so a
 * file whose size and mtime are unchanged is never re-parsed — a rescan of an
 * untouched 60,000-track library costs a directory walk and nothing else.
 */
async function scan(db, roots, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const artDir = opts.artDir;
  const parseFile = (await import("music-metadata")).parseFile;
  const started = Date.now();

  const folders = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      console.warn("[scan] music folder does not exist, skipping: " + root);
      continue;
    }
    await walk(root, folders);
  }
  folders.sort((a, b) => a.dir.localeCompare(b.dir));

  const relTo = (p) => {
    for (const root of roots) {
      const rel = path.relative(root, p);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
    }
    return p;
  };

  /* Every column the reuse path needs, read once. Re-preparing and re-running a
     per-track SELECT inside the loop is what turned "a rescan of an untouched
     library costs a directory walk" into sixty thousand statement
     compilations. */
  const existingTracks = new Map();
  for (const r of db.prepare(
    `SELECT id, path, mtime, size, album_id, title, artist, albumartist, album_tag, mbid,
            genre, year, release_date, disc, no, duration, mime, bitdepth, samplerate,
            tags_read
     FROM tracks`).all()) {
    existingTracks.set(r.id, r);
  }

  const existingAlbums = new Map();
  for (const r of db.prepare("SELECT id, title, artist, year, genre, added_at, play_count, last_played_at FROM albums").all()) {
    existingAlbums.set(r.id, r);
  }

  const upsertAlbum = db.prepare(`
    INSERT INTO albums (id, dir, title, artist, sort_title, sort_artist, year,
                        release_date, genre,
                        track_count, duration, art, added_at, present, seen_at)
    VALUES (@id, @dir, @title, @artist, @sort_title, @sort_artist, @year,
            @release_date, @genre,
            @track_count, @duration, @art, @added_at, 1, @seen_at)
    ON CONFLICT(id) DO UPDATE SET
      dir = excluded.dir, title = excluded.title, artist = excluded.artist,
      sort_title = excluded.sort_title, sort_artist = excluded.sort_artist,
      year = excluded.year, release_date = excluded.release_date,
      genre = excluded.genre,
      track_count = excluded.track_count, duration = excluded.duration,
      art = excluded.art, present = 1, seen_at = excluded.seen_at`);

  const upsertTrack = db.prepare(`
    INSERT INTO tracks (id, album_id, path, rel, title, artist, albumartist, album_tag, mbid,
                        genre, year, release_date, disc, no, duration, mime, bitdepth,
                        samplerate, size, mtime, added_at, present, tags_read)
    VALUES (@id, @album_id, @path, @rel, @title, @artist, @albumartist, @album_tag, @mbid,
            @genre, @year, @release_date, @disc, @no, @duration, @mime, @bitdepth,
            @samplerate, @size, @mtime, @added_at, 1, @tags_read)
    ON CONFLICT(id) DO UPDATE SET
      album_id = excluded.album_id, path = excluded.path, rel = excluded.rel,
      title = excluded.title, artist = excluded.artist,
      albumartist = excluded.albumartist, album_tag = excluded.album_tag,
      mbid = excluded.mbid,
      genre = excluded.genre, year = excluded.year,
      release_date = excluded.release_date, disc = excluded.disc,
      no = excluded.no, duration = excluded.duration, mime = excluded.mime,
      bitdepth = excluded.bitdepth, samplerate = excluded.samplerate,
      size = excluded.size, mtime = excluded.mtime, present = 1,
      tags_read = excluded.tags_read`);

  const seenAlbums = new Set();
  const seenTracks = new Set();
  let parsed = 0, reused = 0, done = 0;

  const groups = groupIntoAlbums(folders, roots);

  for (const group of groups.values()) {
    done++;
    if (done % 25 === 0 || done === groups.size) {
      onProgress({ done, total: groups.size, dir: group.dir });
    }

    const id = albumKey(relTo(group.dir));
    const rows = [];

    for (const part of group.parts) {
      const folder = part.folder;
      for (const name of folder.files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
        const full = path.join(folder.dir, name);
        const ext = path.extname(name).toLowerCase();
        let st;
        /* The file went away between readdir and here — a move or a delete
           mid-scan. It simply is not part of this pass. */
        try { st = await fsp.stat(full); } catch { continue; }

        const tid = trackKey(relTo(full));
        const prev = existingTracks.get(tid);
        const mtime = Math.trunc(st.mtimeMs);

        if (prev && prev.mtime === mtime && prev.size === st.size &&
            prev.tags_read >= TAG_SCHEMA) {
          /* Untouched since the last scan, AND read by a version that stored
             everything this one needs. The tags_read check is what makes adding
             a tag column work at all: the mtime test alone would skip the file
             forever and leave the new column empty, which is how a rescan came to
             replace correct album titles and artists with the folder name and
             "Unknown artist". */
          rows.push({
            id: tid, path: full, rel: relTo(full), name, ext,
            title: prev.title, artist: prev.artist,
            albumartist: prev.albumartist, album: prev.album_tag, mbid: prev.mbid,
            genre: prev.genre, year: prev.year, releaseDate: prev.release_date,
            disc: prev.disc, no: prev.no, duration: prev.duration, mime: prev.mime,
            bitdepth: prev.bitdepth, samplerate: prev.samplerate,
            size: st.size, mtime, folderDisc: part.disc, reused: true
          });
          reused++;
          continue;
        }

        let tags = {}, fmt = {};
        try {
          const md = await parseFile(full, { duration: true, skipCovers: true });
          tags = md.common || {};
          fmt = md.format || {};
        } catch (e) {
          /* An unreadable tag block is not a reason to hide the file — the
             filename alone is enough to list and play it. */
          console.warn("[scan] could not read tags: " + full + " — " + e.message);
        }
        parsed++;

        rows.push({
          id: tid, path: full, rel: relTo(full), name, ext,
          title: tags.title || path.basename(name, path.extname(name)),
          artist: tags.artist || "",
          albumartist: tags.albumartist || "",
          album: tags.album || "",
          /* The MusicBrainz release id, when the file carries one. music-metadata
             normalises the many spellings the formats use — MUSICBRAINZ_ALBUMID
             in Vorbis comments, the MusicBrainz Album Id TXXX frame in ID3 — into
             this one field. */
          mbid: String(tags.musicbrainz_albumid || "").trim(),
          genre: (tags.genre && tags.genre[0]) || "",
          year: tags.year || null,
          /* The release tag first, the original-release tag second. A reissue
             names both, and the date on the record is the one worth saying. */
          releaseDate: isoDate(tags.date) || isoDate(tags.originaldate) ||
                       isoDate(tags.originalyear) || "",
          disc: (tags.disk && tags.disk.no) || 1,
          no: (tags.track && tags.track.no) || 0,
          duration: fmt.duration || 0,
          mime: mimeFor(ext),
          bitdepth: fmt.bitsPerSample || null,
          samplerate: fmt.sampleRate || null,
          size: st.size, mtime, folderDisc: part.disc, reused: false
        });
      }
    }

    if (!rows.length) continue;

    /* Derived from EVERY track in the folder, reused rows included. Deriving
       from the freshly parsed rows alone is what made re-tagging one track's
       title blank the whole album's artist, year and genre — the other eleven
       files still said what the album was, and the scan was not looking at
       them. */
    const prevAlbum = existingAlbums.get(id);
    /* The artist first: the title's folder fallback needs it, because a folder
       under an artist's own directory very often repeats the name. */
    const artist = deriveAlbumArtist(rows, group.dir, roots);
    const title  = deriveAlbumTitle(rows, group.dir, artist);
    /* The tags first; a year in the folder name only when they carry none. */
    const year   = commonest(rows.map(r => r.year).filter(Boolean)) ||
                   titleFromFolder(group.dir).year || null;
    const genre  = commonest(rows.map(r => r.genre));
    const releaseDate = deriveReleaseDate(rows, year);

    /* A cover named as one wins wherever it sits, and the album's own folder is
       asked first because a set of disc folders almost always keeps the cover
       one level up. Only when nothing anywhere is named like a cover does a
       loose image count, in the same order. */
    const artDirs = [listAlbumDir(group.dir), ...group.parts.map(p => p.folder)];
    let art = "";
    for (const folder of artDirs) { if (art) break; art = namedArtFile(folder); }
    for (const folder of artDirs) { if (art) break; art = anyArtFile(folder); }
    if (!art && artDir) art = await extractEmbeddedArt(rows, id, artDir);

    /* Discs that used to be albums of their own carry history worth keeping.
       Merging them is the only honest way to change an album's identity: the
       counts are real plays, and the date it arrived is the earliest of them. */
    const merged = absorbSplitDiscs(db, id, group, relTo, existingAlbums, prevAlbum);

    const now = Date.now();
    upsertAlbum.run({
      id, dir: group.dir, title, artist,
      sort_title: sortKey(title), sort_artist: sortKey(artist),
      year: year ? Number(year) : null, release_date: releaseDate,
      genre: genre || "",
      track_count: rows.length,
      duration: rows.reduce((s, r) => s + (r.duration || 0), 0),
      art: art || "",
      added_at: merged.added_at || now,
      seen_at: started
    });
    if (merged.play_count || merged.last_played_at) {
      db.prepare(`UPDATE albums SET play_count = ?, last_played_at = ? WHERE id = ?`)
        .run(merged.play_count, merged.last_played_at, id);
    }
    seenAlbums.add(id);

    for (const r of rows) {
      upsertTrack.run({
        id: r.id, album_id: id, path: r.path, rel: r.rel,
        title: r.title, artist: r.artist || artist,
        albumartist: r.albumartist || "", album_tag: r.album || "",
        mbid: r.mbid || "",
        genre: r.genre || "", year: r.year ? Number(r.year) : null,
        release_date: r.releaseDate || "",
        /* The FOLDER's disc number wins over the tag. A rip split into "Disc
           1" and "Disc 2" very often has every file tagged disc 1, and the
           folders are the thing the listener actually arranged. */
        disc: r.folderDisc || r.disc || 1, no: r.no || 0, duration: r.duration || 0,
        mime: r.mime, bitdepth: r.bitdepth, samplerate: r.samplerate,
        size: r.size, mtime: r.mtime,
        /* Only ever consumed by the INSERT arm — the ON CONFLICT update above
           deliberately leaves added_at alone, so a rescan never resets the
           date a track first appeared. */
        added_at: now,
        tags_read: TAG_SCHEMA
      });
      seenTracks.add(r.id);
    }
  }

  /* Anything not seen this pass is marked absent, never deleted. A NAS that
     was not mounted when the scan ran must not cost the user their play
     history — remount, rescan, and the albums come back with their counts. */
  const markAlbumAbsent = db.prepare("UPDATE albums SET present = 0 WHERE id = ?");
  const markTrackAbsent = db.prepare("UPDATE tracks SET present = 0 WHERE id = ?");
  const gone = db.transaction(() => {
    let a = 0, t = 0;
    for (const row of db.prepare("SELECT id FROM albums WHERE present = 1").all()) {
      if (!seenAlbums.has(row.id)) { markAlbumAbsent.run(row.id); a++; }
    }
    for (const row of db.prepare("SELECT id FROM tracks WHERE present = 1").all()) {
      if (!seenTracks.has(row.id)) { markTrackAbsent.run(row.id); t++; }
    }
    return { a, t };
  })();

  const stats = {
    albums: seenAlbums.size, tracks: seenTracks.size,
    parsed, reused, missingAlbums: gone.a, missingTracks: gone.t,
    ms: Date.now() - started
  };
  console.log(`[scan] ${stats.albums} albums, ${stats.tracks} tracks ` +
              `(${parsed} read, ${reused} unchanged) in ${(stats.ms / 1000).toFixed(1)}s`);
  return stats;
}

/*
 * Take over the history of disc folders that used to be albums in their own
 * right.
 *
 * Before multi-disc folding, "Album/Disc 1" and "Album/Disc 2" were two
 * albums with two sets of counts. Folding them changes the album's id, and
 * leaving the old rows behind would strand real listening — so the counts are
 * summed, the earliest arrival kept, the most recent play kept, and the play
 * history re-pointed at the album that now exists. The old rows are left to
 * the absent pass, which never deletes anything.
 *
 * The counts are cleared off the piece once they have been taken, which is
 * what makes a rescan safe: the numbers moved, they were not copied, so the
 * next scan finds nothing left to add and the album keeps the play count it
 * earned instead of doubling it every time the library is walked.
 */
function absorbSplitDiscs(db, id, group, relTo, existingAlbums, prevAlbum) {
  const result = {
    added_at: prevAlbum ? prevAlbum.added_at : 0,
    play_count: prevAlbum ? prevAlbum.play_count || 0 : 0,
    last_played_at: prevAlbum ? prevAlbum.last_played_at || 0 : 0
  };

  for (const part of group.parts) {
    const oldId = albumKey(relTo(part.folder.dir));
    if (oldId === id) continue;
    const old = existingAlbums.get(oldId);
    if (!old) continue;

    if (old.added_at && (!result.added_at || old.added_at < result.added_at)) {
      result.added_at = old.added_at;
    }
    result.play_count += old.play_count || 0;
    if ((old.last_played_at || 0) > result.last_played_at) {
      result.last_played_at = old.last_played_at || 0;
    }
    /* Both columns move. `album_id` is what the six-month rule and Smart Picks
       read; `ref` is what an album play is *about*, and one still naming a
       disc folder points at an album that no longer exists. */
    db.prepare("UPDATE plays SET album_id = ? WHERE album_id = ?").run(id, oldId);
    db.prepare("UPDATE plays SET ref = ? WHERE kind = 'album' AND ref = ?").run(id, oldId);
    db.prepare("UPDATE albums SET play_count = 0, last_played_at = NULL WHERE id = ?")
      .run(oldId);
    existingAlbums.delete(oldId);
  }
  result.last_played_at = result.last_played_at || null;
  return result;
}

/* Embedded art is written out once and served from the cache thereafter. The
   file is named for the album id so a rescan overwrites rather than
   accumulates, and a missing cache directory just means no art — never a
   failed scan. */
async function extractEmbeddedArt(rows, albumId, artDir) {
  const { parseFile } = await import("music-metadata");
  /* A hash, not a truncated encoding of the path. Hex-then-slice kept only the
     first 38 characters of the folder, so "…/Beethoven Symphony No 1" and
     "…No 2" produced the same filename — and the existsSync short-circuit below
     then handed the second album the first one's cover without ever opening
     its files. Deep shared prefixes are the norm in a classical library. */
  const safe = crypto.createHash("sha1").update(albumId).digest("hex");
  for (const ext of [".jpg", ".png"]) {
    const candidate = path.join(artDir, safe + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const r of rows.slice(0, 3)) {
    try {
      const md = await parseFile(r.path, { duration: false });
      const pic = md.common && md.common.picture && md.common.picture[0];
      if (!pic) continue;
      const ext = (pic.format || "").includes("png") ? ".png" : ".jpg";
      const out = path.join(artDir, safe + ext);
      await fsp.mkdir(artDir, { recursive: true });
      await fsp.writeFile(out, Buffer.from(pic.data));
      return out;
    } catch { /* no readable picture frame in this file — try the next */ }
  }
  return "";
}

module.exports = { scan, sortKey, mimeFor, playableBySonos, AUDIO_EXT,
                   deriveAlbumArtist, deriveAlbumTitle, titleFromFolder, parseDiscFolder,
                   artistFromFolder, readContainer, withoutArtist,
                   isoDate, deriveReleaseDate };
