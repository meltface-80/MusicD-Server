# Changelog

Every change merged to main bumps the version: `package.json`, the README title,
the GitHub Pages badge and the Android app's `versionName` (plus `versionCode`)
move together — `npm test` fails if they don't.

## v0.1.6
- No more "No Sonos rooms found yet" while an update (or any restart) is under way. The
  speakers found last time are remembered and asked first, so rooms are back within a
  couple of seconds instead of up to 30; until the server has looked, it says it is still
  searching and the page shows nothing. "Can't reach MusicD Server" no longer flashes up
  while an update restarts the server either — only if it stays away outside an update.

## v0.1.5
- Album edits always show. An album page opened from a tile drawn before the edit (another
  row, an earlier screen, a page restored after an update) kept the old title and year,
  because the page refused the server's title when it differed from the tile's. The page
  now takes the server's current title, artist, year and cover, and asks for the write-up
  and year again under the new names.
- An edited album is found by its new names and by the ones in its files, so play history,
  what a speaker is playing and the write-ups keep finding it (and its edited year).
  A title of punctuation only, like Sigur Rós's `( )`, is found too.
- A found cover shows everywhere straight away. Anything still holding the album's old
  picture address — a tile drawn before the save, a Sonos queue from before it — now gets
  the current cover (uncached) instead of the old placeholder, and the album page swaps
  every stale tile on screen to the new cover. Re-saving to make a cover appear is no
  longer needed.
- No zooming in the browser or home-screen app: pinch and double-tap zoom are off
  (viewport, `touch-action` on every element, and iOS pinch gestures cancelled). The page
  puts itself back to 1:1 if it ever finds itself scaled, so it can't get stuck zoomed.
- Settings → Share Card → **On the card: Review** switches the write-up on the share card
  on or off (on by default).

## v0.1.4
- **Updates never lose your library or edits, and never rescan it.** After a manual or
  in-app update the whole library is there the moment the server is back and plays
  straight away; the start-up check only reads files that are new or changed.
- Album edits are also saved to `album-edits.json` in the data folder and restored from it
  if the database ever has to start over. A database that must be replaced hands over its
  edits, play history and settings first; one from a newer version is never moved aside.
- Music mounted somewhere new (e.g. `/music` → `/music/4tb`) is recognised as the same files:
  albums, ids, play history, playlists and edits stay, and nothing is re-read.
- A drive that isn't mounted (an empty mount point) keeps its albums instead of having them
  removed and re-read when it's back.
- On a first scan, albums appear and play as they're found rather than when it finishes.
- `docker-compose.yml` (and the Pages install builder) name the volume `musicd-server-data`
  explicitly, so Compose and `docker run` use the same one; the server warns, in the log
  and on screen, when `/app/data` isn't a named volume and would be lost with the container.

## v0.1.3
- **In-app updates work.** Settings → Check for updates → Update installs the newest
  release and restarts the server in place (the same updater as MusicD Remote: the
  container runs `launcher.js`, which swaps the new files in while the server is stopped).
  Every version merged to main is now published as a GitHub release for it to find.
- The image is also tagged with its version (`:0.1.3`) as well as `:latest`.

## v0.1.2
- Settings → Artwork & metadata: the saved FanArt.tv key shows as `••••` plus its
  last four characters instead of "Current: undefined"; the stale Discogs wording is gone.

## v0.1.1
- **Edit album** (album page → ⋯ → Edit album): correct the title, artist and release
  year, and find a cover for an album without one — matched on title, artist and track
  names across Apple Music, Deezer and MusicBrainz, with suggestions and a paste-an-address
  box when no match is sure. Edits live in the database and survive rescans.
- Startup no longer crashes when the data volume holds a database from another program
  (the deleted earlier project used the same volume name): it's moved aside and a fresh
  library is built.
- A warning at startup when music is mounted beside `/music` (e.g. `/music1`) instead of inside it.

## v0.1.0
- First release: local library → Sonos, 24/48 ceiling, MusicD Remote interface,
  Docker image, Android app and PWA.
