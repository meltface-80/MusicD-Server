# Changelog

## 0.3.3

### Multi-disc albums are one album again
- **A release split across `Disc 1` / `Disc 2` folders is now a single album.**
  Every spelling in ordinary use is read: `Disc`, `Disk` and `CD`, in any
  mixture of upper and lower case, with or without a space before the number —
  `Disc 1`, `disc1`, `CD 2`, `cd2`, `DISK 3` — and with a separator or brackets
  around it if the ripper put one there: `Disc-1`, `CD_2`, `(Disc 2)`,
  `[CD1]`, `CD 1 of 2`. A subtitle after the number, as in
  `CD1 - Early Sessions`, is read as the disc's own name and does not stop the
  fold.
- Both of the two layouts these rips arrive in are handled. Discs sitting
  inside the album folder — `Physical Graffiti/CD1/` — fold into the folder
  that holds them. Discs sitting beside each other as siblings —
  `Kid A (Disc 1)/` and `Kid A (Disc 2)/` — fold together on the name they
  share, so `Kid A Disc 1`, `Kid A - Disc 1`, `Kid A (Disc 1)` and
  `Kid A [CD2]` all land on `Kid A`.
- **The folder's disc number wins over the tag.** A rip split into two folders
  very often has every file tagged disc 1, and trusting that would interleave
  the two halves. A tag is still used when the folder does not say.
- Words that merely start the same way are left alone. `Discovery`,
  `Discipline`, `Disco 2000` and `CD Baby` are albums, not discs.
- **Folding an album keeps the history of the pieces it was made from.** Play
  counts add up, the earliest date added is kept, the most recent play is kept,
  and the individual plays are moved onto the merged album — so the six-month
  row and Smart Picks still know what you listened to. Nothing is deleted.

### Fixed
- `Disco 2000` was becoming an album called `Disco` released in 2000. The year
  strip added in 0.3.2 took any four digits off the end of a folder name; it now
  requires the year to be bracketed — `Deceiver (2021)`, `[2021]` — or set off
  by a separator — `Album - 2021`, `Album_2016`. A bare space in front of it is
  part of the title.

## 0.3.2

### Albums coming back as "Unknown artist"
- **A rescan after upgrading from 0.1.0 blanked album titles and artists, and
  this fixes it.** 0.2.0 started keeping the album, album artist, genre and
  year per track and deriving the album from all of them; the migration added
  those columns empty, and the scan skips any file whose size and modification
  time are unchanged — so the files were never opened again, the columns stayed
  empty, and the next scan derived the album from nothing. Tracks now record
  which generation of tag-reading produced them, and anything older is re-read
  once. Nothing to do but let a scan run.
- The album artist is worked out down a ladder rather than in one step: the
  album-artist tag when the folder agrees, the one most tracks carry when a few
  disagree, then the track artist, then Various Artists, and finally the folder
  the album sits in — `Artist/Album/` is how most libraries are laid out. A
  folder called Unknown, Various Artists or Compilations is read as saying there
  is no artist rather than naming one.
- A year in a folder name — `Deceiver (2021)` — becomes the album's year instead
  of part of its title.

### Interface
- The share button on the album screen is in the right corner. Auto-placement
  had put it in the middle column, next to Back, because the controls it should
  have followed are hidden on that screen.
- The progress bar runs on a clock rather than on the poll, so it moves
  smoothly instead of sitting still and jumping every few seconds. Playback was
  never affected; only the drawing was.
- Track rows have the same inset on both sides. The number was right-aligned
  inside a fixed box, which pushed every single digit about twenty pixels in.
- **Check for updates** in the side menu, which reports what it finds either
  way — the automatic check only speaks up when there is something to say, so
  there was no way to see it working.

## 0.3.1

- The top bar is the menu and the search, and nothing else. The wordmark has
  gone from it — the side menu carries the mark, and repeating it over a screen
  that is plainly the app cost a line the screen names need on every other view
  — and the search moves into the corner it left.
- The room picker has gone from the top bar too. It was a third copy: the mini
  transport has one and so does Now playing.
- **Which means the mini transport is now always on screen**, playing or not,
  because it is where a room is chosen. Idle it says which room it would play
  to, or asks for one — hiding it on a fresh install would have left nowhere to
  pick a speaker at all.
