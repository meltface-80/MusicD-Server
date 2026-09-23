# Changelog

Every change merged to main bumps the version: `package.json`, the README title,
the GitHub Pages badge and the Android app's `versionName` (plus `versionCode`)
move together — `npm test` fails if they don't.

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
