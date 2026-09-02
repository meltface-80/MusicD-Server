# Claude Code — Project Rules for MusicD Server

Read this at the start of every session. These rules override default behaviour.

---

## What this project is, and is not

MusicD Server shows a local music library and plays it to Sonos. The brief that
created it was explicit about what it does **not** do, and every one of these is
a decision, not a gap:

- **No metadata fetching and no album identification.** The library shows albums
  as they are on disk. An album is a folder; its title and artist come from the
  tags in it, and the folder name is the fallback. **One exception, added in
  0.4.9 at the user's explicit request: a MISSING COVER.** An album with no
  picture anywhere gets one found for it and nothing else — no title, no
  artist, no year, no genre, no review, and never a tag rewritten. See the
  cover rules below.
- **No record labels.** No Discogs, no FanArt.tv.
- **No streaming services.** No Qobuz, no TIDAL.
- **No Pitchfork**, no reviews, no scores.
- **No wall display.**

Do not add any of them back, and do not add a "small" call to an external
metadata API as a convenience. `test/frontend.test.js` fails the build if any of
these names reappears in the client.

## The one thing that reaches the internet

`lib/covers.js` looks for a cover, and it is the only outbound request the
server makes while it is simply running. Everything about it is a constraint
the user set:

- **No API keys and no accounts, ever.** MusicBrainz and the Cover Art Archive
  need neither. If a source needs a key it is not a source for this project.
- **Their terms are load-bearing, not advice.** One request a second through the
  single gate in `covers.js`, a `User-Agent` naming the app, its version and a
  contact URL, and a 503 or 429 STOPS the sweep rather than being retried. A
  test's stand-in for MusicBrainz must refuse an unidentified client the way
  the real one does — a permissive fake tests the happy path and nothing about
  whether the caller is asking correctly.
- **Covers only, and only missing ones.** An album with a picture in its folder
  or embedded in its files is never looked up.
- **Nothing is written next to the music.** The mount is very often read-only
  and it is the user's. Fetched images live in `DATA_DIR`, and `art_fetched` is
  a SEPARATE column from `art` because the scan rewrites `art` on every pass.
- **A miss is written down.** Without `cover_lookups` a library of coverless
  bootlegs re-asks about all of them every six hours forever.
- **It is not a manual fetch.** No picker, no candidate grid, no per-album
  button — one row in the side menu that says what is happening, and
  `COVER_LOOKUP=false` to remove even that.

## Last.fm is the one place a key was unavoidable

`lib/lastfm.js`. Last.fm has **no OAuth 2 and no anonymous mode**: every call
carries an `api_key` and every authenticated one an `api_sig` made with a
shared secret. There is no keyless path, and a scrobbler without a key is a
scrobbler using somebody else's. So:

- The key and secret are a DEVELOPER registration read from `LASTFM_API_KEY`
  and `LASTFM_API_SECRET`. Nobody types a key into the app; with neither set
  the feature reports itself unavailable and the row is absent, not disabled.
- **The signature excludes `format` and `api_sig`, and the rest is sorted by
  name.** Getting that wrong fails silently with "Invalid method signature".
  The test's fake Last.fm VERIFIES the signature — a permissive stand-in would
  pass every test while the real service refused all of it.
- **A scrobble is the same event as a play count**, credited in
  `lib/playback.js` at the half-way mark. Hooking it anywhere else lets the two
  disagree about what was listened to. The timestamp is when the track
  STARTED.
- **A scrobble is written to the database before it is sent** and deleted only
  once Last.fm accepts it. "Playing now" is never queued — a copy of it sent
  later would be a lie.
- **A revoked session forgets itself rather than retrying forever**, and the
  queue is kept for whenever it is reconnected.

## Duplicates are a local match, not an identification

A record that is on disk twice — the album and its deluxe reissue — is **one
album with a version tab**, and the grouping is derived from what is already in
the library: the artist name, the title with its edition marker stripped, and
the track titles as a second opinion. `lib/match.js` is the only place those
rules live and `lib/duplicates.js` is the only place they are applied.

- **A bad match costs an album; a missed match costs a duplicate.** Anything the
  edition vocabulary does not recognise is part of the title, so "(Live)",
  "(Instrumental)" and "(feat. …)" never fold. Weezer made four albums called
  "Weezer": the track-title overlap check is what keeps them four.
