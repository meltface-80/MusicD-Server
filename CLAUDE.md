# Claude Code — Project Rules for MusicD Server

Read this at the start of every session. These rules override default behaviour.

---

## What this project is, and is not

MusicD Server shows a local music library and plays it to Sonos. The brief that
created it was explicit about what it does **not** do, and every one of these is
a decision, not a gap:

- **No metadata fetching. The library shows albums as they are on disk.** An
  album is a folder; its title and artist come from the tags in it, and the
  folder name is the fallback. **One exception, added in 0.4.9 at the user's
  explicit request: a MISSING COVER.** An album with no picture anywhere gets
  one found for it and nothing else — no title, no artist, no year, no genre,
  no review, and never a tag rewritten. See the cover rules below.
- **IDENTIFICATION EXISTS AS OF 0.4.36, at the user's explicit request, and it
  stores ONE FIELD.** The user lifted this deliberately — "adding a feature is
  allowed and my choice" — after wrong covers were traced to names that no
  source could match. `lib/identify.js` lets a person confirm, by hand, which
  MusicBrainz release a folder is, and writes `albums.mbid_chosen` and NOTHING
  ELSE: no title, no artist, no year, no genre, no grouping, no tag. It is what
  makes a cover exact instead of searched for. See the identify rules below.
  This is still not "metadata fetching": nothing displayed changes.
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
- **A POLITE QUEUE MUST NOT BE RUDE TO THE PERSON HOLDING THE PHONE.** The gate
  was strictly first-come, so pressing Identify during a sweep of two hundred
  albums put that press behind two hundred turns — four minutes of a screen
  that looked hung, because it was. `wait({urgent})` puts work nobody is
  waiting on at the back and a button press at the front; the RATE is
  untouched, only the order. Anything a person triggered is urgent, and a
  backoff longer than `URGENT_PATIENCE_MS` tells them to come back rather than
  spinning silently through it. Whenever background work and interactive work
  share a resource, ask which one somebody is watching.
- **A REDIRECT IS AN ANSWER; DO NOT FOLLOW IT TO FIND OUT.** The Cover Art
  Archive's `/front` endpoints 307 to the image on archive.org, which is
  regularly slow — so checking whether a cover EXISTS by fetching it downloaded
  a thumbnail to learn a yes or no, and a slow one aborted and printed the
  browser's own "This operation was aborted" into the dialog. `archiveHolds()`
  asks with `redirect: "manual"`: 3xx is yes, 404 is no, neither costs a byte.
- **A TIMEOUT IS NOT ONE LENGTH.** The sweep gets `REQUEST_TIMEOUT_MS`, because
  nobody is watching it. A press gets seconds, because somebody is: an
  existence check is `EXISTS_TIMEOUT_MS`, and each rung of the size ladder in a
  chosen-sleeve save is `CHOSEN_TIMEOUT_MS`. And a DOMException's own wording
  must never reach a screen — `get()` turns an abort into a sentence naming
  what to do.
- **A SHORTENED FOLDER NAME IS THE SAME RECORD.** `byTitle()` demanded the
  title EXACTLY, so a folder called "When The Pawn" never matched the ninety-
  word title Fiona Apple's album is filed under — the search found the right
  release group and threw it away, which is how an album that had just been
  identified CORRECTLY still reported "nothing found for that name". It uses
  `titleRank() >= 2` now: one name inside the other, more than a single word.
- **A RELEASE ID NAMES A PRESSING, NOT A RECORD.** The archive very often holds
  art against the album rather than against the Mexican CD of it, so an exact
  id can still find nothing. `groupOfRelease()` asks which record the pressing
  belongs to and tries that — still exact, still no search, and only when the
  pressing itself came up empty.
- **A SIZE LADDER IS FOR EVERY CALLER.** The sweep walked `SIZES`; the picker
  asked for 1200px once and lost the whole save when that one request failed,
  on a cover sitting right there at 500. Where two paths fetch the same thing,
  they get the same retry.
- **"NOTHING FOUND" MUST NOT BE SAID WHEN THE TRUTH IS "COULD NOT ASK".**
  `candidatesFor()` keeps the first source's error and throws it only when
  every source came back empty. Blaming the name sends somebody off correcting
  a name that was never the problem.
- **Covers only, and only missing ones.** An album with a picture in its folder
  or embedded in its files is never looked up.
