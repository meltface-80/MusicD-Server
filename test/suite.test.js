"use strict";
/*
 * Checks on the SUITE, not on the app.
 *
 * There is one of these because a test file can break another one without
 * either being wrong on its own — and when it does, what you get is not a
 * failure with a name on it but a build that sits there.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const FILES = fs.readdirSync(DIR).filter(f => f.endsWith(".test.js"));

test("no two test files use the same port", () => {
  /*
   * WHAT THIS COST, and why the rule is absolute rather than a list of
   * exceptions.
   *
   * `node --test` runs the FILES IN PARALLEL. 0.4.54 added tests that listened
   * on 49198 and 49199 — the two addresses test/dlna.test.js asserts nothing is
   * listening on, because "a device that has gone" and "this is not a renderer"
   * are only testable against a port with nothing behind it. Whenever the two
   * files overlapped, those assertions were being made against a live fake
   * renderer.
   *
   * It went green on the branch twice and then sat for a quarter of an hour on
   * main without a single line of output naming anything — which is the worst
   * shape a test failure can take, and the reason this is checked mechanically
   * rather than by remembering to look.
   *
   * NO ALLOW-LIST. Two files sharing a port that nothing listens on is harmless
   * today and is one edit away from not being, and a rule with exceptions in it
   * is one nobody can apply without reading the exceptions.
   */
  const owner = new Map();          // port -> the file that used it first
  const clashes = [];
  for (const file of FILES) {
    const src = fs.readFileSync(path.join(DIR, file), "utf8")
      /* Prose is not code: a comment naming a port is not a use of one. */
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
    /* The range these fakes live in — 1xxxx for the Sonos stand-ins, 49xxx for
       the renderers, which is where UPnP devices really do sit. */
    const ports = new Set([...src.matchAll(/\b(1[0-9]{4}|49[0-9]{3})\b/g)].map(m => m[1]));
    for (const port of ports) {
      const first = owner.get(port);
      if (first && first !== file) clashes.push(`${port}: ${first} and ${file}`);
      else owner.set(port, file);
    }
  }
  assert.deepStrictEqual(clashes, [],
    "these files run at the same time and would be talking to each other");
});

test("no test goes looking for real devices on the network", () => {
  /*
   * A Household with an empty `hosts` takes the DISCOVERY path, and
   * `ssdpSearch` then waits out its full three seconds finding the nothing that
   * is on a test machine. One rig did that once per test — twenty-four times,
   * SEVENTY-FIVE SECONDS, most of the suite's running time — and on a CI runner,
   * where multicast inside a container is anybody's guess, it is worse than
   * slow. `Renderers` has the same shape and the same escape hatch.
   *
   * Both take an injectable precisely so this path can be DRIVEN rather than
   * performed. A test that wants the real search says so by injecting a fake
   * one; a test that does not want it at all still has to say so.
   */
  for (const file of FILES) {
    const src = fs.readFileSync(path.join(DIR, file), "utf8");
    for (const m of src.matchAll(/new\s+(?:\w+\.)?Household\(\{([\s\S]{0,300}?)\}\)/g)) {
      const args = m[1];
      const empty = /hosts:\s*\[\s*\]/.test(args);
      if (empty) {
        assert.match(args, /discover:/,
          `${file}: a Household with no hosts and no injected discover — this ` +
          `sends a real SSDP search and waits three seconds for it`);
      }
    }
    /* Renderers is usually given its search on the line after it is built, so
       the whole file is the window rather than the call. */
    if (/new\s+(?:\w+\.)?Renderers\(/.test(src)) {
      assert.match(src, /\.search\s*=|search:/,
        `${file}: a Renderers that will run a real SSDP search`);
    }
  }
});

test("every fake server is given a port rather than defaulting to one", () => {
  /*
   * A default port is a port two callers get without either of them saying so,
   * which is the same collision arriving by a quieter route. The fakes keep
   * their defaults for readability at the definition; what must not happen is a
   * TEST relying on one.
   */
  for (const file of FILES) {
    const src = fs.readFileSync(path.join(DIR, file), "utf8");
    for (const call of src.matchAll(/createFake(?:Sonos|Renderer)\(([\s\S]{0,200}?)\)/g)) {
      /* `port:` or the shorthand `port,` — both say which one it is. */
      assert.match(call[1], /\bport\s*[:,}]/,
        `${file}: a fake without a port of its own — ${call[0].slice(0, 60)}`);
    }
  }
});
