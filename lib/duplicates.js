/*
 * MusicD Server — two copies of one record.
 *
 * A collection that has been going a while ends up with the album and the
 * deluxe reissue of the album sitting next to each other on the shelf, and
 * the home screen shows both. This folds them: one card, one album screen,
 * and a tab for each version.
 *
 * It is local and it is cheap. Nothing here asks the internet what a record
 * is — the grouping is the artist name, the album title with its edition
 * marker taken off (lib/match.js), and the track titles as a second opinion.
 * The track titles are what stop it folding the four different albums called
 * "Weezer" into one, which is the failure that matters: missing a duplicate
 * costs a duplicate, and a bad match costs an album.
 *
 * WHICH ONE IS THE ALBUM. The version with no edition marker in its title —
 * "the one without deluxe in the title". Everything else is a tie-break, and
 * the ties are broken towards the fullest copy.
 *
 * WHERE THE HISTORY LIVES. On the primary, always. A group is one album from
 * the listener's side, so it has one play count and one last-played date, and
 * a version that stops being the primary hands its counters over rather than
 * copying them — the same move-don't-copy rule the scanner's disc folding
 * follows, and for the same reason: a rescan runs again and again, and
 * anything copied is counted twice the second time.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const { groupKey, splitEdition, sameRecord } = require("./match");

/*
 * The order a version has to lose in to become a secondary.
 *
 * Fewest edition markers first, which is the whole of the user's rule. The
 * rest only ever settles a tie between two titles that are equally plain:
 * most tracks, then longest, then whichever arrived first, then the id so
 * that two identical rips still land the same way on every run.
 */
function rank(album) {
  return [
    splitEdition(album.title).editions.length,
    -(album.track_count || 0),
    -(album.duration || 0),
    album.added_at || 0,
    album.id
  ];
}

function better(a, b) {
  const ra = rank(a), rb = rank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] < rb[i]) return true;
    if (ra[i] > rb[i]) return false;
  }
  return false;
}

/*
 * Split a set of same-named albums into the ones that really are the same.
 *
 * Members are offered to each existing cluster in turn and join the first one
 * whose representative they share a track list with; anything that matches
 * nothing starts a cluster of its own. Groups of same-named albums are two or
 * three rows, so the quadratic shape costs nothing and the alternative —
 * transitive union-find — would chain "Weezer" onto "Weezer" through a third
 * copy that happened to overlap both.
 */
function cluster(albums, tracksOf) {
  const clusters = [];
  for (const album of albums) {
    const mine = tracksOf(album.id);
    let home = null;
    for (const c of clusters) {
      if (sameRecord(mine, tracksOf(c[0].id))) { home = c; break; }
    }
    if (home) home.push(album);
    else clusters.push([album]);
  }
  return clusters;
}

/*
 * The album rows this group's history could be sitting on, other than the
 * group itself.
 *
 * Two directions, because a group can change shape either way. A copy that has
 * gone absent still POINTS AT its primary, and its plays are still real. And a
 * primary that has gone absent is still POINTED AT by the copy that outlived
 * it — which is the upgrade path in reverse: delete the standard edition and
 * the deluxe becomes the album, so the album's history has to come with it.
 *
 * An album that is present is deliberately never a stray: it has a group of
 * its own in this same pass, and taking its counters here would empty an album
 * that is about to be shown.
 */
function attachedStrays(db, group, living) {
  const ids = group.map(a => a.id);
  const out = new Set();
  if (!ids.length) return out;
  const holes = ids.map(() => "?").join(",");
  for (const row of db.prepare(
    `SELECT id FROM albums WHERE version_of IN (${holes})`).all(...ids)) {
    if (!living.has(row.id)) out.add(row.id);
  }
  for (const album of group) {
    if (album.version_of && !living.has(album.version_of)) out.add(album.version_of);
  }
  for (const id of ids) out.delete(id);
  return out;
}