- **Nothing is written next to the music.** The mount is very often read-only
  and it is the user's. Fetched images live in `DATA_DIR`, and `art_fetched` is
  a SEPARATE column from `art` because the scan rewrites `art` on every pass.
- **A miss is written down.** Without `cover_lookups` a library of coverless
  bootlegs re-asks about all of them every six hours forever.
- **The SWEEP is not a manual fetch.** No picker and no per-album button in the
  background path — one row in the side menu that says what is happening, and
  `COVER_LOOKUP=false` to remove even that. A sweep that asked a person to
  choose four hundred times would not be a sweep.
- **BY HAND IS THE EXCEPTION, added in 0.4.27 at the user's request, and only
  from the album screen.** The sweep refuses an album whose files name no
  artist — there is no query that would not match half a catalogue — so the
  records it leaves behind are the ones somebody has to name themselves. That
  is the same gesture the 0.4.15 name editor exists for, which is why Find
  cover lives in that dialog and searches with what is IN THE FIELDS rather
  than what is saved. It is still not identification: nothing is written back
  to the album but a picture.
- **The client picks a candidate by POSITION, never by URL.** The server holds
  the list it offered. A server that fetches a URL a client hands it is an open
  proxy onto the network it sits in, and this one sits beside somebody's router.
  `hostAllowed()` guards the download as well, because the check belongs where
  the fetch is rather than where the caller is trusted.
- **A SUBSTRING IS NOT AN IDENTITY.** `artistAgrees()` accepted containment
  anywhere, which is a trap for a short name: `artistKey("REM")` is "rem", and
  "rem" sits inside Remedy, Extreme, Cremation and an anime character called
  Rem — which is how a picker asked for R.E.M.'s "Accelerate" offered a
  cartoon. A featured credit is APPENDED, never inserted, so a PREFIX is the
  whole of what containment was ever for, and it needs a length floor
  (`MIN_ARTIST_PREFIX`). An exact key match can still be two different acts, so
  the TITLE has to agree as well — neither check alone is enough.
- **A PICKER THAT DEMANDS NOTHING OF A TITLE IS A SEARCH PAGE.** "A person can
  see a wrong sleeve" is true of one wrong sleeve and false of eight: asked for
  a bootleg no store carries, the picker offered the artist's whole catalogue
  with nothing to say which was which, and picking any of them would have given
  that record somebody else's cover. `titleRank()` is loose rather than exact
  — the names this feature exists for are the BAD ones, so a folder called
  "Peter Gabriel - Scratch My Back 2010" must still reach "Scratch My Back" —
  but zero relevance is still zero. Candidates are ORDERED by it, because
  without an order the leading sleeve is whichever source replied first.
- **A FOLDER NAME IS A FILING HABIT, NOT A NAME.** `REM - Discography/` and
  `Peter Gabriel - Studio Discography/` are how a great many collections are
  kept, and the artist fallback read them verbatim — filing every record under
  an artist that matches nothing at MusicBrainz, nothing at the iTunes store
  and nothing in a Wikipedia search, so those albums lost their cover AND their
  write-up at once. `readContainer()` and `withoutArtist()` in `lib/scanner.js`
  read those two shapes with the same discipline `splitEdition()` uses: a
  vocabulary that must match WHOLLY, so an unknown word means "this is part of
  the name". Only the FOLDER fallback is trimmed — a title that came from a tag
  is evidence and is left alone.
- **A MISS RECORDED AGAINST A NAME THAT HAS CHANGED IS A STALE MISS.**
  `LOOKUP_GEN` is not only about which sources were asked; it is about whether
  the QUESTION is still the same one. Changing how a name is derived is as much
  a reason to bump it as adding a source.
- **A MISS IS ONLY AS GOOD AS THE SOURCES IT WAS RECORDED AGAINST.** A miss
  means "none of the places we knew about had it", which stops being true the
  moment a place is added — so `cover_lookups.gen` records which set of sources
  answered, and `LOOKUP_GEN` in `lib/covers.js` is bumped whenever that set
  changes. Without it, adding a source leaves every album that already failed
  sitting out its week-long cooldown against sources nobody asked. Hits are
  untouched: the file is on disk.
- **The MusicBrainz release id in the files is the only exact identity this app
  gets for free.** Picard writes it and most libraries carry it. With it there
  is no search, no scoring and no way to match the wrong record — so it is
  tried FIRST, it costs no MusicBrainz request at all, and it is the only thing
  that can find a cover for a Various Artists record. `TAG_SCHEMA` was bumped
  to 3 to read it, because a file whose size and mtime have not changed is
  otherwise never opened again.

