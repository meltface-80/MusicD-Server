"use strict";
const test = require("node:test");
const assert = require("node:assert");
const ArtFind = require("../lib/library/artfind");

const TRACKS = ["Untitled #1 (Vaka)", "Untitled #2 (Fyrsta)", "Untitled #3 (Samskeyti)", "Untitled #4 (Njósnavélin)"];

// Canned catalogue answers, keyed by the start of the address asked for.
function fakeWeb(routes) {
  return async (url) => {
    for (const [prefix, body] of routes) if (url.startsWith(prefix)) return typeof body === "function" ? body(url) : body;
    throw new Error("HTTP 404");
  };
}

test("a record with the same tracks, artist and title is picked without asking", async () => {
  const get = fakeWeb([
    ["https://itunes.apple.com/search", { results: [
      { collectionId: 1, collectionName: "( )", artistName: "Sigur Rós", artworkUrl100: "https://is1.example/a/100x100bb.jpg", trackCount: 8 },
      { collectionId: 2, collectionName: "Takk...", artistName: "Sigur Rós", artworkUrl100: "https://is1.example/b/100x100bb.jpg", trackCount: 11 }
    ] }],
    ["https://itunes.apple.com/lookup?id=1", { results: [{ wrapperType: "collection" }].concat(
      ["Untitled 1", "Untitled 2", "Untitled 3", "Untitled 4"].map(t => ({ wrapperType: "track", trackName: t }))) }],
    ["https://itunes.apple.com/lookup?id=2", { results: [{ wrapperType: "track", trackName: "Glósóli" }] }]
  ]);
  const r = await ArtFind.find({ title: "( )", artist: "Sigur Rós" }, TRACKS, { get });
  assert.ok(r.sure, "should be sure");
  assert.equal(r.sure.url, "https://is1.example/a/1200x1200bb.jpg");
  assert.equal(r.sure.match.tracks, 1);
  assert.equal(r.candidates.length, 2);
});

test("a title-and-artist match with no track list is only a suggestion", async () => {
  const get = fakeWeb([
    ["https://api.deezer.com/search/album", { data: [
      { id: 9, title: "Kid A", artist: { name: "Radiohead" }, cover_xl: "https://dz.example/9.jpg", nb_tracks: 10 }
    ] }]
  ]);
  const r = await ArtFind.find({ title: "Kid A", artist: "Radiohead" }, ["Everything in Its Right Place"], { get });
  assert.equal(r.sure, null);
  assert.equal(r.candidates[0].url, "https://dz.example/9.jpg");
});

test("the right tracks under the wrong artist are not sure", async () => {
  const get = fakeWeb([
    ["https://itunes.apple.com/search", { results: [
      { collectionId: 5, collectionName: "Greatest Hits", artistName: "Someone Else", artworkUrl100: "https://is1.example/c/100x100bb.jpg" }
    ] }],
    ["https://itunes.apple.com/lookup?id=5", { results: [{ wrapperType: "track", trackName: "Song 1" }, { wrapperType: "track", trackName: "Song 2" }] }]
  ]);
  const r = await ArtFind.find({ title: "Greatest Hits", artist: "Artist A" }, ["Song 1", "Song 2"], { get });
  assert.equal(r.sure, null);
  assert.equal(r.candidates.length, 1);
});

test("track names are compared without their brackets and edition notes", () => {
  assert.equal(ArtFind.trackMatch(["Untitled #1 (Vaka)", "Airbag (Remastered)"], ["Untitled #1", "Airbag"]), 1);
  assert.equal(ArtFind.trackMatch(["A"], []), null);
});
