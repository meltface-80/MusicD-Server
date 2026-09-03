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
- **A name the USER types is not identification.** 0.4.15 lets an album's title
  and artist be corrected by hand, because a record tagged with no artist shows
  as "Unknown artist" and the person who owns it knows who made it. Nothing is
  looked up, nothing is matched, no picker and no candidates — one field each,
  typed. It does not open the door to fetching one: the user asked for the
  editor and said the identification work needs planning first.
- **No record labels.** No Discogs, no FanArt.tv.
- **No streaming services.** No Qobuz, no TIDAL.
- **No Pitchfork and no scores.** 0.4.17 added a WRITE-UP — the opening of an
  album's Wikipedia article and its critical reception, and an artist's
  biography — at the user's explicit request. A sourced paragraph about how a
  record landed is not a score out of ten, and the distinction is the whole of
  what changed: still no Pitchfork, still no ratings, still nothing from a
  source whose text cannot lawfully be shown. See the info rules below.
- **No wall display.**

Do not add any of them back, and do not add a "small" call to an external
metadata API as a convenience. `test/frontend.test.js` fails the build if any of
these names reappears in the client.

## The two things that reach the internet

`lib/covers.js` looks for a cover and `lib/info.js` asks what a record is. They
are the only outbound requests the server makes while it is simply running, and
neither happens on a timer. Everything about covers is a constraint the user
set:

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

## Write-ups: `lib/info.js`

An album's write-up and an artist's biography, added in 0.4.17. The rules are
the covers rules plus the ones that only apply to prose:

- **NOTHING IT LEARNS IS WRITTEN BACK.** Not a title, not an artist, not a year,
  and above all not a grouping. `lib/duplicates.js` decides what is one record
  by looking at the disk, and a regroup MOVES the demoted copy's play counts —
  so a website must never be able to cause one. This module reads; it never
  writes to `albums`.
- **A SEARCH ALWAYS ANSWERS, which is the danger.** Wikipedia ranks the
  disambiguation page for "Hex" above the Bark Psychosis album, Earth made a
  record of the same name, and "Souvlaki" is a Greek dish before it is a
  Slowdive album. Every candidate is checked against the library's own facts —
  it must name the artist, through `artistKey()` — before it is believed, and
  no confident match means SHOW NOTHING. A wrong biography is worse than an
  absent one because nobody reports it; it just reads plausibly about the wrong
  band. The test that proves this is the Earth one: drop the artist check and
  it is the only thing that fails.
- **The licence is the reason Wikipedia was chosen, not a preference.**
  Wikipedia and Last.fm are CC BY-SA and may be shown WITH a credit and a link;
  AllMusic and Pitchfork may not, which is why an app that wants to print a
  paragraph either uses an open source or prints nothing. The source, the
  article's title and the licence are stored beside the text and rendered
  OUTSIDE the part that collapses — a credit behind a "Read more" is a credit
  that is usually not shown.
- **Use `/w/api.php`, never the pretty endpoints.** `/api/rest_v1/` is RESTBase,
  which is being retired, and `api.wikimedia.org/core/v1` is itself scheduled
  for deprecation. The Action API is twenty years old and is the only one that
  searches AND returns text in one request. Same lesson as the GitHub 415.
- **`exlimit` defaults to 1.** Without it a search returns five results and ONE
  extract, which works until the right page is the second hit and then fails
  silently for ever. Multiple extracts also require `exintro`, which is why the
  full article for the chosen page is a second request. The fake Wikipedia in
  `test/info.test.js` enforces both, and 10 tests fail if `exlimit` is dropped.
- **A hit is kept forever; only a miss expires.** An article about a 1988 record
  will not become a different article. A miss is retried after a week so an
  album that gains an article next year is not unknown for ever. A NETWORK
  FAILURE is not a miss — recording one would mean waiting a week because a
  router rebooted.