## Identification: `lib/identify.js`

Added in 0.4.36 at the user's explicit request, after covers came back as an
anime sleeve and as an artist's whole catalogue. The whole design is a set of
refusals:

- **IT WRITES ONE COLUMN.** `albums.mbid_chosen`, and nothing else, ever. A
  test asserts the complete set of `UPDATE albums SET …` statements in the file
  so a second one cannot be added quietly. Above all it must never write a
  grouping: `lib/duplicates.js` decides what is one record by looking at the
  disk, and a regroup MOVES play counts, so a website must not be able to cause
  one — the same rule `lib/info.js` lives under.
- **`mbid_chosen` IS ITS OWN COLUMN, beside the tag on the tracks**, for exactly
  the reason `art_fetched` sits beside `art`: the scan rewrites what the files
  say on every pass, so an answer a person gave has to live where the scan does
  not reach. `albumMbid()` in `lib/db.js` is the ONE place that decides between
  them — a confirmation beats a tag — because covers, the album screen and this
  module all ask the same question.
- **BY HAND, WITH NO SWEEP AND NOTHING ON A TIMER.** A search always answers,
  and a wrong identification is worse than none because nobody reports it; it
  just quietly attaches the wrong record. So a person reads the candidates and
  taps one. The track count is what makes that judgement possible without
  knowing anything about MusicBrainz, which is why every candidate carries it
  and why "same number of tracks as your folder" is called out.
- **THE ARTIST AND THE TITLE ARE GATES, NOT POINTS.** A release by somebody else
  is not a weaker candidate, it is a wrong one — and offering it at the bottom
  of a list is how somebody taps it at half past eleven. What survives both
  gates is ORDERED, and the track count is the strongest signal by far: a name
  is shared by a dozen releases, a name plus an exact track count almost never.
- **BY POSITION, NEVER BY ID.** The server holds the list it offered, the same
  rule the cover picker follows. A server that stores an identifier a phone
  hands it has checked nothing at all — and a malformed id must never become a
  URL or an identity, which is why the UUID shape is checked on the way in.
- **ONE RATE GATE PER APPLICATION.** MusicBrainz asks for a request a second per
  APPLICATION, not per module, so this queues on `lib/covers.js`'s chain via
  `searchMusicBrainz()`. Two modules each politely waiting a second of their own
  is two requests a second from one app — the rate limit broken by the code
  written to honour it. A test asserts this module owns no timer and does not
  know MusicBrainz's address.
- **AN ALBUM WHOSE RELEASE IS KNOWN IS NOT SEARCHED FOR.** The picker used to
  offer the exact id AND run a name search underneath, which put another
  record's sleeve at position two on an album that was already right. The
  archive is ASKED whether it holds a picture for that release — it knows plenty
  it has no cover for — and only a 404 falls through to the searches.

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
- **AN ID SKIPS THE VERIFICATION BECAUSE IT SKIPS THE GUESS.** `wikiByRelease()`
  takes a confirmed release, asks MusicBrainz which release GROUP it belongs to,
  reads that group's `url-rels` for a `wikipedia` link or a `wikidata` Q-number,
  and fetches THAT article. No `pickAlbum`, no artist check — those exist to
  catch a bad guess, and this path does not guess. It is the same argument
  covers uses for the tagged id, and it rescues the same albums: one whose tags
  are wrong has no facts worth verifying a search against, so it got no write-up
  at all.
- **`intro()` EXISTS BECAUSE THE ID PATH ALREADY HAS THE ARTICLE.** The search
  path gets an intro-only extract with its candidates and pays a second request
  for the full text; the id path fetches the article once and cuts both the
  opening and the reception out of it here.
- **MusicBrainz moved these links to WIKIDATA.** Older release groups carry a
  `wikipedia` relation and newer ones a `wikidata` one, so both are read — the
  direct link first because it costs one request fewer, then the Q-number
  resolved through `wbgetentities` with `sitefilter=enwiki`.
