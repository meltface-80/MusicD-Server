<div align="center">

<img width="800" alt="MusicD" src="IMG_8974.jpeg" />

</div>

# MusicD Server

Basic music server - under development

A simple music server for Sonos. It reads your music folders, shows your albums
as they are, and plays them to your speakers.

There is no metadata service, no album identification, no release matching and
no streaming accounts. An album is a folder, its title is what the tags say, and
its cover is the image sitting next to the files. What it does keep is a small
database of your listening — when an album arrived, when you last played it, and
how often — because that is what the home screen is built out of.

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

```bash
docker rm -f musicd-server
```

then run the same `docker run` command again — `--pull always` fetches the new
image. Your library and play history live in the `musicd-server-data` volume and
are untouched.

With compose it is `docker compose pull && docker compose up -d`.

**Check it worked.** Open the side menu: the bottom entry shows the version, the
commit it was built from and the date. Tap it to copy the line. The app also
checks GitHub for a newer release when it loads and says so if there is one.

### Versions

`main` publishes on every push, so several tags point at the same build:

| Tag | What it follows |
| --- | --- |
| `:latest` | the newest build of `main` |
| `:0.2.0` | that exact version, for pinning |
| `:0.2` | the newest patch of that minor version |
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

Six rows, each one a carousel that opens into a full grid when you tap its title.

| Row | What is in it |
| --- | --- |
| **Library** | Every album, by artist and then by year — the shelf order. |
| **Random albums** | A fresh handful every time the screen loads. |
| **Recently added** | Newest first, by the date the scan first saw the folder. |
| **Recently played** | Most recently played first. |
| **Not played in 6 months** | Albums you played longer than six months ago, and albums that have sat in the library that long unplayed. Longest gap first. |
| **Smart Picks** | Below. |

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

A play is recorded when a track has actually been played — half way through, or
four minutes in, whichever comes first. Skipping past a track does not count it,
and an album played end to end is one album play, not one per track. The counting
is done by watching the speaker, not by watching the Play button, so an album
queued and then skipped never shows up in "recently played".

Nothing is ever deleted. A rescan that cannot see your NAS marks the albums
absent rather than removing them; remount it, rescan, and they come back with
their history intact.

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

## Your files

An album is a folder that contains audio files. A folder holding only other
folders is not an album, and a folder of scans with no audio in it never appears.

- **Title** comes from the album tag. If the folder's tracks disagree, or there
  is no tag at all, the folder's own name is used, with a leading `01 - ` index
  stripped.
- **Artist** comes from the album-artist tag if the folder agrees about it, then
  the track artist if *that* agrees. A folder whose tracks name different artists
  is shown as Various Artists.
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
