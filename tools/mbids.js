"use strict";
/*
 * tools/mbids.js — does this library carry MusicBrainz release ids?
 *
 * A cover is found EXACTLY when the files name the release, and guessed at
 * from a title and an artist otherwise. This says which of your albums are in
 * the first group, and — the useful part — whether the ones still missing a
 * cover are.
 *
 * Reads the tags directly, so it answers before a rescan has happened and
 * without changing anything. Read-only, on both the database and the files.
 *
 *   docker exec -it musicd-server node tools/mbids.js
 *   docker exec -it musicd-server node tools/mbids.js --all
 *
 * With no argument it looks only at albums that have no cover, which is the
 * question worth asking. --all walks the whole library.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const all = process.argv.includes("--all");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

(async () => {
  const { parseFile } = await import("music-metadata");
  const db = new Database(path.join(DATA_DIR, "musicd.db"), { readonly: true });

  /* One file per album is enough: a folder's files name the same release, and
     reading four thousand of them to answer a yes/no would take minutes. */
  const rows = db.prepare(
    `SELECT a.id, a.title, a.artist,
            (SELECT t.path FROM tracks t
             WHERE t.album_id = a.id AND t.present = 1
             ORDER BY t.disc, t.no LIMIT 1) AS file
     FROM albums a
     WHERE a.present = 1 ${all ? "" : "AND a.art = '' AND a.art_fetched = ''"}
     ORDER BY a.artist, a.title`).all().filter(r => r.file);
  db.close();

  if (!rows.length) {
    console.log(all ? "No albums in the library." : "Every album already has a cover.");
    return;
  }

  let withId = 0, unreadable = 0;
  for (const row of rows) {
    let id = "";
    try {
      const md = await parseFile(row.file, { duration: false, skipCovers: true });
      id = String(((md && md.common) || {}).musicbrainz_albumid || "").trim();
    } catch (e) {
      /* A file the tag reader cannot open is reported as such rather than
         counted as "no id" — the two mean different things to somebody
         deciding whether to re-tag. */
      unreadable++;
      console.log("  ??  " + label(row) + "   (" + e.message + ")");
      continue;
    }
    if (UUID.test(id)) { withId++; console.log("  id  " + label(row) + "   " + id); }
    else console.log("  --  " + label(row));
  }

  const many = rows.length !== 1;
  console.log(`\n${withId} of ${rows.length} ${many ? "albums" : "album"}` +
              `${all ? "" : " with no cover"} ${many ? "carry" : "carries"} ` +
              `a MusicBrainz release id.`);
  if (unreadable) console.log(`${unreadable} could not be read.`);
  if (withId) {
    console.log("Those are fetched exactly, by id, with no guessing and no " +
                "MusicBrainz search at all.");
  }
  if (withId < rows.length) {
    console.log("The rest are searched for by album name, then by track names, " +
                "then on iTunes — and can be looked for by hand from the album " +
                "screen: … on the artwork, Edit, Find cover.");
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

function label(row) {
  return (row.artist || "—") + " — " + row.title;
}
