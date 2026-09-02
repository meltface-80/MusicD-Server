# Changelog

## 0.4.16

### The mini transport is a quarter taller
- **88px instead of 70, and it grew upward.** The bar is fixed by its bottom
  edge, so its underside is exactly where it was and the extra height could
  only go up. Everything that sits against it — the foot of the page, the foot
  of the album panel, the volume sheet and the toast — is worked out from that
  one number rather than repeating it, so all of them moved with it.
- **The cover, the type and the buttons grew with it**, because a taller bar
  with the same contents in it is not a taller bar, it is the old bar with a
  band of empty above and below. The sleeve goes from 44px to 56 and keeps the
  share of the height it always had; the track title goes to 14px and the
  artist line to 13; the three buttons go from 44 to 48 with 24px icons.
- **The title is 14px rather than 15 for a measured reason.** The bar did not
  get any wider, so the type is paid for out of the title's own column: at the
  width of a standard phone that column is 138px, and the track this was asked
  for — "Back in the Woods" — takes 125px at 14px and 134px at 15. Fifteen fits
  by four pixels there and not at all on a 375pt phone. A title that starts
  ellipsising a word early is a worse bar than a title one point smaller.
- The play button is no longer squeezed. It is the one control in the row that
  sits directly in the bar rather than in the group at the end, so it was the
  only thing left able to shrink when the row ran out of width — and at 88px it
  did, drawing a 46px target where 48 was asked for.

## 0.4.15

### An album's title and artist can be corrected by hand
- **A `…` button on the album's sleeve, with Edit on it.** Some records arrive
  with no artist tag at all and show as "Unknown artist" when you know exactly
  who made them. Typing the name in is now the answer, and it is the only thing
  on the menu: this is not album identification, nothing is looked up and
  nothing is matched against anything.
- **Your music files are never written to.** The correction lives in its own
  pair of columns beside the tags, which are left exactly as they are — the
  mount is very often read-only, and it is yours. Nothing in the scan mentions
  those columns, so a rescan cannot undo a correction, in the same way it
  cannot undo a heart or reset the date an album arrived.
- **Clearing a field puts the tags back**, which is the whole of the undo and
  the reason there is no third button for it. The field says what it will fall
  back to.
- **The corrected name is the name everywhere** — the home rows, the shelf
  order, search, the artist list, Smart Picks, Now playing, the queue, the
  mini bar, the scrobble, and the display on the speaker itself. Every one of
  them asks one place what an album is called rather than reading the column.
- **Grouping two copies of a record still goes on what is on disk.** A match
  moves the play counts of the copy it demotes, and typing a name back would
  not bring them home — so a rename cannot fold two albums into one.
- An album whose files name nobody can now be scrobbled once you have said who
  made it. Before, a listen with no artist was one Last.fm could not be told
  about.
- **A track in the search results now shows a cover that was found online**, not
  only one that was already in the folder. That row was the last reader still
  asking the old question, and it was asking it a line away from the answer.

### The scroll bar on a screen that does not scroll
- **Now playing had a scroll indicator down its right-hand edge.** The face
  never scrolls, and it was not its bar: a drag it had no use for was being
  handed to the page behind it, which scrolled invisibly under a full-screen
  overlay and showed its own indicator over the top. It was also quietly
  loading another page of albums every time it reached the end.
- The face now declines the drag outright, and the panel's own scroll stops at
  the panel — so flicking past the end of a track list no longer leaves the
  home screen somewhere else when you close it. The one short-window layout
  that really does scroll still does.

## 0.4.14

### The side menu is places first, settings behind one button
- **Everything below the home screen's rows moved into Settings** — rescanning,
  theme, finding covers, Last.fm, updates and the version. The menu is now the
  seven places you can go plus one way into the preferences, instead of a list
  of sixteen things to read.
- **The library's counters stayed put.** How many albums and tracks it holds and
  how many Sonos rooms are on the network sit at the foot of the menu in both
  views, outside the part that scrolls — so they are a glance rather than a
  scroll to the end.
- The Settings line names what is actually behind it, so a container without
  Last.fm or with cover lookup switched off does not advertise a setting that
  is not there. Escape steps out of Settings before it closes the menu, and
  reopening always lands on the first view.

## 0.4.13

