<div align="center">

<img width="800" alt="MusicD" src="IMG_8974.jpeg" />

</div>

# MusicD Server

https://meltface-80.github.io/MusicD-Server/

Basic music server - under development

A simple music server for Sonos. It reads your music folders, shows your albums
as they are, and plays them to your speakers.

There is no metadata service, no album identification, no release matching and
no streaming accounts. An album is a folder, its title is what the tags say, and
its cover is the image sitting next to the files. What it does keep is a small
database of your listening — when an album arrived, when you last played it, and
how often — because that is what the home screen is built out of.

Two things do leave your network, and only these two. An album with **no cover
at all** gets one found for it (MusicBrainz and the Cover Art Archive, no key,
covers only — see [Covers for albums that have none](#covers-for-albums-that-have-none)),
and **scrobbles go to Last.fm** if you connect an account (see
[Scrobbling to Last.fm](#scrobbling-to-lastfm)). Neither can change anything
about your library, and either can be switched off — the first with
`COVER_LOOKUP=false`, the second by simply not supplying a key.

The UI follows [MusicD Remote](https://github.com/meltface-80/MusicD-Remote), and
the Sonos side follows the
[UPnP to Sonos UPnP bridge](https://github.com/meltface-80/UPnP-to-Sonos-UPnP-bridge).

---

## Install

**📖 Install guide & command builder:
[meltface-80.github.io/MusicD-Server](https://meltface-80.github.io/MusicD-Server/)** —
fill in your music folder and time zone and it writes the command for you.

Run it on an always-on Linux machine on the same network as your speakers — a
NAS, a Raspberry Pi, a home server.

```bash
docker run -d \
  --name musicd-server \
  --pull always \
  --network host \
  --restart unless-stopped \
  -e TZ=Europe/London \
  -v /path/to/your/music:/music:ro \
  -v musicd-server-data:/app/data \
  -v /etc/localtime:/etc/localtime:ro \
  ghcr.io/meltface-80/musicd-server:latest
```

> **`--pull always` is what makes this the update command too.** Without it
> `docker run` uses whatever copy of `:latest` is already on the machine and
> never asks the registry — so stopping the container, removing it and running
> the same line again gives you back the build you already had. It looks
> exactly like an update that shipped nothing.

That is the whole installation. Open `http://<host-ip>:3400/` — the first scan
starts on its own, and the home screen fills as it goes.

Or with compose — copy `docker-compose.yml`, set your music path and time zone,
and `docker compose up -d`.

### Optional extras

Two settings are worth knowing about at install time. Add them as extra `-e`
flags on the `docker run` above, or under `environment:` in compose. Neither is
required and the full list is in [Configuration](#configuration).

**Scrobbling to Last.fm** is absent from the app until you supply a key —
Last.fm has no anonymous mode, so there is no way around it. It is a free
developer key you make once at
[last.fm/api/account/create](https://www.last.fm/api/account/create), not
something anyone types into the app:

```bash
  -e LASTFM_API_KEY=your-key \
  -e LASTFM_API_SECRET=your-secret \
```

Both are needed or neither works. The account itself is connected from the
app's side menu afterwards — see [Scrobbling to Last.fm](#scrobbling-to-lastfm).

**Looking online for covers** is on by default, for albums that have none. This
switches it off for good and removes its row from the side menu:

```bash
  -e COVER_LOOKUP=false \
```

The [install site](https://meltface-80.github.io/MusicD-Server/) has a box for
each of these and writes the finished command for you.

Images are published for `amd64`, `arm64` and `arm/v7`, so the same command
works on an x86 NAS, a 64-bit Raspberry Pi and a 32-bit one alike. Every push to
`main` rebuilds them; `:latest` follows `main`, and version tags get their own.

<details>
<summary>Building it yourself instead</summary>

No registry, no published image — Docker clones the repository and builds it on
the spot:

```bash
docker build -t musicd-server https://github.com/meltface-80/MusicD-Server.git
```

Then use `musicd-server` in place of the `ghcr.io/...` reference above. It takes
a few minutes on a Pi, because `better-sqlite3` compiles from source where there
is no prebuild for the platform.

</details>

### Updating

**From the app.** When a new release exists the app says so, and the banner has
an **Update now** button. Pressing it downloads that release, writes it over the
running install, reinstalls dependencies if they changed, and restarts — which
is why `--restart unless-stopped` is in the run command above. The page comes
back on the new version and tells you which one. Your library and play history
are in the `musicd-server-data` volume and are never touched.

The side menu's **Check for updates** does the same from a standing start, and
either way there is only ever one update running: a second phone opened during
one joins it rather than starting another.

It rewrites the container's files rather than pulling a new image — nothing here
talks to Docker, and a music server that can start containers is a much larger
thing than one that can keep itself current. That survives `docker restart`,
because a container's writable layer does. The next `docker run --pull always`
lands on the same release from the image, so the two ways of updating agree
rather than fighting.

**From the command line**, if you would rather:

```bash
docker rm -f musicd-server
```

then run the same `docker run` command again — `--pull always` fetches the new
image. With compose it is `docker compose pull && docker compose up -d`.

**Check it worked.** Open the side menu: the bottom entry shows the version, the
commit it was built from and the date. Tap it to copy the line.

### Versions

`main` publishes on every push, so several tags point at the same build:

| Tag | What it follows |
| --- | --- |
| `:latest` | the newest build of `main` |
| `:0.4.35` | that exact version, for pinning |
| `:0.3` | the newest patch of that minor version |
| `:sha-abc1234` | one specific commit, for rolling back |

A GitHub release is tagged automatically when the version in `package.json`
changes on `main`, so the release notes and the images always agree.

> **`--network host` is required.** Finding Sonos players is multicast (SSDP),
> and multicast does not cross Docker's default bridge network. Host networking
> is also the simplest way for the speakers to fetch audio back from this
> server. Docker Desktop for macOS and Windows does not provide real host
> networking, so the container needs a Linux host.
>
> If you cannot use host networking, set `SONOS_HOSTS` to one player's IP
> address and publish port 3400 — one address is enough, because the rest of
> the household is read from that player's own topology.

> **Set `TZ`.** This is the one container setting that changes what you see.
> "Not played in 6 months" is a calendar boundary and Smart Picks are rebuilt
> once a local day; left on UTC, both drift by up to a day. Bind-mounting
> `/etc/localtime:/etc/localtime:ro` does the same job.

## The home screen

Six rows, each one a carousel that opens into a full grid when you tap its title
— seven once you have marked a favourite.

| Row | What is in it |
| --- | --- |
| **Favourites** | Albums you marked with the heart, most recently marked first. Absent, not empty, until there is one. |
| **Library** | Every album, by artist and then by year — the shelf order. |
| **Random albums** | A fresh handful every time the screen loads. |
| **Recently added** | Newest first, by the date the scan first saw the folder. |
| **Recently played** | Most recently played first. |
| **Not played in 6 months** | Albums you played longer than six months ago, and albums that have sat in the library that long unplayed. Longest gap first. |
| **Smart Picks** | Below. |

**The rows are in the order you put them in.** Open the side menu: every row
is listed there with a pad on the right. Hold the pad, drag the row where you
want it, let go. The home screen follows, and so does every other phone in the
house — the arrangement is kept in the library's own database rather than in
one browser, so it survives a reinstalled shortcut and an update alike.

**Not played in 6 months is empty to begin with, and that is correct.** Nothing
in a library scanned last week can have gone six months unplayed. The row fills
itself as time passes, which is also why the container's time zone matters.

## Smart Picks

Local files only, and driven entirely by what you have actually played.

What you played in the last 90 days becomes a taste profile — artists, genres
and decades, each weighted so last week counts for more than March. Every album
you have *not* played in the last 60 days is scored against it, and the best
dozen are the picks, never two by the same artist.

Every pick says why it is there: *More from Talk Talk*, *Art Rock, like Talk
Talk — never played*, *From the 1970s, like you have been playing*. An album with
no connection to the profile is never offered, however long it has sat unplayed
— being unheard is a bonus, not a reason. That is the difference between this row
and the random one.

Play nothing and the row says so rather than sitting there empty.

## What the database keeps

| | Albums | Tracks |
| --- | --- | --- |
| Date added to the library | yes | yes |
| Date last played | yes | yes |
| Number of plays | yes | yes |
| Marked a favourite | yes | — |
| A corrected title or artist | yes | — |

## Arranging the home screen

**Settings › Home screen** lists the seven carousels. Hold the pad beside one to
move it; the switch takes it off the home screen — and out of the side menu,
since a carousel you have turned off is not a place worth offering. Smart Picks
stops being worked out as well.

Everything is on for a new install, and an update never changes what you have
already arranged.

The side menu itself is a **fixed** order and no longer the place the home
screen is arranged: Home, Library, Artists, then whichever of Favourites,
Recently added, Smart Picks, Random albums, Not played in 6 months and Recently
played are switched on, then Settings. Library and Artists are always there —
Artists has no carousel, and Library is the way into the whole collection.

## Sorting the library

The Library screen carries a sort control: album name, artist, release year,
recently added, most played, last played, or random. Each opens in the
direction that suits it — alphabetical A → Z, everything else newest or biggest
first — and a second control flips it.

**The order is stored in the database, not on the phone**, so it survives a
restart, a reboot, an update, a cleared browser cache and a re-added
home-screen shortcut, and every phone in the house agrees about it. The Library
row on the home screen follows the same order.

Albums with no year, and albums never played, are treated as *unknown* rather
than as zero: they stay at the end of the wall whichever way the arrow points.
Random is seeded so the wall stays consistent as it pages; the control becomes
**Shuffle**.

## When a cover cannot be found

Most missing covers are found by the background sweep. The ones that are not
are usually albums whose files do not say who made them — there is no search
that would not match half a catalogue, so the sweep does not guess.

Open the album, tap **…** on the artwork, then **Edit**. Correct the artist if
it is wrong or missing, then press **Find cover**: it searches with what is in
the fields, shows what each source offers, and stores the one you tap. If
nothing comes back, the dialog says what the last automatic search made of it.

Covers are looked for in this order, and the first that answers wins:

| | Source | |
| --- | --- | --- |
| 1 | The MusicBrainz release id **in your own files** | exact — no guessing, and no request to MusicBrainz at all |
| 2 | MusicBrainz by album name, then by track names | matched on the artist as well, so a shared title is not a match |
| 3 | The iTunes Search API | no key, no account; asked last because it answers a looser question |

Nothing is ever written next to your music, and nothing but a picture is
stored: no title, no artist, no year.

### Seeing what is still missing

**Settings › Find missing covers** — tap the name and you get a screen of the
albums that still have none, each saying what the last look made of it.
Tapping one opens its album, where **Find cover** is; closing it puts you back
on the same screen, with the album you have just fixed gone from it. **Look
now** at the top of that screen runs the sweep by hand.

The switch beside the row's name is whether the sweep runs by itself: it does,
after every scan, and scans run every six hours.

### Which of your albums carry a MusicBrainz id

The first source above only works for files that have one. To see which do:

```bash
docker exec -it musicd-server node tools/mbids.js        # albums with no cover
docker exec -it musicd-server node tools/mbids.js --all  # the whole library
```

It reads the tags directly and changes nothing. An album listed `id` is fetched
exactly; one listed `--` has to be searched for. If most of your library shows
`--`, [MusicBrainz Picard](https://picard.musicbrainz.org/) is what writes these
ids, and re-tagging with it makes covers exact rather than guessed at.

## Choosing several albums

**Hold** an album to start choosing and **tap** the rest to add them; tapping a
chosen album again takes it back off. A bar takes the mini transport's place
with **Play Now**, **Queue** and **Cancel**.

The selection follows you between screens: hold an album in one carousel, go
back to Home, open another row and carry on adding to the same set. An album
already chosen shows its tick everywhere it appears. It works on the home
carousels, the full walls, the search results and an artist's albums.

Play Now replaces the room's queue with everything chosen, in the order you
chose it; Queue adds it all to the end of what is playing.

## The shape of the track

The Now playing seek bar draws the waveform of whatever is playing: where the
quiet intro ends, where the loud middle is, and how much of it you have heard.
It is **decoration under the bar, never a replacement for it** — the drag, the
thumb and the keyboard are the same control they always were, and a track that
cannot be analysed simply keeps the plain bar.

It is worked out from **your own files** and nothing leaves the network to do
it: the audio is decoded once with ffmpeg, reduced to a thousand numbers, and
stored in the database for good. The next track on the record is analysed while
the current one plays, so listening straight through a record costs one decode
up front and nothing after that.

A waveform is re-analysed if you replace the file — the size and modification
time are stored with it, so a re-rip at the same path is noticed rather than
drawn with the old audio. `WAVEFORM=false` removes the feature and the bar goes
back to what it was.

**ffmpeg** ships with the app (the `ffmpeg-static` package, ~80 MB), and a
system ffmpeg on `PATH` is used instead if that is not available. It is invoked
as a separate program, which is the ordinary way to use it; ffmpeg is licensed
separately from this app.

## Random Album Radio

**Settings › Random Album Radio** keeps the queue from running out: another
album is added behind whatever is playing before you reach the last one.
**Match the current genre** appears underneath it while it is on — with that on
the next album shares the genre tag of the one playing, and with it off the
choice is the whole library.

It runs on the server, so the queue keeps filling while the phone that started
the music is in a pocket or off the network entirely, and both settings live in
the database so every phone in the house agrees. Nothing already in the queue is
offered again; with nothing left to add it adds nothing rather than repeating
itself. Off unless you turn it on.

**Settings › Now playing button** chooses what the control in the corner of the
Now playing screen does: **Home** returns to the home screen, **Back** returns
to the screen you came from. Home is the default. Like the theme, it is
remembered on the device rather than in the library.

A favourite and a corrected name are the two things in the library you typed
rather than the files, so they are the two a rescan could destroy — and does
not: nothing in the scan's upserts mentions their columns, the same way the date
an album arrived is left alone. They survive an update too, by both routes. The
database lives in `DATA_DIR`, which is a Docker volume the container's own
lifetime does not touch and which the in-app updater is not allowed to write to;
and opening an older database adds what is missing and changes nothing else.

A play is recorded when a track has actually been played — half way through, or
four minutes in, whichever comes first. Skipping past a track does not count it,
and an album played end to end is one album play, not one per track. The counting
is done by watching the speaker, not by watching the Play button, so an album
queued and then skipped never shows up in "recently played".

Nothing is ever deleted. A rescan that cannot see your NAS marks the albums
absent rather than removing them; remount it, rescan, and they come back with
their history intact.

## What a record is, and who made it

Open an album and, under the track list, it says what the record is — the
opening of its Wikipedia article, and its critical reception where the article
has one. Open an artist and their biography sits above their albums.

**It is fetched when you open the screen and never in the background.** Nothing
is looked up by the scan, so a library of four thousand albums costs no requests
at all until you look at something. Once fetched it is kept in the database for
good: an encyclopaedia article about a 1988 record is not going to become a
different article. Only a *miss* expires — after a week, so an album that gains
an article next year is not marked unknown for ever.

Wikipedia first. **Last.fm** answers for the records Wikipedia has never heard
of — bootlegs, small pressings, self-released work — and needs no new
credential: it uses the same developer key as scrobbling, and the calls it makes
change nothing.

**A wrong write-up is worse than none, so every candidate is checked before it
is believed.** Wikipedia ranks the disambiguation page for *Hex* above the Bark
Psychosis album, Earth made a record of the same name, and *Souvlaki* is a Greek
dish before it is a Slowdive album. An album with no confident match shows
nothing at all. If a match is wrong, correcting the album's name with **Edit**
throws the write-up away and asks again with the name you typed.

Both sources give their prose away on condition it is credited and linked, so
every write-up carries its source, the article's own title and its licence, and
they are visible without expanding anything. `INFO_LOOKUP=false` turns the whole
thing off for a container, whatever the app asks for.

Nothing found this way is written back into your library. Not a title, not an
artist, and not a grouping.

## Correcting a title or an artist

Some records arrive with no artist tag at all and show as **Unknown artist**.
The `…` button on the album's sleeve opens a menu with **Edit** on it, and the
name you type is the name the app uses from then on — in the home rows, the
shelf order, search, the artist list, Smart Picks, Now playing, the queue and
on the speaker's own display.

**Your music files are never written to.** The correction is kept in the
database beside the tags, which are left exactly as they are, so it works on a
read-only mount and a rescan cannot undo it. Clearing a field puts the tags
back; the field shows you what that would be.

This is not album identification. Nothing is looked up, nothing is fetched and
nothing is matched against anything — it records what you say the record is
called. Grouping two copies of one album into a version tab still goes on what
is on disk, so a rename cannot fold two albums together and take one of their
histories with it.

## Configuration

Everything is optional except your music path.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MUSIC_DIRS` | `/music` | Folders to scan. Separate several with commas. |
| `TZ` | `Etc/UTC` | The container's time zone. Set it — see above. |
| `PORT` | `3400` | Web interface, API and audio streaming. |
| `DATA_DIR` | `/app/data` | Database and cached artwork. |
| `SERVER_IP` | auto | The address given to speakers, for hosts with several interfaces. |
| `SONOS_HOSTS` | — | Player IPs, for when multicast discovery is unreliable. One is enough. |
| `INCLUDE_ZONES` | — | Show only these rooms, e.g. `Kitchen,Study`. |
| `EXCLUDE_ZONES` | — | Show everything except these rooms. |
| `SCAN_ON_START` | `true` | Scan when the container starts. |
| `SCAN_INTERVAL_HOURS` | `6` | Hours between automatic rescans. `0` turns them off. |
| `COVER_LOOKUP` | `true` | Look online for covers albums do not have. `false` switches it off for good. |
| `INFO_LOOKUP` | `true` | Set to `false` and no album write-up or artist biography is ever fetched. |
| `WAVEFORM` | `true` | Draw the track's shape in the seek bar. `false` leaves the plain bar and never runs ffmpeg. |
| `LASTFM_API_KEY` | — | A Last.fm API key. Without one the Last.fm row does not appear. |
| `LASTFM_API_SECRET` | — | The shared secret that came with it. Both are needed or neither works. |

## Covers for albums that have none

An album whose folder holds no picture and whose files carry no embedded one
gets a cover found for it, once, in the background after a scan. Nothing is
written next to your music — the image goes in `DATA_DIR` and the album row
points at it — and an album that already has a cover is never touched.

It uses two open services and **no API key or account**: [MusicBrainz] for
"which release is this", and the [Cover Art Archive] for the picture. Their
terms ask for a client that identifies itself and makes at most one request a
second, and this does both.

The match is the album title and the artist first. When that finds nothing, the
**track names**: two of them, searched as recordings by the same artist, and the
release they both point at is the record. A single track is on a dozen
compilations, so one agreement proves nothing and two is the whole of the
evidence.

A miss is remembered for a week, so a library full of bootlegs and field
recordings costs a handful of requests rather than hundreds every scan.

Turn it off for a container with `COVER_LOOKUP=false`; it then does not appear
in the app at all. Otherwise **Settings › Find missing covers** has both: the
name opens the albums that are still without one, and the switch beside it is
whether the sweep runs by itself.

[MusicBrainz]: https://musicbrainz.org/
[Cover Art Archive]: https://coverartarchive.org/

## Scrobbling to Last.fm

Every track this server counts as played is sent to Last.fm, if you connect an
account. It is the same event: a track counts once you are half way through it
or four minutes in, whichever comes first, which is Last.fm's own rule — so a
skipped track is never scrobbled and a play count and a scrobble can never
disagree.

**Last.fm needs an API key, and there is no way around it.** It has no OAuth 2
and no anonymous mode: every call carries an `api_key`, and every authenticated
one is signed with a shared secret. Using somebody else's is what their terms
exist to forbid. So this is the one thing in MusicD Server that needs a
registration, and it is a *developer* one you make once, not something anybody
types into the app:

1. Create a key at <https://www.last.fm/api/account/create>. It is free, it
   takes a minute, and "MusicD Server" with your own address is a complete
   answer to every field.
2. Put the two values in the container's environment:

   ```yaml
   environment:
     LASTFM_API_KEY: your-key
     LASTFM_API_SECRET: your-secret
   ```

3. Open the side menu and tap **Last.fm**. It opens Last.fm's own approval page
   — MusicD never sees your password — and once you have approved it, tap the
   row again to finish. Hold the row to disconnect.

Without both values the row does not appear at all.

Listens that cannot be sent are kept in the database and go out later, so a
router reboot, a restart or an update never loses one.

## Your files

An album is a folder that contains audio files. A folder holding only other
folders is not an album, and a folder of scans with no audio in it never appears.

**Multi-disc releases are one album.** A folder named for a disc — `Disc`, `Disk`
or `CD`, in any case, with or without a space before the number, and with a
separator or brackets around it if your ripper put one there, so `Disc 1`,
`disc1`, `CD 2`, `cd2`, `Disc-1`, `CD_2`, `(Disc 2)`, `[CD1]` and `CD 1 of 2` all
count — is folded into the album it belongs to. Discs inside the album folder
(`Physical Graffiti/CD1/`) fold into that folder; discs sitting side by side
(`Kid A (Disc 1)`, `Kid A (Disc 2)`) fold together on the name they share. The
folder's number decides the disc order, because a rip split in two very often has
every file tagged disc 1. Words that only begin the same way — `Discovery`,
`Discipline`, `Disco 2000`, `CD Baby` — are albums, and are left alone.

- **Title** comes from the album tag. If the folder's tracks disagree, or there
  is no tag at all, the folder's own name is used — with a leading `01 - ` index
  stripped, and a trailing year read as the year rather than left in the title,
  so `Deceiver (2021)` is *Deceiver*, from 2021.
- **Released** is the date tag when every file that carries one says the same
  thing, kept only as precisely as the tag gives it. A full date is said in full
  on the share card — *23rd September 2025* — and anything less says *Released
  2025*, because a month with no day would mean inventing one. A compilation
  whose tracks each carry their own original release date has no single date,
  and gets the year.
  Each artist named on an album is a link to their own screen: the records they
  made, and then the ones they only turn up on — a compilation, a soundtrack, a
  guest verse. A line naming several artists becomes several links, split on a
  semicolon or a spaced slash and nothing else: an ampersand and a comma both
  live inside real names, and splitting on them turns Earth, Wind & Fire into
  three artists who have never recorded anything.
- **Artist** is worked out down a ladder: the album-artist tag when the folder
  agrees about it, the one most tracks carry when a few disagree, then the track
  artist, then Various Artists when they genuinely differ — and finally the
  folder the album sits in, since `Artist/Album/` is how most libraries are laid
  out. A parent called `Unknown`, `Various Artists` or `Compilations` is read as
  saying there is no artist rather than naming one.
- **Cover** is `cover`, `folder`, `front`, `album`, `albumart` or `artwork`
  (`.jpg`, `.jpeg`, `.png`, `.webp`), then any other image in the folder, then
  artwork embedded in the files themselves, which is extracted once and cached.

Rescans are incremental: a file whose size and modification time have not changed
is never read again, so a rescan of an untouched library costs a directory walk.
Folders reached through symlinks are followed, which is how most libraries
assembled out of several mounts are put together.

The full grids page as you scroll, so a large library is not quietly cut off at
whatever a single request happened to return.

**Formats.** Sonos plays FLAC, ALAC, WAV, AIFF, MP3, AAC and Ogg Vorbis over
HTTP, up to 24-bit/48 kHz on current S2 hardware. It does not play DSD, WMA or
Opus. Files it cannot play are still listed — marked *No Sonos* on the album
page — rather than hidden, so a rip that will not play is not a mystery. They are
left out of the queue, and an album made entirely of them says so instead of
loading a queue that then sits silent.

## Development

```bash
npm install
MUSIC_DIRS=/path/to/music npm start
npm test
```

The test suite runs against a real library written to disk and a fake Sonos
player, so playback, queue building, the DIDL metadata Sonos insists on and the
play counter are all exercised against the actual protocol rather than a mock.

## Licence

MIT. See [LICENSE](LICENSE).

Built on MIT-licensed pieces throughout: [Express](https://github.com/expressjs/express),
[better-sqlite3](https://github.com/WiseLibs/better-sqlite3),
[music-metadata](https://github.com/Borewit/music-metadata) and
[compression](https://github.com/expressjs/compression). The Sonos control layer
is this project's own, modelled on the MIT-licensed
[UPnP to Sonos UPnP bridge](https://github.com/meltface-80/UPnP-to-Sonos-UPnP-bridge),
and the interface follows MIT-licensed
[MusicD Remote](https://github.com/meltface-80/MusicD-Remote).