/*
 * Re-derive every group from what is in the library right now.
 *
 * Called after a scan and once at startup. Idempotent: running it twice in a
 * row is a no-op, because a donor's counters are zeroed as they are moved and
 * a primary that is already the primary has nothing to receive.
 */
function regroup(db) {
  const albums = db.prepare(
    `SELECT id, title, artist, track_count, duration, added_at, version_of
     FROM albums WHERE present = 1`).all();

  /* One query for every track title in the library rather than one per
     candidate group. A library big enough for this to matter is a library
     where the per-group queries would have mattered more. */
  const titles = new Map();
  for (const row of db.prepare(
    "SELECT album_id, title FROM tracks WHERE present = 1").all()) {
    let list = titles.get(row.album_id);
    if (!list) titles.set(row.album_id, list = []);
    list.push(row.title);
  }
  const tracksOf = (id) => titles.get(id) || [];

  const buckets = new Map();
  const loners = [];
  for (const album of albums) {
    const key = groupKey(album.artist, album.title);
    /* No key means nothing to match on — a blank artist, or a title that is
       all punctuation. Such an album is its own group and stays visible. */
    if (!key) { loners.push([album]); continue; }
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, bucket = []);
    bucket.push(album);
  }

  const groups = [];
  for (const bucket of buckets.values()) {
    if (bucket.length === 1) { groups.push(bucket); continue; }
    for (const c of cluster(bucket, tracksOf)) groups.push(c);
  }
  for (const lone of loners) groups.push(lone);

  const setVersion = db.prepare("UPDATE albums SET version_of = ? WHERE id = ?");
  const counters = db.prepare(
    "SELECT id, play_count, last_played_at FROM albums WHERE id = ?");
  const clearCounters = db.prepare(
    "UPDATE albums SET play_count = 0, last_played_at = NULL WHERE id = ?");
  const addCounters = db.prepare(
    `UPDATE albums SET play_count = play_count + ?,
            last_played_at = CASE WHEN ? > COALESCE(last_played_at, 0) THEN ? ELSE last_played_at END
     WHERE id = ?`);
  const movePlays = db.prepare("UPDATE plays SET album_id = ? WHERE album_id = ?");
  const moveAlbumRefs = db.prepare(
    "UPDATE plays SET ref = ? WHERE kind = 'album' AND ref = ?");

  let collapsed = 0, moved = 0;

  /* Every primary is decided BEFORE anything is written. A group's stray
     copies are found by looking at who points at it, and an album that this
     same pass is about to make a primary must not be mistaken for one of
     them — which it would be, on the run after a retag moved it out of the
     group it used to belong to. */
  const primaries = groups.map((group) => {
    let primary = group[0];
    for (const album of group) if (better(album, primary)) primary = album;
    return primary;
  });
  const living = new Set(albums.map(a => a.id));

  const apply = db.transaction(() => {
    groups.forEach((group, i) => {
      const primary = primaries[i];
      const family = attachedStrays(db, group, living);
      for (const album of group) if (album.id !== primary.id) family.add(album.id);

      if (primary.version_of !== "") setVersion.run("", primary.id);
      for (const id of family) {
        const donor = counters.get(id);
        /* Not a row any more — an album deleted out of the database by hand.
           Nothing to move and nothing to point at. */
        if (!donor) continue;
        if (donor.play_count || donor.last_played_at) {
          addCounters.run(donor.play_count, donor.last_played_at || 0,
                          donor.last_played_at || 0, primary.id);
          clearCounters.run(id);
          movePlays.run(primary.id, id);
          moveAlbumRefs.run(primary.id, id);
          moved++;
        }
        setVersion.run(primary.id, id);
      }
      if (group.length > 1) collapsed += group.length - 1;
    });
  });
  apply();

  return { groups: groups.length, collapsed, moved };
}

/* The primary of whatever this album belongs to — itself, when it is one. */
function headOf(db, id) {
  const row = db.prepare("SELECT id, version_of FROM albums WHERE id = ?").get(id);
  if (!row) return null;
  return row.version_of || row.id;
}

module.exports = { regroup, headOf, rank, better, cluster };
