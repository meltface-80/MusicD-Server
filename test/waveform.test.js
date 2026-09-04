"use strict";
/*
 * The waveform: the numbers, the decoder, and the store in front of them.
 *
 * The decoder is exercised BOTH ways. An injected spawn covers the failures a
 * real ffmpeg will not perform on demand — no binary, a hang, a split sample,
 * a non-zero exit after good audio — and a real ffmpeg over a real file covers
 * the thing none of that can prove: that what comes out is the shape of what
 * went in.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { EventEmitter } = require("events");

const WF = require("../lib/waveform");
const WFD = require("../lib/waveform-decode");
const { createWaveforms } = require("../lib/waveforms");
const dbLib = require("../lib/db");
const scanner = require("../lib/scanner");
const { buildLibrary, wav } = require("./fixtures");

/* ---------------------------------------------------------------- */
/*  The numbers                                                      */
/* ---------------------------------------------------------------- */

/** Signed 16-bit LE mono PCM from an array of sample values. */
function pcm(samples) {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => b.writeInt16LE(v, i * 2));
  return b;
}

test("peaks take the loudest sample in each stride, not the average", () => {
  const acc = WF.createPeaks({ stride: 4 });
  /* One loud sample in an otherwise quiet group. An average would bury it;
     the whole point of a waveform is that it does not. */
  acc.push(pcm([100, 100, 30000, 100,  200, 200, 200, 200]));
  assert.deepStrictEqual(acc.raw, [30000, 200]);
});

test("a sample split across two chunks is still one sample", () => {
  /* ffmpeg writes to a pipe and the OS breaks it wherever it likes, so a
     16-bit sample arrives in halves regularly. Reading the stray byte as a
     whole sample would inject a spurious peak at every chunk boundary. */
  const whole = pcm([1000, -32000, 500, 6000]);
  const acc = WF.createPeaks({ stride: 1 });
  acc.push(whole.subarray(0, 3));       // splits the second sample down the middle
  acc.push(whole.subarray(3));
  assert.deepStrictEqual(acc.raw, [1000, 32000, 500, 6000]);
});

test("full-scale negative does not scale the whole track down", () => {
  /* -32768 has no positive twin in int16. Left uncapped it is a peak of 32768,
     and since normalise divides by the maximum, one sample would quietly shrink
     every other bar in the track. */
  const acc = WF.createPeaks({ stride: 1 });
  acc.push(pcm([-32768, 32767]));
  assert.deepStrictEqual(acc.raw, [32767, 32767]);
  assert.deepStrictEqual([...acc.finish(2)], [255, 255]);
});

test("resampling keeps the peaks rather than averaging them away", () => {
  const spiky = [0, 0, 0, 900, 0, 0, 0, 100];
  assert.deepStrictEqual(WF.resample(spiky, 2), [900, 100]);
});

test("a clip shorter than the bar is stretched, not left as a stub", () => {
  assert.deepStrictEqual(WF.resample([10, 20], 6), [10, 10, 10, 20, 20, 20]);
});

test("silence stays silence instead of dividing by nothing", () => {
  const out = WF.normalise([0, 0, 0]);
  assert.deepStrictEqual([...out], [0, 0, 0], "and not NaN, even by accident");
});

test("the loudest bucket of any track is 255", () => {
  /* Per track on purpose: a quietly-mastered record drawn on an absolute scale
     is a flat line next to a loud one, which is true and useless. */
  assert.deepStrictEqual([...WF.normalise([10, 5, 0])], [255, 128, 0]);
  assert.deepStrictEqual([...WF.normalise([1000, 500, 0])], [255, 128, 0]);
});

test("base64 survives the round trip, and junk decodes to nothing", () => {
  const u8 = new Uint8Array([0, 127, 255, 3]);
  assert.deepStrictEqual([...WF.decode(WF.encode(u8))], [...u8]);
  for (const junk of [null, undefined, "", 42, {}]) {
    assert.strictEqual(WF.decode(junk).length, 0);
  }
});

/* ---------------------------------------------------------------- */
/*  The decoder, with a stand-in for ffmpeg                          */
/* ---------------------------------------------------------------- */

/* A fake ffmpeg. It is deliberately NOT permissive: the args it was called
   with are recorded so a test can assert what was ASKED FOR, which is the half
   a happy-path stand-in never checks. */