### The keyboard no longer pushes the mini transport around
- **Search, scroll, and the transport bar climbed on top of the keyboard.** It
  is fixed to the bottom of the page and belongs there — but iOS re-anchors a
  fixed element to the visual viewport while the page is scrolling, and with
  the keyboard open that lifted the bar out of the page and left it floating
  over the keys.
- **The bar now holds its place and the keyboard simply covers it**, which is
  what it should have done: neither one is in the other's way, and closing the
  keyboard puts the bar back exactly where it was. The volume sheet uses the
  same measurement, so the two never come apart.
- Nothing moves for anything that is not a keyboard — browser chrome and a
  pinch-zoom are ignored — and on a browser with no visual viewport to ask,
  behaviour is unchanged.

## 0.4.12

### The artwork is back on Now playing, the Queue and the mini bar
- **A cover was showing everywhere except the three screens that matter while
  something is playing.** Making the transport aware of covers that had been
  found online meant renaming the field it reads, and two of the three readers
  were left on the old name — so Now playing, every Queue row and the mini
  transport got an empty string for every album, whether its cover came from
  the folder or not. All three read one method now, so a reader cannot fall out
  of step with the query that feeds it again.
- The oddly tall empty box on Now playing was that same bug: it is the
  no-artwork placeholder filling the space the cover should have had. With the
  cover back it is a square, uncropped, exactly as before.

## 0.4.11

### Two things 0.4.9 and 0.4.10 got wrong
- **"Find missing covers" was missing from the side menu.** The row is hidden
  unless the server says cover lookup is available, and the server only said so
  on its own endpoint — never in the status the menu is actually painted from.
  So the row was hidden on every install and the whole feature was
  unreachable. It appears now.
- **Two rips of one album stayed two albums when only one of them was
  tagged.** Track titles are the second opinion that decides whether two
  same-named albums really are the same record, and a file with no title tag
  falls back to its filename — so one copy's tracks read "01 Wasting the Dawn"
  where the other's read "Wasting the Dawn", they matched on nothing, and the
  pair stayed on the shelf. A leading track number is no longer treated as part
  of a track's name. Different records are still different: dropping the number
  cannot make two albums match that share no track names.

## 0.4.10

### Scrobbling to Last.fm
- **Every track this server counts as played now goes to Last.fm**, if you
  connect an account. It is the same event: half way through, or four minutes
  in, whichever comes first — which is Last.fm's own rule, so a skipped track
  is never scrobbled and a play count and a scrobble can never disagree about
  what you listened to.
- **Connect from the side menu.** It opens Last.fm's own approval page; MusicD
  never sees your password. Tap the row again to finish, hold it to
  disconnect. A compilation scrobbles the track's artist, not "Various
  Artists".
- **Last.fm needs an API key, and there is no way around it** — it has no
  OAuth 2 and no anonymous mode. It is a developer key you make once, free, at
  last.fm/api/account/create, and it goes in the container as
  `LASTFM_API_KEY` and `LASTFM_API_SECRET`. Nothing is typed into the app, and
  without both values the row does not appear at all.
- **Nothing is lost to a bad network.** A listen is written to the database
  before it is sent and deleted only once Last.fm has accepted it, so a router
  reboot, a restart or an update never costs you one. A weekend offline goes
  back fifty at a time.

## 0.4.9

### A cover for albums that have none
- **An album with no picture now gets one found for it**, once, in the
  background after a scan. An album that already has a cover — in its folder or
  embedded in its files — is never touched, and nothing is ever written next to
  your music: the image goes in the data directory and the album points at it.
- **No API key and no account.** MusicBrainz says which release it is and the
  Cover Art Archive has the picture; both are open, and both are asked politely
  — one request a second, a client that says who it is, and a full stop the
  moment either says slow down.
- **The album name and the artist first, then the track names.** Two tracks
  searched as recordings by the same artist, and the release they both point at
  is the record — which rescues an album whose album tag is blank or wrong. One
  track is on a dozen compilations, so a single agreement is not evidence.
- **It is not a manual fetch.** No picker and no per-album button. The side menu
  has one row: tap it to look now, hold it to switch it off. A container started
  with `COVER_LOOKUP=false` does not show the row at all.
- **A miss is remembered for a week**, so a library full of bootlegs costs a
  handful of requests rather than hundreds on every scan.

## 0.4.8