- **A MISS RECORDED AGAINST A NAME MUST GO WHEN THE NAME STOPS BEING THE
  QUESTION.** `/api/album/name` already called `info.forget()`; identifying did
  not, so an album could be identified CORRECTLY and still show nothing for the
  week its miss had left to run. Anything that changes what an album IS has to
  clear both the cover miss and the write-up miss — the same rule `LOOKUP_GEN`
  states for sources, applied to names.
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
- **A paged list cannot use an unseeded shuffle.** SQLite's `RANDOM()` draws
  again on every call, so page two of the Library wall would be a different
  shuffle from page one — some albums twice, others never. `seeded_rank()` in
  `lib/db.js` hashes the id with a seed instead, and the seed is what a
  reshuffle changes.
- **An unknown value is not a zero.** An album with no year sorts to the END of
  the wall in BOTH directions, and so does one never played under "Last
  played" — the `(year IS NULL)` term is deliberately not reversed with the
  rest. Reversing it floats every untagged record to the top.
- **Random Album Radio rides on the poll loop, not on a phone.** `lib/radio.js`
  picks and `lib/playback.js` adds, on a TRACK CHANGE only — reading the queue
  back off the speaker is a SOAP call, and doing it every five-second poll would
  triple that loop's traffic to answer a question that can only change when the
  track does. The whole queue is read, not the tail: the tail says whether an
  album is due, and the rest says what must not be offered again — and at the
  moment a top-up is due the tail is EMPTY, so a tail-only read excludes
  nothing. The fake Sonos honours `StartingIndex` because a real one does.
- **ONE CALL PER TRACK IS A QUEUE THAT TRICKLES.** `AddURIToQueue` takes one
  track, so ten albums was a hundred and twelve SOAP round trips awaited in
  turn — the tracks appearing a few at a time over several seconds, which is
  what the user reported. `AddMultipleURIsToQueue` is what the Sonos app uses:
  `QUEUE_BATCH` (16) URIs space-separated and ONE DIDL-Lite document holding an
  item each, built by `trackItems()` in `lib/didl.js` so metadata still has one
  home. The old path stays as the FALLBACK — this cannot be tried against every
  player that exists, and a refusal must end in a full queue rather than an
  error.
- **SONOS RENUMBERS THE QUEUE THE INSTANT ANYTHING LEAVES IT.** So the order of
  the removals is the whole of the correctness: `removeFromQueue()` collapses
  neighbouring positions into runs and applies them from the END backwards,
  because a caller working forwards deletes the wrong tracks from the second
  range on. Positions, never track ids — a queue can hold the same track twice.
- **Several albums are ONE enqueue, not a loop.** `enqueue()` clears the room's
  queue when `replace` is set, so playing a selection an album at a time would
  have each one wipe the one before it and leave only the last playing.
  `playAlbums()` concatenates the tracks and sends them once, in the order they
  were chosen.
- **A selection belongs to the session, not to a screen.** Multi-select has to
  survive walking from one carousel to another through Home, so `state.select`
  is the truth and the cards are painted FROM it every time a wall is rebuilt —
  never the other way round. Nothing in `showView()` or `openRow()` may reset
  it, and the repaint is document-wide because Home's carousels, the search
  results and an artist's albums are all cards outside `#album-grid`.
- **A TINT SAYS WHAT IS CHOSEN; A BOX SAYS WHAT COULD BE.** The queue's picked
  rows were tinted, and on a hundred-row queue that read as noise — two shades
  of row, with nothing on an unpicked one to say it was a target. Every row
  carries a `.q-check` from the start and `is-picking` on the LIST swaps the
  duration for it, so turning the mode on is one class rather than a rebuild.
  Where a list already tints a row for something else — `is-now` here — a
  second tint has nothing left to mean.
- **A QUEUE POSITION IS NOT AN ALBUM ID, so it gets its own selection.**
  `state.select` holds album ids and deliberately follows you between screens;
  `state.qsel` holds POSITIONS, which mean nothing on another screen and
  nothing on this one once the queue has changed — so `loadQueue()` clears it
  on every read. Rows are still painted FROM it, never the other way round.
- **A SECOND BAR IN THE SAME PLACE NEEDS THE SAME EXEMPTION.** The queue's
  selection bar is a `.select-bar`, so `syncMini()` has to hide the mini
  transport for it exactly as it does for the album wall's — and
  `paintQueuePicks()` has to CALL `syncMini()`, because knowing the rule is not
  applying it. Positioning it inside the queue pane instead put it under the
  mini bar: visible, and unpressable. Only a real browser caught that.