- The side menu's wordmark is the same mark as the share card, sized to the
  header. The light theme inverts it, the mark carrying no colour of its own.

## 0.3.0

### An installed app updates itself
- A service worker, added for one reason: a home-screen app would not pick up
  new versions. Its strategy is the opposite of the usual one — nothing is
  pre-served from cache while the network is reachable, and every shell request
  goes out with `cache: "reload"`, which bypasses the HTTP cache underneath the
  worker as well. The cache is a fallback for being offline, not a speed layer;
  this is a server on the same LAN and a round trip is not worth a stale
  interface. A new worker takes over immediately and the page reloads once.
- It is registered from script, never from a `<head>` tag. iOS reads the head at
  add-to-home-screen time and bakes the result into the shortcut, which this
  project has already been bitten by.
- **Service workers need a secure context.** Over plain `http://` on a LAN
  address the registration is refused and the app behaves exactly as before —
  the no-cache shell, versioned asset URLs and stale-page banner from 0.2.x are
  what cover that case. Behind HTTPS, this is what makes updates arrive on
  their own.

### Share card
- Type sizes and spacing are MusicD Remote's, so a card from either app is
  recognisably the same object: the year at 26, the title stepping 56 → 27 and
  the artist 37 → 21, both shrinking before anything is cut.
- The track count and running time are gone. A share card says what the record
  is; how long it runs is a detail for the album screen.
- The wordmark is the real mark — traced from the original artwork at 4x into a
  6.8KB SVG, so these are the same shapes rather than a redrawing, on a
  transparent ground and drawn twice the size it was.
- The text now reserves the mark's band and steps its type down to fit what is
  left. Fitting on width alone was enough while the mark was small; at its real
  size a long title ran straight through it.

## 0.2.3

- **Now playing is laid out the way MusicD Remote lays it out.** The screen
  never scrolls: the tabs, title block, seek row, transport and room row take
  their natural height and the ARTWORK absorbs whatever is left. The cover is
  full-bleed — edge to edge, cropping rather than letterboxing, with its bottom
  fading into the ground so the title sits in the tail of the image instead of
  under a hard edge.

  It replaces a fixed `min(300px, 66vw)` card, which could only be right at one
  screen height: on a tall phone it left a third of the screen empty below the
  controls, and it had no way to shrink on a short one. Landscape tablets and
  desktops put the art beside the controls in two columns, where the framed card
  comes back because nothing bleeds off a screen edge there.

## 0.2.2

- **The page now says when it is out of date.** `index.html` is built by the
  server rather than served from disk: the asset URLs carry `?v=<version>`, so
  a browser holding an old `app.js` or `style.css` cannot serve it against the
  new address, and a `<meta>` records which version the document itself is. If
  that disagrees with what the server reports, a banner says so and offers a
  Reload on a fresh URL — one a cache cannot answer.

  This is the state nothing else could detect. A shell cached before 0.2.1
  fixed the caching rules will not revalidate until its stored lifetime runs
  out, so a correctly updated server goes on serving a previous release's
  interface with no sign of it.

## 0.2.1

- **The app shell is no longer cached for an hour.** `index.html`, `app.js` and
  `style.css` were served with `max-age=3600`, so for an hour after updating the
  container the browser kept using the previous interface without ever asking
  the server — an update that had genuinely arrived looked like one that had
  shipped nothing, and a home-screen shortcut made it worse. They now revalidate
  on every load; the ETag makes an unchanged file a 304 with no body. Icons keep
  a long cache, being the one thing that does not change between versions.

## 0.2.0

### Interface — parity with MusicD Remote
- Now playing and Queue as two tabs of one screen, matching MusicD Remote: a
  Home control on the left, the tabs centred, and five transport buttons —
  shuffle, previous, play/pause, next, repeat.
- Shuffle and repeat drive Sonos' single play-mode enum, read before it is
  written so that toggling one never clears the other. Repeat cycles
  off → all → one.
- The queue page summarises what is left to play, counts what was played
  earlier rather than listing it, and marks the current track with a divider.
  Tapping a later track jumps to it.
- Search puts artists first, as chips above the album grid, and the search
  field takes the whole top bar rather than sharing it with the screen title.
- Mini transport with play/pause leading, then what is playing, then room and
  volume. It sits above the album and queue screens and steps aside for Now
  playing, which already has the full transport.