- **The primary is the one without the edition marker in its title.** Everything
  else in `rank()` only settles a tie.
- **A group has one history, and it lives on the primary.** Counters are MOVED
  and the donor zeroed, never copied — `regroup()` runs after every scan, and
  anything copied is counted again every six hours forever.

**Smart Picks are local files only.** They are built from the play history in the
database and nothing else. A pick must connect to what was actually played —
being unplayed is a scoring bonus, never a reason to be picked, because a row of
merely-unplayed albums is the Random row wearing a different name.

## Pre-flight before every commit

```bash
node --check index.js
for f in lib/*.js public/app.js; do node --check "$f"; done
npm test
```

Add to the suite whenever a bug is found; a check that would have caught it is
part of the fix.

## Rules that come from how this thing actually breaks

- **A stream URL a speaker cannot reach is silently unplayable.** Sonos fetches
  audio itself, so `localhost`, `127.0.0.1` and container-internal addresses all
  produce a queue that loads and then does nothing. Every URI handed to a player
  goes through `baseUrl()`, and `SERVER_IP` overrides it.
- **Sonos requires the `RINCON_AssociatedZPUDN` descriptor** on any item from a
  third-party HTTP server. Without it the player accepts the SOAP call and then
  refuses to play, with no error anywhere the user can see. `lib/didl.js` is the
  only place metadata is built; keep it that way.
- **Transport goes to the group coordinator, volume goes to the speaker.**
  Sending Play to a grouped member is accepted and does nothing audible.
- **Play counting watches the speaker, not the button.** Counting on the way out
  would credit an album that was queued and skipped, which is exactly the
  distinction the six-month row depends on.
- **Never delete library rows on a scan.** Mark them absent. A NAS that was not
  mounted must not cost the user their history.
- **`added_at` is written on insert only.** The `ON CONFLICT` arms of the scan's
  upserts deliberately leave it alone; a rescan that resets it empties "Recently
  added" and fills "Not played in 6 months" with nonsense.
- **The time zone is load-bearing.** "Not played in 6 months" is a calendar
  boundary and Smart Picks rebuild once a local day. Anything date-shaped uses
  local time, and the Docker docs say so.

## Front end

- **Nothing goes in `<head>` without knowing whether iOS reads it.** charset,
  viewport, theme-color, title and icon links are the confirmed-good set. The
  legacy `apple-mobile-web-app-capable`, `mobile-web-app-capable` and
  `apple-mobile-web-app-status-bar-style` metas stop the app filling the screen,
  and iOS bakes them into a home-screen shortcut at install time — no later
  build can undo it for a shortcut already created. `test/frontend.test.js`
  guards this by matching the TAG, not the word, so the comment explaining their
  absence does not trip it.
- **A stale installed PWA looks exactly like a regression. Rule it out first.**
  Ask for a delete-and-re-add of the shortcut before diagnosing a
  "you broke X in version N" report.
- **Never save or restore a screen by reading `.innerHTML`.** Re-parsing that
  markup builds fresh elements and drops every listener attached to the
  originals. Move the live nodes instead.
- **Every colour is a token.** A hex literal below the palette blocks in
  `style.css` will not follow the light theme, and the suite fails on it.
- **Every id `app.js` reaches for must exist in `index.html`**, which the suite
  also checks — that class of bug otherwise only shows up on the one screen
  nobody opened.

## Development rules

- **No incomplete implementations.** No `// rest stays the same`.
- **No silent catch.** Every `catch {}` carries a comment saying why silence is
  safe there.
- **Declaration before use**, and one spelling per name — no camelCase and
  UPPER_SNAKE for the same value.
- **No partial migrations.** Rename a constant, then grep the whole tree.

## Repository

- **Stay on `0.4.x`.** Bump the patch number for anything that ships; the minor
  number moves only when the user says so, in as many words. A feature large
  enough to feel like a minor release is still a patch until then.
- Develop on a feature branch (`claude/<topic>`). Never commit to `main`.
- Never open or merge a pull request unless the user asks. The user merges.
- Never write an invalid `${{ ... }}` expression in a workflow file — Actions
  evaluates them even inside shell comments, and an invalid one kills the run at
  startup with no jobs and no error.
