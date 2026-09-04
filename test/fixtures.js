/*
 * Test fixtures: a small music library on disk.
 *
 * Real files, not mocks. The scanner's job is to read what is actually there,
 * so a fixture that is a stub of the parser proves nothing about it — these
 * are genuine RIFF/WAVE files carrying genuine LIST/INFO tags.
 */

"use strict";

const fs = require("fs");
const path = require("path");

function riffChunk(id, payload) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 4, "ascii");
  head.writeUInt32LE(payload.length, 4);
  /* RIFF chunks are word aligned; an odd-length payload takes a pad byte that
     does not count toward the declared size. */
  return payload.length % 2
    ? Buffer.concat([head, payload, Buffer.from([0])])
    : Buffer.concat([head, payload]);
}

function infoField(id, value) {
  const text = Buffer.from(String(value) + "\0", "latin1");
  return riffChunk(id, text);
}

/* A valid WAV: 8-bit mono, 8000 Hz, `seconds` of silence, with a LIST/INFO
   block carrying the tags. Small enough that a whole fixture library is a few
   kilobytes, real enough that music-metadata parses it like any other file.

   `shape` makes it audible instead: a function of 0..1 through the track
   returning an amplitude of 0..1. Silence is still the default, because every
   other test in the suite wants a small file and does not care what is in it —
   but a waveform asserted over silence would pass with the drawing wrong, so
   the tests that look at the picture ask for a track that has one. */
function wav({ seconds = 2, title = "", artist = "", album = "", albumArtist = "",
               year = "", date = "", genre = "", track = "", shape = null } = {}) {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds, 128);      // 8-bit silence is 0x80
  if (typeof shape === "function") {
    /* A square wave at the requested amplitude: it is the loudest thing a
       given peak can be, so what comes back out of the peak detector is the
       envelope that went in and nothing about the tone gets in the way. */
    for (let i = 0; i < data.length; i++) {
      const a = Math.max(0, Math.min(1, shape(i / data.length)));
      const swing = Math.round(a * 127);
      data[i] = 128 + (i % 2 ? -swing : swing);
    }
  }

  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);            // PCM
  fmt.writeUInt16LE(1, 2);            // mono
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate, 8);         // byte rate
  fmt.writeUInt16LE(1, 12);           // block align
  fmt.writeUInt16LE(8, 14);           // bits per sample

  const info = [];
  if (title)       info.push(infoField("INAM", title));
  if (artist)      info.push(infoField("IART", artist));
  if (album)       info.push(infoField("IPRD", album));
  if (albumArtist) info.push(infoField("IAAR", albumArtist));
  /* ICRD is the creation date, which is where a full release date goes; a
     year on its own is the same field with less in it. */
  if (date || year) info.push(infoField("ICRD", String(date || year)));
  if (genre)       info.push(infoField("IGNR", genre));
  if (track)       info.push(infoField("ITRK", String(track)));

  const chunks = [riffChunk("fmt ", fmt)];
  if (info.length) {
    chunks.push(riffChunk("LIST", Buffer.concat([Buffer.from("INFO", "ascii"), ...info])));
  }
  chunks.push(riffChunk("data", data));

  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/* A 1x1 PNG, so a folder can have a cover file that is a real image. */
const PNG_1PX = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
  "01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex");

function buildLibrary(root) {
  fs.rmSync(root, { recursive: true, force: true });

  const albums = [
    {
      dir: "Talk Talk/Spirit of Eden",
      album: "Spirit of Eden", artist: "Talk Talk", year: 1988, genre: "Art Rock",
      cover: true,
      tracks: ["The Rainbow", "Eden", "Desire", "Inheritance", "I Believe in You", "Wealth"]
    },
    {
      dir: "Talk Talk/Laughing Stock",
      album: "Laughing Stock", artist: "Talk Talk", year: 1991, genre: "Art Rock",
      cover: true,
      tracks: ["Myrrhman", "Ascension Day", "After the Flood", "Taphead"]
    },
    {
      dir: "Bark Psychosis/Hex",
      album: "Hex", artist: "Bark Psychosis", year: 1994, genre: "Art Rock",
      cover: false,
      tracks: ["The Loom", "A Street Scene", "Absent Friend"]
    },
    {
      dir: "Slowdive/Souvlaki",
      album: "Souvlaki", artist: "Slowdive", year: 1993, genre: "Shoegaze",
      cover: true,
      tracks: ["Alison", "Machine Gun", "40 Days"]
    },
    {
      /* No album tag anywhere, so the folder name has to carry it. */
      dir: "Unknown/2001 - Field Recordings",
      album: "", artist: "", year: "", genre: "", cover: false,
      tracks: ["One", "Two"]
    },
    {
      /* Every track a different artist: the compilation path. */
      dir: "Compilations/Late Night Tales",
      album: "Late Night Tales", artist: null, year: 2004, genre: "Compilation",
      cover: true,
      perTrackArtists: ["Nina Simone", "Aphex Twin", "Can"],
      tracks: ["Wild Is the Wind", "Avril 14th", "Vitamin C"]
    }
  ];

  for (const spec of albums) {
    const dir = path.join(root, spec.dir);
    fs.mkdirSync(dir, { recursive: true });
    spec.tracks.forEach((title, i) => {
      const artist = spec.perTrackArtists ? spec.perTrackArtists[i] : spec.artist;
      const name = `${String(i + 1).padStart(2, "0")} ${title.replace(/[/\\]/g, "-")}.wav`;
      fs.writeFileSync(path.join(dir, name), wav({
        seconds: 2 + (i % 3),
        title, artist: artist || "", album: spec.album,
        albumArtist: spec.perTrackArtists ? "" : (spec.artist || ""),
        year: spec.year, genre: spec.genre, track: i + 1
      }));
    });
    if (spec.cover) fs.writeFileSync(path.join(dir, "cover.png"), PNG_1PX);
  }

  /* A folder with no audio in it at all — it must not become an album. */
  fs.mkdirSync(path.join(root, "Artwork Scans"), { recursive: true });
  fs.writeFileSync(path.join(root, "Artwork Scans", "back.png"), PNG_1PX);

  return { root, albums };
}

module.exports = { buildLibrary, wav, PNG_1PX };