- **Nothing is fetched by the scan.** One request when somebody opens a screen,
  never four thousand on a rescan.

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
- **`describeArtist` and `describeAlbum` are the two unsigned calls.** They only
  read, so Last.fm wants the key alone, and they exist for `lib/info.js` as the
  fallback source. `autocorrect=1` is on, which means what comes back may be
  about a DIFFERENT act — info.js checks the artist on the way out.
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
- **Random Album Radio rides on the poll loop, not on a phone.** `lib/radio.js`
  picks and `lib/playback.js` adds, on a TRACK CHANGE only — reading the queue
  back off the speaker is a SOAP call, and doing it every five-second poll would
  triple that loop's traffic to answer a question that can only change when the
  track does. The whole queue is read, not the tail: the tail says whether an
  album is due, and the rest says what must not be offered again — and at the
  moment a top-up is due the tail is EMPTY, so a tail-only read excludes
  nothing. The fake Sonos honours `StartingIndex` because a real one does.
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
- **`Accept: application/octet-stream` is for a RELEASE ASSET, not an archive.**
  Ask for it on GitHub's tarball endpoint and the answer is 415, which is what
  broke every in-app update from 0.4.0 to 0.4.3. The archive endpoint takes
  `Accept: */*` and a pinned `X-GitHub-Api-Version`.
- **Rename a column and grep for EVERY reader before moving on.** 0.4.9 swapped
  `art` for `has_art` in the transport's album query and updated one of the
  three places that read it; Now playing, the Queue and the mini bar lost their
  artwork for two releases. This is the "no partial migrations" rule with teeth:
  where several call sites ask the same question, give them one method to ask
  it through.
- **What an album is CALLED is one of those questions.** `albumNames()` in
  `lib/db.js` is the only place that decides between the name the user typed
  and the tags, and every query that displays, sorts, searches or plays an
  album asks through it. `lib/duplicates.js` is the one deliberate exception —
  grouping matches what is ON DISK, because a match MOVES the demoted copy's
  play counts and typing the name back would not bring them home.
- **An auto margin switches off a flex item's stretch.** `.modal-body` centres
  itself with `margin: 0 auto`; on the Now playing face the panel is a flex
  COLUMN, so those auto margins made the body shrink-to-fit and it took its
  width from its widest content — the artwork. The whole screen then resized
  around the cover's INTRINSIC PIXEL SIZE, which is why a low-resolution sleeve
  made the app look different. A definite `width: 100%` is what gives the
  stretch back. Suspect this whenever a column sizes itself to a picture.
- **A fixed overlay does not stop the page behind it scrolling.** `overflow:
  hidden` stops a panel scrolling, not the GESTURE: the drag goes up the chain
  to the document, which scrolls invisibly under the overlay and paints its own
  indicator down the edge of a screen that never moves. That was the Now
  playing "scroll bar" in 0.4.14. A face that does not scroll says
  `touch-action: none`; one that does says `overscroll-behavior: contain`.
- **The transport payloads need their own assertions.** `/api/now` and
  `/api/queue` feed three screens that `/api/album` never touches, and nothing
  asserted on them — so the suite stayed green through a regression that was
  visible the moment anybody pressed play.
- **A renderer fed a hand-made object proves nothing about the wiring.** The
  0.4.9 covers row was tested by calling `showCovers({available: true, ...})`
  from a browser check: every branch of the wording was verified and the row
  was invisible on every real install, because the server never sent
  `available` in `/api/status`. Drive a UI check from the REAL endpoint the
  screen reads, then assert on what it painted.
- **A permissive fake proves nothing about what the caller ASKS FOR.** Four
  transport tests passed through all three broken releases above because the
  stand-in for GitHub answered whatever it was asked. Every fake external
  service in `test/` now refuses the way the real one does — GitHub 415s an
  octet-stream archive request, MusicBrainz 403s an unidentified client, and
  Last.fm rejects a wrong signature. Keep it that way when adding another.

## Front end

- **Nothing goes in `<head>` without knowing whether iOS reads it.** charset,
  viewport, theme-color, title and icon links are the confirmed-good set. The
  legacy `apple-mobile-web-app-capable`, `mobile-web-app-capable` and
  `apple-mobile-web-app-status-bar-style` metas stop the app filling the screen,
  and iOS bakes them into a home-screen shortcut at install time — no later
  build can undo it for a shortcut already created. `test/frontend.test.js`
  guards this by matching the TAG, not the word, so the comment explaining their
  absence does not trip it.
- **A fixed element is not fixed while iOS is scrolling with the keyboard up.**
  It gets re-anchored to the visual viewport, which lifts anything pinned to the
  bottom onto the keys. Everything with a `bottom:` subtracts `--kb-inset`
  (measured in `trackKeyboard()`) so it stays where it was put; the keyboard
  covers it rather than moving it. `window.innerHeight` is the viewport that
  does NOT change when the keyboard opens — measuring against `visualViewport`
  alone yields zero for ever.
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
