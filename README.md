<div align="center">

<img width="800" alt="MusicD" src="docs/IMG_8974.jpeg" />

</div>

# MusicD Server — v0.3.6

**Your own music files, played to Sonos, with MusicD Remote's interface.**

No Roon, no Plex, no streaming accounts. A small server on a machine you own
scans your music folder, and every Sonos room in the house plays from it —
controlled from a browser, an iPhone home-screen app, or the native Android app.

```
 browser / iPhone PWA / Android app ──HTTP──▶  MusicD Server  ──Sonos UPnP──▶  Sonos rooms
                                                   │                               │
                                                   └──── audio: /stream/… ◀────────┘
```

---

## What you get

Everything MusicD Remote does that makes sense for a library of files:

* **Home** — Not played in 6 months, Album of the day, Smart Picks, Random albums,
  your Library, Browse by genre. Reorder or switch rows off in Settings
* **The whole library** — sort by title, artist, year, date added, plays, last played or a
  stable shuffle; focus by genre, decade, format, sample rate, bit depth, starts-with
  and date added (tap again to exclude)
* **Instant search** across albums and artists — typo-tolerant, out of order
* **Album pages** — tracks, year, write-ups from Wikipedia and Qobuz's editorial
  pages, the Pitchfork score and Best New Music badge with a link to the review
* **Edit album** (album page → ⋯ → Edit album) — correct the title, artist or release year,
  and find a cover for an album without one. The cover search (Apple Music, Deezer,
  MusicBrainz) matches on title, artist and track names: a sure match is picked for you,
  otherwise you choose from suggestions or paste an image address. Your music folders
  stay read-only; edits live in the database and survive rescans
* **Now playing** with the **waveform** seek bar, drawn from the audio itself
* **Share card** — the card image, where to hear it (Qobuz, TIDAL, Spotify, Apple Music,
  Amazon, Deezer, Bandcamp), where to read about it, and "if you like this"
* **Wall display** at `http://<server>:3500/display` for a TV or tablet
* **Random Album Radio** — when a room's queue runs out, another album you haven't heard lately
* **Smart Picks** — five records from your own library each day, by acts next to the ones you play
* **Discover** — new records by the artists you actually listen to (off by default)
* **Playlists** you make, **Dynamic Playlists** (saved Library views), and playlist sharing
  in MusicD Remote's own format
* **Sonos rooms and groups** — play, queue, play next, shuffle, repeat, volume per speaker,
  group and ungroup rooms, move what's playing to another room

## Formats — the 24/48 rule

Sonos S2 plays up to **24-bit / 48 kHz**. MusicD Server sends each track the best way the
speaker can take it:

| Your file | What the speaker gets |
| --- | --- |
| FLAC, ALAC, MP3, AAC, Ogg, 16-bit WAV/AIFF — at or below 24/48 | **The file itself, byte for byte** — bit-perfect |
| Anything **above 24/48** (88.2, 96, 176.4, 192 kHz, 32-bit…) | **FLAC 24-bit / 48 kHz** — resampled, still lossless |
| DSD (DSF/DFF) | FLAC 24/48 |
| Formats Sonos can't read (APE, WavPack, WMA Lossless, Opus, 24-bit WAV…) | FLAC at the file's own rate and depth (within 24/48) |
| More than two channels | Folded down to stereo |

Resampling uses ffmpeg with the **SoX resampler** at high precision, with triangular dither.
A converted track is written to a cache as it plays — the speaker starts as soon as the first
frames exist — and the next tracks in the queue are prepared ahead, so by the time Sonos asks
for them they are usually finished. Replays come straight from the cache (4 GB by default,
least-recently-played removed first).

## Install (Docker)

Run it on an always-on Linux machine on the same network as your speakers — a NAS, a
Raspberry Pi 4/5 (64-bit OS), a home server.

If Docker isn't installed yet:

```bash
dietpi-software install 162              # DietPi (162 is its Docker package)
curl -fsSL https://get.docker.com | sh   # Debian, Ubuntu, Raspberry Pi OS
```

Then:

```bash
docker stop musicd-server 2>/dev/null; docker rm musicd-server 2>/dev/null
docker pull ghcr.io/meltface-80/musicd-server:latest

docker run -d \
  --name musicd-server \
  --network host \
  --restart unless-stopped \
  -e TZ=Europe/London \
  -v musicd-server-data:/app/data \
  -v /your/path/to/Music:/music:ro \
  ghcr.io/meltface-80/musicd-server:latest
```

Open **`http://<server-ip>:3500`**. The first scan runs straight away; a big library takes a
few minutes and albums appear as it goes.

> **`--network host` is required.** Sonos players are found by multicast, which does not
> cross Docker's default bridge network — and the speakers fetch audio from this machine's
> own address. Docker Desktop on macOS/Windows has no real host networking, so this needs a
> Linux host.

> **Keep the `musicd-server-data` volume.** It holds the library database, play history,
> playlists, settings and the artwork and transcode caches. Point every future `docker run`
> at the same name.

**More than one music folder?** Mount each under `/music`:
`-v /mnt/nas/Albums:/music/Albums:ro -v /mnt/usb/Vinyl:/music/Vinyl:ro`.

A `docker-compose.yml` is in the repository: set your music path and `docker compose up -d`.

### Build it yourself instead

```bash
git clone https://github.com/meltface-80/MusicD-Server.git
cd MusicD-Server
docker build -t musicd-server:local .
# then the docker run above, with musicd-server:local as the image
```

### Updating

**In the app:** Settings → **Check for updates** → **Update to vX.Y.Z**. The server
downloads the new release from GitHub, swaps it in and restarts itself in a few seconds;
the page reloads on its own. It also checks twice a day and shows a banner when a new
version is out. (From v0.1.3 on — an older container needs one update the manual way.)

**Manually** — also the way to pick up changes to the image itself (ffmpeg, Node):

```bash
docker pull ghcr.io/meltface-80/musicd-server:latest
docker stop musicd-server && docker rm musicd-server
# re-run the docker run command above — the data volume carries everything over
```

## Configuration

Everything is optional; pass any of it with `-e NAME=value`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3500` | The web interface, the API, and where speakers fetch audio. |
| `TZ` | UTC | Your time zone — Album of the day and Smart Picks change over at local midnight. |
| `SONOS_HOSTS` | — | A speaker's IP (comma-separated for several), for when multicast discovery is unreliable. One is enough. |
| `SERVER_IP` | auto | The address speakers should fetch audio from, for hosts with several network interfaces. |
| `INCLUDE_ZONES` | — | Offer only these rooms, e.g. `Kitchen,Study`. |
| `EXCLUDE_ZONES` | — | Offer every room except these. |
| `SCAN_INTERVAL_HOURS` | `6` | How often the music folder is re-checked (only changed files are re-read). Rescan any time from the menu. |
| `TRANSCODE_CACHE_GB` | `4` | Disk kept for converted hi-res tracks. |
| `TRANSCODE_CONCURRENCY` | `2` | How many tracks are converted at once. |
| `MUSIC_DIR` | `/music` | Where the library is mounted inside the container. |
| `TAILSCALE_ADDRESS` | auto | The server's address away from home, if the one found on the host's `tailscale0` isn't the one to use — an IP, a MagicDNS name, or a full `https://` address. See [Away from home](#away-from-home-tailscale). |
| `DEBUG` | — | Log every API call. |

Settings for the FanArt.tv key (wall-display artist photos), waveform, share-card services, Smart Picks, Discover,
the wall display and the Home rows are in the app's Settings and are saved in the data volume.

## Your account

MusicD Server has **one account**, kept on the server itself — nothing online. Until it
exists the server does nothing but ask for it:

1. Open `http://<server-ip>:3500` on a device **on your home network** (a browser, the iPhone
   home-screen app, or the Android app) and choose a username and password.
2. Every other device signs in with them once and is remembered.
3. **Settings → Account** lists every signed-in device, with a *Sign out* button for each, and
   changes the password.

The password never crosses the network, even on plain http: devices prove they know it with
SRP (the scheme Apple uses for HomeKit pairing), and the server proves it knows the account
back. The server stores only an SRP verifier, never the password.

**Forgot the password?** On the server run

```bash
docker exec musicd-server node reset-password.js
```