- **A hold on a card must lose to a scroll.** The carousels are flicked
  sideways from the same cards the hold starts on, so movement past
  `PICK_SLOP` cancels it — and the click that arrives behind the finger is the
  same gesture, so it is swallowed rather than treated as a tap.
- **A waveform is averaged nowhere.** Peaks are resampled by MAXIMUM in
  `lib/waveform.js`, on the server and again in the client's `drawWave()`.
  Averaging peaks turns a sharp track into mush, which is the one thing a
  waveform is for. Each track is normalised to its OWN loudest moment: an
  absolute scale leaves a quietly-mastered record a flat line beside a loud one.
- **A waveform squeezed into the seek bar's own height is not readable.** At
  14px every peak lands within a few pixels of every other and the shape reads
  as a texture. The canvas draws at `--wave-h` (34px) and the INPUT IS GROWN to
  match: a range centres its own track and thumb in its box, so the thumb lands
  on the waveform's midline with no offset to maintain, and the whole shape
  becomes draggable rather than just the 4px line. Chrome's UA sheet also puts
  `margin: 2px` on `input[type=range]` — the canvas is positioned against the
  CONTAINER, so `--seek-inset` has to allow for it or the shape sits two pixels
  above the thumb.
- **A CONTROL'S GEOMETRY IS A FACT TWO DRAWINGS SHARE, so it is a token.** A
  range input cannot let its thumb hang off either end: the centre travels
  `thumbW/2` to `width - thumbW/2`, not `0` to `width`. The waveform coloured
  its bars across the full width, so the dot sat 6px AHEAD of the shape at the
  start and 6px behind it at the end and agreed only in the middle — which is
  why it survived being looked at. `--seek-thumb` is now declared once on
  `.np-progress`, read by both thumb pseudo-elements and by `drawWave()`.
  Whenever a canvas has to line up with a native control, the number that
  positions both belongs in one place.
- **A custom property inherits DOWNWARD, so read it from the element that
  declares it or below.** `--seek-thumb` lives on `.np-progress`; asking
  `document.documentElement` for it returns an empty string with no error, and
  the fallback silently becomes the value.
- **AN INLINE CUSTOM PROPERTY BEATS ANY STYLESHEET RULE, however specific.**
  `.np-progress.has-wave .np-seek { --fill: transparent }` does nothing on its
  own, because `fillRange()` writes `--fill` inline four times a second — so the
  inline one has to be REMOVED. Both halves are needed, and MusicD Remote
  shipped only the stylesheet half and drew a grey line through the middle of
  the waveform. Suspect this whenever a stylesheet rule "does not apply".
- **A stored waveform is only believed when it is still about this file.** The
  decode rate, size and mtime live beside the peaks, and all three are checked:
  a rate change is a different-shaped picture, and a re-rip at the same path is
  the same track id in front of audio that is gone. A MISS is stored too, or a
  file ffmpeg cannot read is attempted again on every visit to Now playing.
- **The waveform look-ahead is the ALBUM, not the speaker's queue.** Reading the
  real queue back off Sonos is a SOAP call — the rule the radio lives under —
  and this app has no shuffle and no repeat by design, so the next track on the
  record is the right guess for a database read instead of network traffic.
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
- **A KEYBOARD'S HEIGHT IS NOT A SCROLL POSITION.** `--kb-inset` once measured
  `innerHeight - (visualViewport.height + offsetTop)`. `offsetTop` is how far
  the visual viewport has slid inside the layout viewport — the scroll — so the
  measurement decayed from 266px to 0 over one flick while the keyboard stood
  still, switching the correction off during the exact gesture it exists for.
  Measure `innerHeight - visualViewport.height` and nothing else.
- **Arithmetic against the viewport is the wrong tool for "the keyboard covers
  it", because there is no one viewport.** Safari shrinks the visual viewport
  and leaves the layout viewport alone, an installed home-screen app has been
  seen to shrink both, and a fixed element is re-anchored to the visual
  viewport mid-scroll in either — so one subtraction lands in three places. The
  mini bar is now ABSENT while a text field has the keyboard, which is the same
  intent with nothing left to paint wrongly. Prefer stating the intent over
  approximating it whenever the platform disagrees with itself.
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
- **AND THE FAKE SONOS REFUSES AN ACTION IT DOES NOT IMPLEMENT.** Its `default`
  branch used to answer 200 with an empty envelope, so a caller invoking
  something no speaker implements looked like it had worked — which is exactly
  how `AddMultipleURIsToQueue` was able to enqueue NOTHING while every
  transport test stayed green. It sends a UPnP `401 Invalid Action` fault now,
  as a real player does. Implement the action in the fake or expect the
  refusal; never both silently.

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
- **The side menu's order is FIXED; the home screen's is not.** They used to be
  the same list, dragged from the menu. A menu whose entries move about is one
  you have to read rather than reach for, so `MENU_ORDER` states it once and
  arranging moved to Settings › Home screen. The menu only ever answers WHICH
  carousels are on — `MENU_ALWAYS` keeps Library and Artists whatever the home
  screen is doing, because Artists has no carousel and Library is the way into
  the whole collection.
