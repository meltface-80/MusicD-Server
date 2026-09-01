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

function findArtFile(folder) {
  const lower = new Map();
  for (const n of folder.all) lower.set(n.toLowerCase(), n);
  for (const base of ART_NAMES) {
    for (const ext of ART_EXT) {
      const hit = lower.get(base + ext);
      if (hit) return path.join(folder.dir, hit);
    }
  }
  /* Nothing conventionally named — take the first image in the folder rather
     than showing a blank tile when a cover is plainly sitting there. */
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

/* The album's parent directory, when it looks like an artist name rather than
   a music root or a drive. No lookup and no guessing at what the name MEANS —
   just the one piece of information the layout is already carrying. */
function artistFromFolder(dir, roots = []) {
  const parent = path.dirname(dir);
  if (!parent || parent === dir) return "";
  /* The folder directly under a music root is the album itself, so its parent
     is the root and names no artist. */
  if (roots.some(root => path.resolve(root) === path.resolve(parent))) return "";
  const name = path.basename(parent).trim();
  /* Names that mean "no artist" rather than naming one, plus the obvious
     container folders. A directory called Unknown is saying the same thing a
     missing tag says. */
  if (!name || /^(music|albums?|media|library|flac|mp3|various(\s*artists)?|va|compilations?|unknown(\s*artists?)?|disc\s*\d+|cd\s*\d+)$/i.test(name)) {
    return "";
  }
  return name;
}

function deriveAlbumTitle(tracks, dir) {
  const titles = tracks.map(t => t.album).filter(Boolean);
  const distinct = new Set(titles);
  if (distinct.size === 1) return titles[0];
  if (distinct.size > 1) {
    const winner = commonest(titles);
    if (titles.filter(t => t === winner).length / titles.length > 0.6) return winner;
  }
  /* Disagreeing or absent album tags: the folder name is the honest answer. */
  return titleFromFolder(dir).title;
}

/* A folder name, tidied into an album title. Two conventions are common enough
   to be worth reading rather than showing raw: a leading "01 - " index, and a
   trailing year — "Deceiver (2021)" is an album called Deceiver released in
   2021, and showing the year inside the title puts it in the sort order too. */
function titleFromFolder(dir) {
  const raw = path.basename(dir);
  let name = raw.replace(/^\d{1,4}\s*[-–.]\s*/, "").trim();
  let year = null;
  const trailing = /[\s._-]*[([]?((?:19|20)\d{2})[)\]]?$/.exec(name);
  if (trailing) {
    const stripped = name.slice(0, trailing.index).trim().replace(/[-–_.\s]+$/, "");
    /* Only when something is left: a folder actually named "1999" keeps it. */
    if (stripped) { name = stripped; year = Number(trailing[1]); }
  }
  return { title: name || raw, year };
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
    `SELECT id, path, mtime, size, album_id, title, artist, albumartist, album_tag,
            genre, year, disc, no, duration, mime, bitdepth, samplerate, tags_read
     FROM tracks`).all()) {
    existingTracks.set(r.id, r);
  }

  const existingAlbums = new Map();
  for (const r of db.prepare("SELECT id, title, artist, year, genre, added_at FROM albums").all()) {
    existingAlbums.set(r.id, r);
  }

  const upsertAlbum = db.prepare(`
    INSERT INTO albums (id, dir, title, artist, sort_title, sort_artist, year, genre,
                        track_count, duration, art, added_at, present, seen_at)
    VALUES (@id, @dir, @title, @artist, @sort_title, @sort_artist, @year, @genre,
            @track_count, @duration, @art, @added_at, 1, @seen_at)
    ON CONFLICT(id) DO UPDATE SET
      dir = excluded.dir, title = excluded.title, artist = excluded.artist,
      sort_title = excluded.sort_title, sort_artist = excluded.sort_artist,
      year = excluded.year, genre = excluded.genre,
      track_count = excluded.track_count, duration = excluded.duration,
      art = excluded.art, present = 1, seen_at = excluded.seen_at`);

  const upsertTrack = db.prepare(`
    INSERT INTO tracks (id, album_id, path, rel, title, artist, albumartist, album_tag,
                        genre, year, disc, no, duration, mime, bitdepth, samplerate,
                        size, mtime, added_at, present, tags_read)
    VALUES (@id, @album_id, @path, @rel, @title, @artist, @albumartist, @album_tag,
            @genre, @year, @disc, @no, @duration, @mime, @bitdepth, @samplerate,
            @size, @mtime, @added_at, 1, @tags_read)
    ON CONFLICT(id) DO UPDATE SET
      album_id = excluded.album_id, path = excluded.path, rel = excluded.rel,
      title = excluded.title, artist = excluded.artist,
      albumartist = excluded.albumartist, album_tag = excluded.album_tag,
      genre = excluded.genre, year = excluded.year, disc = excluded.disc,
      no = excluded.no, duration = excluded.duration, mime = excluded.mime,
      bitdepth = excluded.bitdepth, samplerate = excluded.samplerate,
      size = excluded.size, mtime = excluded.mtime, present = 1,
      tags_read = excluded.tags_read`);

  const seenAlbums = new Set();
  const seenTracks = new Set();
  let parsed = 0, reused = 0, done = 0;

  for (const folder of folders) {
    done++;
    if (done % 25 === 0 || done === folders.length) {
      onProgress({ done, total: folders.length, dir: folder.dir });
    }

    const relDir = relTo(folder.dir);
    const id = albumKey(relDir);
    const rows = [];

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
          albumartist: prev.albumartist, album: prev.album_tag,
          genre: prev.genre, year: prev.year,
          disc: prev.disc, no: prev.no, duration: prev.duration, mime: prev.mime,
          bitdepth: prev.bitdepth, samplerate: prev.samplerate,
          size: st.size, mtime, reused: true
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
        genre: (tags.genre && tags.genre[0]) || "",
        year: tags.year || null,
        disc: (tags.disk && tags.disk.no) || 1,
        no: (tags.track && tags.track.no) || 0,
        duration: fmt.duration || 0,
        mime: mimeFor(ext),
        bitdepth: fmt.bitsPerSample || null,
        samplerate: fmt.sampleRate || null,
        size: st.size, mtime, reused: false
      });
    }

    if (!rows.length) continue;

    /* Derived from EVERY track in the folder, reused rows included. Deriving
       from the freshly parsed rows alone is what made re-tagging one track's
       title blank the whole album's artist, year and genre — the other eleven
       files still said what the album was, and the scan was not looking at
       them. */
    const prevAlbum = existingAlbums.get(id);
    const title  = deriveAlbumTitle(rows, folder.dir);
    const artist = deriveAlbumArtist(rows, folder.dir, roots);
    /* The tags first; a year in the folder name only when they carry none. */
    const year   = commonest(rows.map(r => r.year).filter(Boolean)) ||
                   titleFromFolder(folder.dir).year || null;
    const genre  = commonest(rows.map(r => r.genre));

    let art = findArtFile(folder);
    if (!art && artDir) art = await extractEmbeddedArt(rows, id, artDir);

    const now = Date.now();
    upsertAlbum.run({
      id, dir: folder.dir, title, artist,
      sort_title: sortKey(title), sort_artist: sortKey(artist),
      year: year ? Number(year) : null, genre: genre || "",
      track_count: rows.length,
      duration: rows.reduce((s, r) => s + (r.duration || 0), 0),
      art: art || "",
      added_at: prevAlbum ? prevAlbum.added_at : now,
      seen_at: started
    });
    seenAlbums.add(id);

    for (const r of rows) {
      upsertTrack.run({
        id: r.id, album_id: id, path: r.path, rel: r.rel,
        title: r.title, artist: r.artist || artist,
        albumartist: r.albumartist || "", album_tag: r.album || "",
        genre: r.genre || "", year: r.year ? Number(r.year) : null,
        disc: r.disc || 1, no: r.no || 0, duration: r.duration || 0,
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
                   deriveAlbumArtist, deriveAlbumTitle, titleFromFolder };