### One album, however many copies of it are on disk
- **A deluxe edition is now a version of the album rather than a second
  album.** The home screen, the grids, the search results and the artist pages
  show the record once; the album screen carries a tab for each copy, and
  tapping one swaps the track list, the cover and the runtime without leaving
  the screen.
- **The one without the edition marker in its title is the album.** "Souvlaki"
  wins over "Souvlaki (Deluxe Edition)" even though the deluxe has more tracks
  on it. Ties between two equally plain titles go to the fuller copy.
- **The grouping is local and it is careful.** An artist name, the title with
  its edition marker taken off, and the track titles as a second opinion —
  nothing is asked of the internet and nothing is identified against a
  catalogue. A bracket the vocabulary does not recognise stays part of the
  title, so "(Live)", "(Instrumental)" and "(feat. …)" never fold, and the four
  different albums called "Weezer" stay four albums.
- **A group has one history and it follows the album.** Playing the bonus track
  on the deluxe edition is playing the album; a heart tapped on any tab is the
  album's. Delete the standard edition and the deluxe becomes the album, plays
  and all.

## 0.4.7

### The mini transport
- **The side menu now covers it.** The bar outranks every screen in the app —
  it is how you pause what is playing without leaving whatever you are reading,
  so an album panel or a grid never hides it. The menu is the one exception: it
  is a modal drawer with a backdrop across the whole screen, and a transport
  pill floating on top of that backdrop read as a bar that had failed to get
  out of the way rather than one still available.
- **It is a tenth taller** — 64px to 70px. Everything that clears it or sits
  against it, the album panel's foot and the volume sheet's anchor included, is
  derived from that one number, so nothing had to be moved by hand and nothing
  is hidden behind it.

## 0.4.6

### Arrange the home screen
- **Every row now has a pad in the side menu. Hold it, drag the row where you
  want it, let go.** The home screen follows immediately, and the arrangement
  is saved.
- **The menu lists every row the home screen can show**, which it did not
  before — Random albums and Favourites were on the home screen but not in the
  menu. Reordering a list missing two of the rows would have left them
  stranded wherever they happened to be, so the menu is now the complete
  picture and the pads act on all of it.
- The order lives in the library's own database, not in the browser: arrange it
  once and every phone in the house agrees, a reinstalled shortcut remembers,
  and it survives an update for the same reason the play history does.
- A quick flick on a pad still scrolls the menu. The hold is what starts a
  drag, and moving before it elapses is taken as a scroll.
- Tapping a row still opens it — the pad is its own control, so arranging the
  menu never gets in the way of using it.
- An order that names a row this version does not have drops it, and a row it
  does not mention goes back where it started. That is what lets a later
  version add a row without it disappearing for anybody who had already
  arranged theirs.

## 0.4.5

### The in-app update works
- **Every update from the app since 0.4.0 failed with "GitHub answered 415".**
  The download asked for the release archive with
  `Accept: application/octet-stream`, which is the header for a release *asset*
  — on the archive endpoint GitHub refuses it as an unsupported media type. It
  asks for anything now, which is the honest request: what comes back is a gzip
  from GitHub's download host, and it is checked after unpacking rather than by
  its type.
- The API version is pinned, so a change to what GitHub defaults to cannot
  change what the updater gets back.
- **The test that should have caught this now can.** Four tests covered the
  transport and all four passed, because the stand-in for GitHub answered
  whatever it was asked — a header nothing looks at is a header nothing can get
  wrong. It refuses the way the real one does now: ask for an archive as
  octet-stream and it answers 415, which turns the exact shipped bug red.

## 0.4.4

### Fixed
- **Tapping an artist on the album screen went to the home screen instead of
  their albums.** The navigation stack unwinds by closing every layer past the
  one being returned to, and it re-read the stack between closes — so a layer
  PUSHED BY a close was seen as one more thing to unwind. Closing the album
  panel opens the artist's screen, and the same loop then closed that too. It
  only happened when the panel was the only layer on the stack, which is what
  opening an album straight from the home screen does; coming from the library
  grid or a search hid it, which is why it survived being tested. The layers
  are taken off first and closed second, so anything opened along the way is
  left alone.
- **The − and + on the volume bar sit on the centre of their circles.** They
  were text, and flexbox centres the line box rather than the glyph: where the
  ink lands depends on which font the platform resolves, measured at about a
  pixel out here and different again on iOS. They are drawn now, two lines
  through the middle of a 24×24 box, which is centred everywhere.