- **`state.rows` is the home screen's built payload; `state.homeRows` is the
  arrangement.** They are different things and the names nearly collided —
  renaming `rowOrder` to `rows` produced a DUPLICATE KEY in the state literal,
  which JavaScript accepts silently and the last one wins. Every switch then
  did nothing. Grep the whole tree before reusing a name.
- **Switching a carousel off is what stops its work, because nothing is on a
  timer.** Smart Picks is rebuilt once a local day the first time something
  asks; `/api/home` not asking IS the off switch. There is nothing to cancel.
- **A row that does two things needs two controls.** The covers row hid its
  switch behind a 500ms HOLD while its tap looked now — so nothing on screen
  ever said the sweep also runs by itself, and the switch read as decoration.
  The name opens the missing list and the switch is a switch. `paintToggle()`
  handles both shapes: the element may BE the switch or contain one, and
  `querySelector` alone finds only the second — which left the covers switch
  announced on and painted off.
- **A control that shows a state does not have to take the tap.** Every
  two-state settings row was already a button that toggled, so the switch and
  the named pair added in 0.4.32 are DECORATION — `aria-hidden`, no nested
  button, and the row keeps `role="switch"` where on/off is really the
  question. A small control nested in a big one is two tap targets that can
  disagree about what a press meant.
- **`.menu-sub` needs `display: block` of its own.** It used to get its line
  from `.menu-item` being a flex COLUMN; a row with a control beside it is a
  flex ROW, and the sub-line then runs on after the title.
- **A notice nobody scrolls to is a notice nobody reads.** The update banner
  sat in the page flow, so anyone halfway down a wall never learned a version
  was waiting. It is FIXED under the top bar now, above the page and below the
  album panel (70) — over Now playing it would overlap that screen's own
  header. A tint token like `--accent-soft` is translucent, so a floating
  banner has to layer it over a solid ground or the sleeves show through it.
- **A LIST OF ALBUMS IS A GRID SCREEN, not a view inside the drawer.** The
  missing covers were a fourth panel in the side menu, which put the album you
  tapped over whatever was behind the drawer — so Back from a record you had
  just found a cover for landed on Home instead of on the ones you were still
  working through. Anything that is a wall of albums goes through `openRow()`
  and gets `ROW_TITLES`, `ROW_EMPTY`, `PAGED_ROWS` and the navigation stack for
  free. A grid screen is not necessarily a home row: `ROW_DEFS` in `index.js`
  is what `/api/albums` can open, `DEFAULT_ROWS` in `lib/settings.js` is what
  Home is made of, and `nocover` is deliberately only in the first — which is
  also why `/api/rows` names the rows it LISTS rather than everything `ROW_DEFS`
  knows about.
- **A screen whose MEMBERSHIP an edit changes has to be re-read on the way
  back.** Finding a cover takes that album off the missing wall; a wall still
  showing it says the search did not work. `reloadCoversGrid()` runs from
  `hideModal()` and from the sweep's finish — on the TRANSITION only, because
  re-reading on every status poll would throw somebody's scroll away twice a
  minute. It is safe to call from inside the popstate that closed the panel
  because `navOpen()` REPLACES a layer that is already on top rather than
  stacking one.
- **A SLOW ANSWER THAT FINALLY FAILS MUST NOT LAND ON A NEWER ONE.** An aborted
  Identify wrote its error over a list of results that had arrived perfectly
  well, because nothing said which request the answer belonged to. Every dialog
  search takes a ticket (`matchReq`, `coverReq`) and drops anything but the
  newest — the same discipline `loadGridPage()` uses with `state.grid`. Applies
  to the `finally` too: a stale response must not re-enable a button the live
  one is still using.
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