It removes the account and signs every device out; your library, edits, playlists and history
stay. Then create the account again from a device at home.

Sonos speakers can't sign in: the addresses they're given carry a signature, and the speakers'
own addresses are let through, so playback is unaffected.

## iPhone and iPad

Open `http://<server-ip>:3500` in Safari, tap **Share → Add to Home Screen**. It opens full
screen like an app — the same PWA arrangement as MusicD Remote.

## Android

A native app: **[android/](android/)**. Enter the port (3500 unless you changed it) and it
finds the server on your Wi-Fi by itself — or type the address — then signs in (or creates the
account on a new server) right in the app, no other device needed. It shows the server's own
interface, and adds what a web page can't:

* **Lock screen and notification controls**, which headset and Bluetooth buttons also reach
* The phone's **volume keys** move the room's volume
* A **home-screen widget** — now playing, transport, and a tap on the cover for a random album
* A **Quick Settings tile** — a random album without opening anything
* A proper **share sheet** for the share card
* **This phone** — the phone itself is one of the rooms. Pick *This phone* in the room picker
  and albums play through its speaker or headphones, with the queue, now playing, history and
  Random Album Radio working as for any Sonos room, and *move what's playing* works between the
  phone and any Sonos room. It's the Android app's own: only that phone sees it (the iPhone
  home-screen app and browsers don't). It's there while the app is open or playing.
* **Downloads** — on an album's page, *⋯ → Download to this phone*, as **Original** (the files
  as they are; formats a phone can't play become lossless FLAC) or **Opus 256** (about a tenth
  of the size). Saved to phone storage or an SD card, Wi-Fi only by default, with an optional
  size limit — all under *Settings → Downloads on this phone*. Downloaded albums play with no
  server at all (the same screen, or *Play downloads* when the server can't be reached), a
  downloaded track is used instead of streaming it, and plays made offline join your history
  when the phone is back. Downloads live in the app's own storage, so uninstalling the app
  removes them (updates don't). A **Downloaded albums** row heads the Home screen once something is
  downloaded (and stays while anything is).

* **Away from home** — off your Wi-Fi the app carries on over Tailscale, as a player for the
  phone only. See below.
* **Automatic downloads** — today's Smart Picks, the Album of the day and the newest albums kept
  on the phone by themselves (Downloads screen), and removed again when they drop off the list.
* **Android Auto** — Downloaded albums, Smart Picks and Random albums in the car. Android Auto
  lists a sideloaded app only with *Unknown sources* on in its developer settings (tap the
  version number in Android Auto's settings ten times to reach them).
* **Updates itself** — the app offers each new version when it opens (or *Settings → System →
  Check for app update*) and installs it over the top; Android asks once to allow it.

**Download: [dist/](dist/)** — the newest APK is committed there by GitHub Actions on every
push to `main`. Sideload it on Android 8.0 or newer.

**Updates install over the top** from v0.2.1 on: every build is signed with the same key
(`android/app/musicd-debug.keystore`). Builds before v0.2.1 were each signed with a different
key, so going from one of those to v0.2.1 needs **one** uninstall first — after that, never again.

That key is a debug key committed to this public repository, so it only keeps your own updates
working. For a key nobody else holds, add the `MUSICD_KEYSTORE_BASE64` and
`MUSICD_KEYSTORE_PASSWORD` secrets (the same ones as Android Random Remote); switching to it
also needs one uninstall.

## Away from home (Tailscale)

Leave the house and the Android app keeps working over mobile data, like Roon ARC: the phone is
the only thing it plays to. No ports are opened on your router — the phone reaches the server
over [Tailscale](https://tailscale.com), a private network between your own devices.

**Away, only the phone plays.** Whatever reaches the server from outside your home network —
Tailscale included — is offered one room: the phone asking, as *This phone*. The Sonos rooms
aren't listed, and nothing away can play to them, pause, group or mute them, or reach another
phone. The server decides this by where each request comes from, so it holds for any device:
an iPhone or a laptop on Tailscale can browse the library but has nothing to play to. At home
everything is as before. Away, tracks stream as **Opus 256 kbps** (a tenth of the data); albums
you've downloaded play from the phone.

**Set up once:**

1. Install Tailscale on the machine running the server (on DietPi: `dietpi-software` → Tailscale,
   or `curl -fsSL https://tailscale.com/install.sh | sh`), then `sudo tailscale up` and sign in.
   The container shares the host's network, so the server finds its Tailscale address itself.
2. Install the Tailscale app on the phone and sign in to the same account.
3. Open MusicD once at home: the app learns the server's Tailscale address. (Or type it on the
   connect screen under *Away from home*.)

From then on the app follows the phone's network: on your Wi-Fi it uses the server's home
address; on mobile data (or anyone else's Wi-Fi) it asks the Tailscale app to connect and
switches to the Tailscale address, and a track cut off by the switch carries on from where it
stopped. Back home it switches back, and turns Tailscale off again if it was the one that turned
it on. If Tailscale doesn't connect by itself, set it as the phone's *Always-on VPN* (Android
Settings → Network → VPN) — the app works the same with it on at home.

Don't advertise your home subnet from the server's Tailscale (`--advertise-routes`): requests
through a subnet router arrive from a home address, and the server can't tell they're away.

## How it works

* **Library.** The music folder is walked and every audio file's tags are read with
  music-metadata into SQLite. Albums are decided a folder at a time, so a folder of tracks by
  different artists with no album-artist tag becomes one compilation, and `CD1`/`CD2` folders
  become one album. Covers come from `cover.jpg`/`folder.jpg`/… or the first track's embedded
  picture, resized once per size and cached. Rescans only re-read files whose size or date changed.
* **Sonos.** Ported from [Caldera Sonos Bridge](https://github.com/meltface-80/Caldera-Sonos-Bridge)
  and the [UPnP to Sonos bridge](https://github.com/meltface-80/UPnP-to-Sonos-UPnP-bridge): one
  speaker is found over SSDP and the whole household is read from `ZoneGroupTopology`. A Sonos
  *group* is a zone (its coordinator owns the queue) and each *room* is an output (volume and
  mute are per room). Tracks go into the coordinator's own **Sonos queue**, with the DIDL-Lite
  metadata Sonos insists on, so playback is gapless and the speaker moves between tracks by
  itself. The queue you see is read back from the speaker, so anything added from the Sonos
  app appears too.
* **Audio.** Each queued item is a URL on this server. Within 24/48 it serves the file as
  stored, with byte ranges; above that, ffmpeg writes FLAC 24/48 to the cache and the speaker
  is served from the growing file.
* **Interface.** MusicD Remote's own `public/` page, with the Roon-specific parts adapted,
  talking to the same `/api` it always has — implemented here over the library and the
  speakers instead of a Roon Core.

## Troubleshooting

* **No rooms.** `http://<server>:3500/api/status` shows what discovery found (`sonos.rooms`,
  `sonos.error`). Check host networking, or set `SONOS_HOSTS` to one speaker's IP.
* **A room plays nothing / skips every track.** The speakers must be able to reach the server
  on its port. On a host with several interfaces set `SERVER_IP` to the LAN address.
* **No albums.** `/api/status` shows `music_dir` and `index_count`. Check the `/music` mount
  and that the container can read it.
* **Hi-res tracks don't play.** `http://<server>:3500/api/health` must say `"ffmpeg": true`.

## Not in this version

* Qobuz and TIDAL accounts — this plays your own files (Qobuz's public pages are still used
  for album write-ups and the share card's "open in Qobuz" link, with no login)
* Record labels — no label pages, Label of the week, label focus or label search
* The Android dial and voice commands from Android Random Remote

## Development

```bash
npm install
npm test            # unit tests + an end-to-end run against a fake Sonos household
MUSIC_DIR=~/Music PORT=3500 node index.js
```

The end-to-end test starts two fake Sonos rooms on 127.0.0.11/12:1400, plays a CD-quality
album and a 24/96 album through the real server, and checks what the "speaker" fetched:
bit-perfect FLAC for the first, FLAC 24/48 for the second. It needs ffmpeg on the PATH
(or `FFMPEG_PATH`).

## License

MIT. The interface is MusicD Remote's; the Sonos control is ported from Caldera Sonos Bridge
and the UPnP to Sonos bridge — all by the same author.
