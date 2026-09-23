"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");

test("the version is the same everywhere it is shown", () => {
  const v = require("../package.json").version;
  assert.equal(JSON.parse(read("package-lock.json")).version, v, "package-lock.json");
  assert.match(read("README.md"), new RegExp(`^# MusicD Server — v${v.replace(/\./g, "\\.")}$`, "m"), "README title");
  assert.ok(read("docs/index.html").includes(`<span class="badge">v${v}</span>`), "Pages badge");
  assert.ok(read("android/app/build.gradle.kts").includes(`versionName = "${v}"`), "Android versionName");
  assert.ok(read("CHANGELOG.md").includes(`## v${v}`), "CHANGELOG entry");
});