### Now playing
- **The artist's name opens their screen**, the way the album name beside it
  already opens the album. Both screens build their names through one function,
  so they cannot drift about what counts as one artist.

## 0.4.3

### A long press no longer selects the app
- **Resting a thumb on the app raised iOS's selection handles and its
  Copy / Look Up / Translate bar over it.** A long press on a phone is how you
  scroll from a standstill and how you hesitate before tapping; on a web page
  it also selects text. This is a remote control, and every word on it is a
  label on a control — so nothing is selectable now.
- The two exceptions are deliberate: a search field still behaves like a field,
  and the share card still answers a long press with the phone's own save and
  share sheet, which is what the hint under it has always promised.

### When an update fails, it now says why
- **The failure names the step it died in** — checking, downloading, unpacking,
  installing — and carries what the server could and could not do at that
  moment: whether it can write where it installs, whether `tar` is there, how
  much room is left, which Node it is on. **Copy details** on the banner puts
  the lot on the clipboard. An update that fails does so for a reason outside
  the code far more often than inside it, and every one of those is a different
  fix.
- **A rate limit says it is one.** GitHub allows sixty unauthenticated requests
  an hour per address, shared by every phone in the house — the likeliest
  reason an update refuses to install, and "GitHub answered 403" gives nobody
  anywhere to go. It now says so, and roughly when the count resets.
- **The automatic check asks GitHub at most once every six hours** rather than
  on every launch. An installed app opened a dozen times a day was spending
  that hourly allowance on a question whose answer changes a few times a week.
  Asking for a check yourself still asks straight away.

### Fixed
- The download counted bytes with a `data` listener alongside a `pipe`, which
  is two ways of reading one stream: anything arriving before the pipe was
  attached went to the counter and nowhere else — a truncated tarball that
  unpacks to nothing, with no error to show for it. It is one pipeline now,
  with the size limit as a stage in it.

## 0.4.2

### Favourites
- **A heart on the album screen**, where the share button used to be. Hollow
  until you tap it, red once you have. Tap it again to take it off.
- **A Favourites row at the top of the home screen**, most recently marked
  first — the one you just marked is the one you were thinking about. The row
  is absent rather than empty until there is something in it: a heading over
  the words "nothing here yet" is an instruction to go and use a feature, and
  every other row on that screen describes your library.
- The share card is still there, on Now playing. One corner, two jobs, and
  which one is showing follows the screen.

### Artists
- **Every artist named on an album is a link** to their own screen, which now
  has two parts: the records they made, and the ones they only turn up on — a
  compilation, a soundtrack, a guest verse. The second appears only when there
  is something in it.
- An album credited to several artists becomes several links. The split is on a
  semicolon or a spaced slash and nothing else: an ampersand and a comma both
  live inside real names, so splitting on those would turn Earth, Wind & Fire
  into three artists who have never recorded anything, and AC/DC into two.

### Now playing
- **Shuffle and repeat are gone**, on request. An album is listened to in the
  order it was sequenced, and the two controls that undo that were taking the
  outside positions in a row of three that does the actual work. Nothing sets a
  play mode any more, so one set in the Sonos app is left exactly as it is
  rather than being silently corrected by a screen with no control for it.

### The album screen
- Play and Queue are bigger, and the same size as each other. "Play" is a
  shorter word than "Queue", so padding alone had made the primary action the
  smaller button.

### Your library survives an update
- The favourite is the only thing in the database you typed rather than the
  files, so it is the only thing a rescan could destroy — and does not, for the
  same reason the date an album arrived is left alone.
- Both ways of updating leave the database where it is: it lives in a Docker
  volume the container's lifetime does not touch, and the in-app updater is not
  allowed to write there. Opening an older database adds what is missing and
  changes nothing else, which is now covered by a test that builds a database
  in the original 0.1.0 shape and checks every row, play and count comes
  through.

## 0.4.1

### Release dates
- **The share card says when the album came out**, in full where the files say
  so: *23rd September 2025*. A tag that only gives a year — or a month with no
  day, which would mean inventing one — says *Released 2025* instead.
- The date is read from the files on the next scan, and is the one every file
  that carries a date agrees on. A compilation whose tracks each carry their
  own original release date has no single date, and gets the year.
