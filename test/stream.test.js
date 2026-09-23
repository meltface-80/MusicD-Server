"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { plan } = require("../lib/stream");

test("a CD-quality FLAC goes to Sonos untouched", () => {
  const p = plan({ path: "/m/a.flac", codec: "FLAC", sampleRate: 44100, bitsPerSample: 16, channels: 2 });
  assert.equal(p.transcode, false);
  assert.equal(p.mime, "audio/flac");
});

test("24/48 is the ceiling, and is still bit-perfect", () => {
  const p = plan({ path: "/m/a.flac", codec: "FLAC", sampleRate: 48000, bitsPerSample: 24, channels: 2 });
  assert.equal(p.transcode, false);
});

test("anything above 24/48 is brought down to 24/48 FLAC", () => {
  for (const rate of [88200, 96000, 176400, 192000, 352800]) {
    const p = plan({ path: "/m/a.flac", codec: "FLAC", sampleRate: rate, bitsPerSample: 24, channels: 2 });
    assert.equal(p.transcode, true, String(rate));
    assert.equal(p.rate, 48000);
    assert.equal(p.bits, 24);
    assert.equal(p.mime, "audio/flac");
  }
});

test("32-bit at 48k is brought to 24-bit, rate kept", () => {
  const p = plan({ path: "/m/a.wav", codec: "PCM", sampleRate: 48000, bitsPerSample: 32, channels: 2 });
  assert.equal(p.transcode, true);
  assert.equal(p.rate, 48000);
  assert.equal(p.bits, 24);
});

test("hi-res ALAC is resampled too", () => {
  const p = plan({ path: "/m/a.m4a", codec: "ALAC", sampleRate: 96000, bitsPerSample: 24, channels: 2 });
  assert.equal(p.transcode, true);
  assert.equal(p.rate, 48000);
});

test("DSD becomes 24/48 FLAC", () => {
  const p = plan({ path: "/m/a.dsf", codec: "DSD", sampleRate: 2822400, bitsPerSample: 1, channels: 2 });
  assert.equal(p.transcode, true);
  assert.equal(p.rate, 48000);
  assert.equal(p.bits, 24);
});

test("lossy formats Sonos reads pass straight through", () => {
  assert.equal(plan({ path: "/m/a.mp3", codec: "MPEG 1 Layer 3", sampleRate: 44100, channels: 2 }).transcode, false);
  assert.equal(plan({ path: "/m/a.m4a", codec: "AAC", sampleRate: 44100, channels: 2 }).mime, "audio/mp4");
  assert.equal(plan({ path: "/m/a.ogg", codec: "Vorbis", sampleRate: 44100, channels: 2 }).mime, "audio/ogg");
});

test("formats Sonos cannot read become FLAC at their own rate when within the ceiling", () => {
  const p = plan({ path: "/m/a.ape", codec: "Monkey's Audio", sampleRate: 44100, bitsPerSample: 16, channels: 2 });
  assert.equal(p.transcode, true);
  assert.equal(p.rate, 44100);
  assert.equal(p.bits, 16);
});

test("24-bit WAV is repacked as FLAC, same rate", () => {
  const p = plan({ path: "/m/a.wav", codec: "PCM", sampleRate: 44100, bitsPerSample: 24, channels: 2 });
  assert.equal(p.transcode, true);
  assert.equal(p.rate, 44100);
  assert.equal(p.bits, 24);
});