- Share card: a 1200x600 PNG of any album, drawn in the browser from the album
  row alone — the cover softened as the ground, a glass pane over it holding
  the sharp cover, the year, the title, the artist and the length. Copy,
  system share and download are each offered only where the browser can
  actually perform them. From Now playing it uses the track playing at the
  moment you tap, not the album the panel was opened with.
- Back — the phone gesture as much as the on-screen control — closes the
  innermost thing that is open, one layer at a time, and leaves the app only
  from the library.

### Updating and versions
- The image carries the version, the commit it was built from and the date it
  was built. All three are reported by `/api/status` and shown in the side
  menu, so what is running can be identified without guessing.
- The app checks GitHub for a newer release once per load, from the browser
  rather than the server, and says so quietly when there is one. It fails
  silently offline and can be dismissed.
- Every push to `main` now publishes `:latest`, `:<version>`, `:<major.minor>`
  and `:sha-<commit>`, so a version can be pinned or rolled back to.
- A release is tagged and published automatically when the version in
  `package.json` changes on `main`.
- **The documented install and update commands now pull.** `docker run` reuses
  a cached tag without checking the registry, so stopping the container,
  removing it and running the same command again gave you the image you
  already had — which looked exactly like an update that shipped nothing.

## 0.1.0

First version. A local music server that plays to Sonos.

### Library
- Folder-based scanning: an album is a folder, its title and artist come from
  the tags, and the folder name is the fallback when the tags say nothing.
  No metadata service, no album identification.
- Album artist derived per folder — unanimous album-artist tag, else unanimous
  track artist, else Various Artists.
- Cover art from a conventionally named image in the folder, any other image in
  the folder, or artwork embedded in the files (extracted once and cached).
- Incremental rescans: a file whose size and modification time are unchanged is
  never re-read, and the album-level tags are kept per track so a partial rescan
  still derives the album from every file in the folder.
- Symlinked folders are followed, with loop protection.
- Albums that disappear are marked absent, never deleted, so a NAS that was not
  mounted at scan time costs no history.

### Listening history
- SQLite: date added, date last played and play counts, for albums and for
  tracks separately, plus a full play history.
- Plays are counted by watching the speaker, not the Play button: half way
  through a track or four minutes in, whichever comes first. A skipped track is
  never counted, and an album played through is one album play.

### Home screen
- Six carousels, each opening into a full grid that pages as it is scrolled:
  Library, Random albums, Recently added, Recently played, Not played in
  6 months, Smart Picks.
- "Not played in 6 months" covers both albums played longer than six months ago
  and albums that have sat that long unplayed, longest gap first. It is empty on
  a new library by design.
- Smart Picks: local files only, built from a 90-day taste profile of what you
  played, excluding anything played in the last 60 days, one album per artist,
  and every pick carries the reason it was chosen. An album with no connection to
  the profile is never offered.

### Playback
- Sonos control written against the protocol directly: SSDP discovery,
  ZoneGroupTopology for rooms and groups, queue-based playback for gapless
  transitions, RenderingControl for per-speaker volume.
- DIDL-Lite metadata carrying the `RINCON_AssociatedZPUDN` descriptor and a
  protocolInfo matching the file, which is what Sonos requires of a third-party
  HTTP stream.
- Audio is streamed straight from this server to the speaker with byte-range
  support; nothing is transcoded and nothing is proxied.
- Transport commands follow the group coordinator; volume stays with the room.
- Files Sonos cannot decode are listed and marked rather than hidden. Whether a
  file is playable is decided once on the server and sent to the client, so the
  badge and the queue builder can never disagree.
- A failed discovery is remembered for thirty seconds and the status endpoint
  never waits on one, so a network with no Sonos on it costs nothing.

### Interface
- MusicD Remote's palette, control sizing and section rhythm, in dark and light.
- Album view with track list, play-from-any-track, and the album's own stats.
- Now playing with seek, volume, room switching and the queue.
- Search across albums, artists and tracks; an artists index.
- Mini transport across the bottom of every screen.
  innermost thing that is open, one layer at a time, and leaves the app only
  from the library.

### Packaging
- Docker image on host networking, with `TZ` documented as load-bearing: the
  six-month row is a calendar boundary and Smart Picks rebuild once a local day.