- **The next scan re-reads every file once.** That is how a new tag gets a
  value at all: a file whose size and modification time have not changed is
  otherwise never opened again. A large library will take a few minutes that
  one time.

### The share card
- The MusicD mark is a third smaller. It was signing the card at a size that
  competed with the album on it.
- The date line is larger than the year it replaced, and never larger than the
  artist line beneath it — a long artist name steps that line down, and the
  date now steps down with it.

### Now playing
- **The cover is shown whole.** It used to fill the screen and crop, which took
  the sides off every square sleeve on a tall phone — and a sleeve is a designed
  object, so the half that got cut was usually the half with the artist's name
  on it. The whole cover is now fitted to the space, at its own proportions,
  whatever shape it is.

### The album screen
- **The top bar reaches the top of the screen, and the artwork no longer shows
  above it.** A sticky element cannot rise above its containing block, so while
  the panel reserved the phone's safe area the bar stuck *below* it — leaving a
  band at the very top with nothing in front of it, through which the cover
  scrolled past in full view.
- That bar is translucent now, like the app's own top bar and the transport
  pill: over an unscrolled screen it is indistinguishable from the ground, and
  once the screen moves the cover passing underneath tints it rather than
  disappearing under a hard edge.

## 0.4.0

### The app installs its own updates
- **The update banner has an Update now button.** It used to notice a new
  release and then tell you to go and run Docker commands, which is a notice
  rather than an update. Pressing it downloads that release, writes it over the
  running install, reinstalls dependencies if they changed, and restarts. The
  page comes back on the new version and says which one.
- **Check for updates** in the side menu offers the same button when it finds
  something.
- Only one update ever runs. A second phone opened part-way through — or a
  reload — joins the one in progress and watches it finish, rather than
  offering to start another.
- Your library and play history are never touched. Neither is `node_modules`,
  which is built for this machine and is replaced only when the dependencies
  actually changed — that step is minutes on a Pi, where `better-sqlite3`
  compiles from source, and it is the step most likely to fail.
- Nothing is written over the running install until the download has been
  unpacked and checked to be a real MusicD Server build of the version it
  claimed to be. A failure before that point leaves the running version exactly
  as it was, and says what went wrong with a Try again.

**What this does not do is pull a new image.** There is no Docker socket in the
container and there should not be — a music server that can start containers is
a far larger thing than one that can keep itself current. It rewrites the files
of the running container instead, which survives `docker restart` because a
container's writable layer does, and the next `docker run --pull always` lands
on the same release from the image. The two ways of updating agree rather than
fighting. `--restart unless-stopped`, already in the documented run command, is
what starts the server again afterwards.

The passive check still runs in the browser, so nothing here reaches the
internet while the server is simply sitting there. The repository it updates
from is fixed in code and never read from a request, and every address it opens
— including each redirect — has to be one of GitHub's own hosts over TLS.

## 0.3.4

### The volume bar floats, and each bar has its own
- **Opening the volume on Now playing no longer pushes the screen upward.** The
  slider sat in the flow of a screen that never scrolls, so making room for it
  shrank the artwork and shifted everything above it. It floats over the screen
  now, the way MusicD Remote's does, and opening it moves nothing.
- **− and + buttons**, either side of the slider. The slider gets you roughly
  there; the buttons are for the last step or two, and each one is a single
  point of volume.
- **The mini bar's speaker opens the mini bar's own volume.** It used to take
  you to Now playing and open that screen's slider — leaving the screen you were
  on in order to change the volume on it. Both bars now carry the same control,
  and each one opens beside the bar it belongs to, clear of the buttons around
  it.
- The sheet reads [speaker and value] [slider, with the ends of the scale under
  it] [− +], which is the shape MusicD Remote uses. The number is large enough
  to read at arm's length, and the slider has a thumb big enough to catch.
- A tap anywhere else puts it away, as does Escape, moving between screens, and
  a second tap on the speaker — which stays lit while its sheet is open.

### Fixed
- **The volume no longer creeps back after you set it.** A tap of + painted the
  new number and sent it, and then every poll in the second or two before the
  speaker agreed wrote the old one straight back — the thumb sliding away from
  the button just pressed. The value you asked for is now held until the speaker
  echoes it, and the hold lapses on its own so a change made in the Sonos app
  still reaches the slider.

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