function fakeSpawn({ stdout = [], code = 0, stderr = "", fail = false, hang = false } = {}) {
  const calls = [];
  const spawn = (bin, args) => {
    calls.push({ bin, args });
    if (fail) throw new Error("ENOENT");
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    if (!hang) {
      setImmediate(() => {
        for (const chunk of stdout) child.stdout.emit("data", chunk);
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        child.emit("close", code);
      });
    }
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

test("ffmpeg is asked for the FIRST audio stream, as mono, at the stored rate", async () => {
  const spawn = fakeSpawn({ stdout: [pcm(new Array(600).fill(9000))] });
  await WFD.decodeWaveform("/music/x.flac", { spawn, buckets: 8 });
  const args = spawn.calls[0].args;
  /* -map 0:a:0 matters: a rip carrying a commentary track would otherwise be
     drawn from whichever stream ffmpeg picked by its own rules. */
  assert.ok(args.join(" ").includes("-map 0:a:0"), args.join(" "));
  /* Raw mono PCM at the stored rate, on stdout. Decoding to 8 kHz would make
     ffmpeg lowpass at 4 kHz first and quietly flatten every cymbal and snare
     before the peak detector could see them. */
  assert.deepStrictEqual(args.slice(-7),
    ["-f", "s16le", "-ac", "1", "-ar", "16000", "-"]);
  assert.strictEqual(WFD.DECODE_RATE, 16000, "and the store records which rate that was");
  assert.ok(args.includes("-nostdin"), "never wait on a terminal that is not there");
});

test("no ffmpeg anywhere is 'no waveform', not a crash", async () => {
  assert.strictEqual(await WFD.decodeWaveform("/music/x.flac", { spawn: fakeSpawn({ fail: true }) }), null);
});

test("a decode that produces nothing is null, not an empty picture", async () => {
  const out = await WFD.decodeWaveform("/music/x.dsf",
    { spawn: fakeSpawn({ stdout: [], code: 1, stderr: "Invalid data found\n" }) });
  assert.strictEqual(out, null);
  assert.match(WFD.lastDecodeError(), /Invalid data/);
});

test("a damaged file that decoded most of the way still gets a waveform", async () => {
  /* Most of the way is a perfectly good picture of the track, and refusing it
     would mean a truncated download shows nothing rather than nearly all. */
  const out = await WFD.decodeWaveform("/music/truncated.mp3",
    { spawn: fakeSpawn({ stdout: [pcm(new Array(600).fill(5000))], code: 1, stderr: "truncated\n" }) });
  assert.ok(out && out.length === 1000);
  assert.strictEqual(Math.max(...out), 255);
});

test("a wedged ffmpeg gives up rather than holding the decode for ever", async () => {
  const out = await WFD.decodeWaveform("/music/x.flac",
    { spawn: fakeSpawn({ hang: true }), timeoutMs: 40 });
  assert.strictEqual(out, null);
});

/* ---------------------------------------------------------------- */
/*  The decoder, over a real file with real ffmpeg                   */
/* ---------------------------------------------------------------- */

test("the shape that goes in is the shape that comes out", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-wf-"));
  const file = path.join(root, "shaped.wav");
  /* Quiet first half, full second half. A waveform asserted over SILENCE would
     pass with the drawing wrong, which is the trap this fixture exists to
     avoid — so the fixture is audible at the point being checked. */
  fs.writeFileSync(file, wav({ seconds: 4, shape: (x) => (x < 0.5 ? 0.15 : 1) }));
  const out = await WFD.decodeWaveform(file);
  fs.rmSync(root, { recursive: true, force: true });

  if (!out) return t.skip("no ffmpeg on this machine");
  assert.strictEqual(out.length, 1000);
  const quiet = out[200], loud = out[800];
  assert.ok(loud > 240, "the loud half reaches full scale: " + loud);
  assert.ok(quiet > 20 && quiet < 60, "the quiet half is about 15%: " + quiet);
  /* The transition is where it was put, not smeared across the track. */
  assert.ok(out[490] < 60 && out[510] > 240, "the step is at the half way point");
});

/* ---------------------------------------------------------------- */
/*  The store                                                        */
/* ---------------------------------------------------------------- */

function rig({ decodeImpl, available = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-wfs-"));
  const music = path.join(root, "music");
  buildLibrary(music);
  const db = dbLib.open(path.join(root, "data"));
  return scanner.scan(db, [music], { artDir: path.join(root, "data", "cache", "art") })
    .then(() => ({
      db,
      waveforms: createWaveforms({ db, available, decodeImpl }),
      trackIds: (album) => db.prepare(
        `SELECT t.id FROM tracks t JOIN albums a ON a.id = t.album_id
         WHERE a.title = ? ORDER BY t.disc, t.no`).all(album).map(r => r.id),
      cleanup() { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
    }));
}

const fakePeaks = (v) => new Uint8Array(new Array(1000).fill(v));

test("a decoded waveform is stored and the second ask never decodes again", async () => {
  let decodes = 0;
  const r = await rig({ decodeImpl: async () => { decodes++; return fakePeaks(200); } });
  try {
    const id = r.trackIds("Spirit of Eden")[0];
    const first = await r.waveforms.forTrack(id);
    assert.strictEqual(first.cached, false);
    assert.strictEqual(first.n, 1000);
    assert.strictEqual(decodes, 1);

    const second = await r.waveforms.forTrack(id);
    assert.strictEqual(second.cached, true);
    assert.strictEqual(second.peaks, first.peaks);
    assert.strictEqual(decodes, 1, "the file is read once, ever");
  } finally { r.cleanup(); }
});

test("two screens asking at once share one decode", async () => {
  let decodes = 0;
  const r = await rig({ decodeImpl: async () => {
    decodes++;
    await new Promise(res => setTimeout(res, 30));
    return fakePeaks(120);
  } });
  try {
    const id = r.trackIds("Souvlaki")[0];
    /* A double tap on a phone, not an edge case. */
    const [a, b] = await Promise.all([r.waveforms.forTrack(id), r.waveforms.forTrack(id)]);
    assert.strictEqual(decodes, 1, "one ffmpeg, not two");
    assert.strictEqual(a.peaks, b.peaks);
  } finally { r.cleanup(); }
});

test("a file ffmpeg cannot read is remembered, so it is not retried for ever", async () => {
  let decodes = 0;
  const r = await rig({ decodeImpl: async () => { decodes++; return null; } });
  try {
    const id = r.trackIds("Hex")[0];
    const first = await r.waveforms.forTrack(id);
    assert.strictEqual(first.peaks, null);
    assert.strictEqual(first.reason, "undecodable");

    const second = await r.waveforms.forTrack(id);
    assert.strictEqual(second.peaks, null);
    assert.strictEqual(second.cached, true, "the miss came from the database");
    assert.strictEqual(decodes, 1, "ffmpeg is not spawned again to fail again");
  } finally { r.cleanup(); }
});

test("replacing the file re-analyses it, rather than drawing the old audio", async () => {
  let decodes = 0;
  const r = await rig({ decodeImpl: async () => { decodes++; return fakePeaks(decodes * 10); } });
  try {
    const id = r.trackIds("Souvlaki")[0];
    await r.waveforms.forTrack(id);
    assert.strictEqual(decodes, 1);

    /* A re-rip at the same path: same track id, different audio. Trusting the
       stored row here would draw a confident picture of a file that is gone. */
    r.db.prepare("UPDATE tracks SET mtime = mtime + 1000, size = size + 42 WHERE id = ?").run(id);
    const after = await r.waveforms.forTrack(id);
    assert.strictEqual(decodes, 2, "the row was not believed");
    assert.strictEqual(after.cached, false);
  } finally { r.cleanup(); }
});

test("a waveform taken at a different decode rate is thrown away", async () => {
  let decodes = 0;
  const r = await rig({ decodeImpl: async () => { decodes++; return fakePeaks(90); } });
  try {
    const id = r.trackIds("Hex")[0];
    await r.waveforms.forTrack(id);
    /* Rows analysed at two rates are two different pictures with nothing on
       screen to say which is which — worse than either on its own. */
    r.db.prepare("UPDATE waveforms SET rate = rate / 2 WHERE track_id = ?").run(id);
    await r.waveforms.forTrack(id);
    assert.strictEqual(decodes, 2);
  } finally { r.cleanup(); }
});

test("the next track on the record is decoded while this one plays", async () => {
  const seen = [];
  const r = await rig({ decodeImpl: async (file) => { seen.push(path.basename(file)); return fakePeaks(64); } });
  try {
    const ids = r.trackIds("Spirit of Eden");
    await r.waveforms.forTrack(ids[0]);
    await r.waveforms.warm(ids[0]);
    assert.strictEqual(seen.length, 2, seen.join(", "));
    /* The album's order, which is the order this app plays a record in — there
       is no shuffle and no repeat by design. */
    const second = await r.waveforms.forTrack(ids[1]);
    assert.strictEqual(second.cached, true, "it was ready before it was asked for");
  } finally { r.cleanup(); }
});

test("the last track of a record warms nothing", async () => {
  let decodes = 0;
  const r = await rig({ decodeImpl: async () => { decodes++; return fakePeaks(64); } });
  try {
    const ids = r.trackIds("Spirit of Eden");
    assert.strictEqual(r.waveforms.warm(ids[ids.length - 1]), null);
    assert.strictEqual(decodes, 0);
  } finally { r.cleanup(); }
});

test("a track that is not in the library is a clean no, not a throw", async () => {
  const r = await rig({ decodeImpl: async () => fakePeaks(10) });
  try {
    const out = await r.waveforms.forTrack("t:nowhere/nothing.flac");
    assert.strictEqual(out.peaks, null);
    assert.strictEqual(out.reason, "unknown-track");
  } finally { r.cleanup(); }
});

test("WAVEFORM=false answers off without touching a file", async () => {
  let decodes = 0;
  const r = await rig({ available: false, decodeImpl: async () => { decodes++; return fakePeaks(1); } });
  try {
    const id = r.trackIds("Hex")[0];
    const out = await r.waveforms.forTrack(id);
    assert.strictEqual(out.peaks, null);
    assert.strictEqual(out.reason, "off");
    assert.strictEqual(r.waveforms.warm(id), null);
    assert.strictEqual(decodes, 0);
  } finally { r.cleanup(); }
});
