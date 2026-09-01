"use strict";

/*
 * The updater downloads code from the internet and runs it. Most of what is
 * checked here is therefore not "does it work" but "what does it refuse to
 * do" — a bug in this file is a remote shell, not a missing feature.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const updater = require("../lib/updater");
const { createUpdater, parseVersion, compareVersions } = updater;

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-upd-"));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/* ------------------------------------------------------------------ */
/*  Versions                                                           */
/* ------------------------------------------------------------------ */

test("versions compare by number, not as text", () => {
  /* "0.10.0" sorts before "0.9.0" as a string, which would read a new release
     as older than the one running and never offer it. */
  assert.strictEqual(compareVersions("0.10.0", "0.9.0"), 1);
  assert.strictEqual(compareVersions("0.9.0", "0.10.0"), -1);
  assert.strictEqual(compareVersions("1.0.0", "0.99.99"), 1);
  assert.strictEqual(compareVersions("0.3.4", "0.3.4"), 0);
  assert.strictEqual(compareVersions("0.3.10", "0.3.9"), 1);
});

test("anything that is not a plain version is not a version", () => {
  for (const bad of ["", null, "latest", "0.3", "0.3.4.5", "v0.3.x", "1.0.0-beta"]) {
    assert.strictEqual(parseVersion(bad), null, JSON.stringify(bad) + " is not a version");
  }
  assert.deepStrictEqual(parseVersion("v0.3.4"), [0, 3, 4], "a leading v is allowed");
  assert.deepStrictEqual(parseVersion(" 0.3.4 "), [0, 3, 4], "and so is whitespace");
});

test("the client and the server agree on what is newer", () => {
  /* Two implementations, one rule. If they drift, the banner offers an update
     the server then refuses to install, or the other way round. */
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const body = /function isNewer\([\s\S]*?\n\}/.exec(app);
  assert.ok(body, "the client has an isNewer()");
  // eslint-disable-next-line no-new-func
  const isNewer = new Function("return " + body[0] + "; isNewer")();
  for (const [a, b] of [["0.10.0", "0.9.0"], ["0.9.0", "0.10.0"], ["1.0.0", "0.99.99"],
                        ["0.3.4", "0.3.4"], ["0.3.10", "0.3.9"], ["0.0.1", "0.0.1"]]) {
    assert.strictEqual(isNewer(a, b), compareVersions(a, b) > 0,
      `they disagree about whether ${a} is newer than ${b}`);
  }
});

/* ------------------------------------------------------------------ */
/*  What it refuses                                                    */
/* ------------------------------------------------------------------ */

test("the repository is fixed in code, not taken from anywhere", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "updater.js"), "utf8");
  assert.strictEqual(updater.OWNER, "meltface-80");
  assert.strictEqual(updater.REPO, "MusicD-Server");
  /* Nothing may read the download's address out of the request, the
     environment or the database. An updater that installs what it is pointed
     at is a way to run anything on this machine. */
  assert.ok(!/process\.env\.[A-Z_]*(URL|REPO|OWNER|UPDATE)/.test(src),
    "no environment variable redirects the update");
  const index = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const routes = index.slice(index.indexOf('"/api/update"'));
  const block = routes.slice(0, routes.indexOf("\n/*", 1));
  assert.ok(!/req\.body|req\.query|req\.params/.test(block),
    "the update endpoints read nothing off the request");
});

test("only GitHub's own hosts are allowed to answer", () => {
  for (const host of ["api.github.com", "github.com", "codeload.github.com",
                      "objects.githubusercontent.com"]) {
    assert.ok(updater.ALLOWED_HOSTS.has(host), host + " is where a release really comes from");
  }
  for (const host of ["evil.example", "api.github.com.evil.example", "githubusercontent.com",
                      "raw.githubusercontent.com", "localhost", "127.0.0.1"]) {
    assert.ok(!updater.ALLOWED_HOSTS.has(host), host + " must not be trusted");
  }
});

test("the data directory is never overwritten by an update", () => {
  /* The library and its play history are the one thing here that cannot be
     downloaded again. node_modules is kept because it is built for this
     machine, and .git because a source checkout is somebody's working copy. */
  for (const kept of ["data", "node_modules", ".git"]) {
    assert.ok(updater.KEEP.includes(kept), kept + " must survive an update");
  }
});

test("restarting is a non-zero exit, so a supervisor brings it back", () => {
  /* Exiting 0 tells Docker the container finished and it stays down —
     an update that ends by shutting the server off for good. */
  assert.ok(updater.RESTART_EXIT_CODE > 0);
});

/* ------------------------------------------------------------------ */
/*  Applying                                                           */
/* ------------------------------------------------------------------ */

test("a fresh updater has nothing to report and is not busy", () => {
  const ws = workspace();
  const u = createUpdater({ dir: ws.root, version: "0.3.4" });
  const s = u.status();
  assert.strictEqual(s.current, "0.3.4");
  assert.strictEqual(s.latest, null);
  assert.strictEqual(s.available, false);
  assert.strictEqual(s.apply.phase, "idle");
  assert.strictEqual(u.busy(), false);
  ws.cleanup();
});

test("every URL is checked before it is opened, redirects included", () => {
  const { assertAllowed } = updater;
  for (const good of ["https://api.github.com/repos/x/y/tarball/v1.0.0",
                      "https://codeload.github.com/x/y/tar.gz/refs/tags/v1.0.0",
                      "https://objects.githubusercontent.com/anything"]) {
    assert.doesNotThrow(() => assertAllowed(good), good);
  }
  /* A redirect is where this bites: the first hop is GitHub, and the second is
     wherever the answer says. Each one goes through here. */
  for (const bad of ["http://api.github.com/repos/x/y/tarball/v1.0.0",
                     "https://api.github.com.attacker.example/repos/x/y/tarball/v1",
                     "https://raw.githubusercontent.com/x/y/main/evil.tgz",
                     "https://127.0.0.1/x.tgz",
                     "https://gitllhub.com/x/y/archive/main.tar.gz"]) {
    assert.throws(() => assertAllowed(bad), /refusing/, bad + " must be refused");
  }
});

/* ------------------------------------------------------------------ */
/*  A whole update, without a network                                  */
/* ------------------------------------------------------------------ */

/* Build the tarball GitHub would serve: one wrapping directory, the build
   inside it. */
function releaseTarball(version, { extra = {}, deps = { "better-sqlite3": "^11.10.0" } } = {}) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-rel-"));
  const top = path.join(stage, `meltface-80-MusicD-Server-abc1234`);
  fs.mkdirSync(path.join(top, "lib"), { recursive: true });
  fs.mkdirSync(path.join(top, "public"), { recursive: true });
  fs.writeFileSync(path.join(top, "index.js"), `// MusicD Server ${version}\n`);
  fs.writeFileSync(path.join(top, "package.json"),
    JSON.stringify({ name: "musicd-server", version, dependencies: deps }, null, 2));
  fs.writeFileSync(path.join(top, "lib", "db.js"), `// db ${version}\n`);
  fs.writeFileSync(path.join(top, "public", "app.js"), `// app ${version}\n`);
  for (const [rel, body] of Object.entries(extra)) {
    fs.mkdirSync(path.join(top, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(top, rel), body);
  }
  const tgz = path.join(stage, "release.tar.gz");
  const r = require("child_process").spawnSync("tar",
    ["-czf", tgz, "-C", stage, path.basename(top)], { stdio: "ignore" });
  assert.strictEqual(r.status, 0, "the fixture tarball was built");
  return { tgz, cleanup: () => fs.rmSync(stage, { recursive: true, force: true }) };
}

function fakeGitHub(version, tgz) {
  return {
    getJson: async () => ({
      tag_name: "v" + version,
      html_url: `https://github.com/meltface-80/MusicD-Server/releases/tag/v${version}`,
      body: "What changed",
      tarball_url: `https://api.github.com/repos/meltface-80/MusicD-Server/tarball/v${version}`
    }),
    download: async (url, dest) => {
      /* The real one refuses anything off GitHub; this one proves the updater
         hands it a GitHub address rather than something it was told. */
      updater.assertAllowed(url);
      fs.copyFileSync(tgz, dest);
    }
  };
}

/* An install as it looks on disk, with the things an update must not touch. */
function installedAt(root, version) {
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  fs.mkdirSync(path.join(root, "data", "cache", "art"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "better-sqlite3"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.js"), `// MusicD Server ${version}\n`);
  fs.writeFileSync(path.join(root, "package.json"),
    JSON.stringify({ name: "musicd-server", version,
                     dependencies: { "better-sqlite3": "^11.10.0" } }, null, 2));
  fs.writeFileSync(path.join(root, "lib", "db.js"), `// db ${version}\n`);
  fs.writeFileSync(path.join(root, "public", "app.js"), `// app ${version}\n`);
  fs.writeFileSync(path.join(root, "data", "musicd.db"), "the user's library");
  fs.writeFileSync(path.join(root, "data", "cache", "art", "a.jpg"), "cover");
  fs.writeFileSync(path.join(root, "node_modules", "better-sqlite3", "index.js"), "built here");
}

test("an update replaces the code, keeps the library, and asks to be restarted", async () => {
  const ws = workspace();
  installedAt(ws.root, "0.3.4");
  const rel = releaseTarball("0.4.0");

  let exited = null;
  const u = createUpdater({
    dir: ws.root, version: "0.3.4",
    exit: (code) => { exited = code; },
    transport: fakeGitHub("0.4.0", rel.tgz)
  });

  const s = await u.apply();
  assert.strictEqual(s.apply.error, null, "it did not fail: " + s.apply.error);
  assert.strictEqual(s.apply.phase, "restarting");
  assert.strictEqual(s.apply.version, "0.4.0");

  const read = (...p) => fs.readFileSync(path.join(ws.root, ...p), "utf8");
  assert.strictEqual(read("index.js"), "// MusicD Server 0.4.0\n", "the app is the new one");
  assert.strictEqual(read("lib", "db.js"), "// db 0.4.0\n");
  assert.strictEqual(read("public", "app.js"), "// app 0.4.0\n");
  assert.strictEqual(JSON.parse(read("package.json")).version, "0.4.0");

  assert.strictEqual(read("data", "musicd.db"), "the user's library", "the library is untouched");
  assert.strictEqual(read("data", "cache", "art", "a.jpg"), "cover", "and so is the art cache");
  assert.strictEqual(read("node_modules", "better-sqlite3", "index.js"), "built here",
    "and the modules built for this machine");
  assert.ok(!fs.existsSync(path.join(ws.root, ".update")), "the staging is cleared up");

  /* The exit is what a supervisor sees; a zero would leave the container down. */
  await new Promise(r => setTimeout(r, 700));
  assert.strictEqual(exited, updater.RESTART_EXIT_CODE, "it asked to be restarted");
  rel.cleanup(); ws.cleanup();
});

test("a download that is not this app is refused before anything is overwritten", async () => {
  const ws = workspace();
  installedAt(ws.root, "0.3.4");

  /* A tarball with no index.js — a source archive of something else, or an
     asset that turned out to be the wrong file. */
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "musicd-bad-"));
  const top = path.join(stage, "something-else");
  fs.mkdirSync(top, { recursive: true });
  fs.writeFileSync(path.join(top, "README.md"), "not a build");
  const tgz = path.join(stage, "bad.tar.gz");
  require("child_process").spawnSync("tar", ["-czf", tgz, "-C", stage, "something-else"],
    { stdio: "ignore" });

  const u = createUpdater({
    dir: ws.root, version: "0.3.4",
    exit: () => assert.fail("nothing was installed, so nothing may restart"),
    transport: fakeGitHub("0.4.0", tgz)
  });

  const s = await u.apply();
  assert.strictEqual(s.apply.phase, "error");
  assert.match(s.apply.error, /not a MusicD Server build/);
  assert.strictEqual(fs.readFileSync(path.join(ws.root, "index.js"), "utf8"),
    "// MusicD Server 0.3.4\n", "the running build is exactly as it was");
  fs.rmSync(stage, { recursive: true, force: true });
  ws.cleanup();
});

test("a release that is not the version it claimed is refused", async () => {
  /* The check said 0.4.0 and the tarball says something else — a mismatch
     means the two requests did not see the same thing, so neither is trusted. */
  const ws = workspace();
  installedAt(ws.root, "0.3.4");
  const rel = releaseTarball("9.9.9");

  const u = createUpdater({
    dir: ws.root, version: "0.3.4",
    exit: () => assert.fail("nothing was installed, so nothing may restart"),
    transport: {
      getJson: fakeGitHub("0.4.0", rel.tgz).getJson,
      download: fakeGitHub("0.4.0", rel.tgz).download
    }
  });

  const s = await u.apply();
  assert.strictEqual(s.apply.phase, "error");
  assert.match(s.apply.error, /says it is 9\.9\.9, not 0\.4\.0/);
  assert.strictEqual(fs.readFileSync(path.join(ws.root, "index.js"), "utf8"),
    "// MusicD Server 0.3.4\n");
  rel.cleanup(); ws.cleanup();
});

test("an update to the version already running is refused", async () => {
  const ws = workspace();
  installedAt(ws.root, "0.4.0");
  const rel = releaseTarball("0.4.0");
  const u = createUpdater({
    dir: ws.root, version: "0.4.0",
    exit: () => assert.fail("there was nothing to install"),
    transport: fakeGitHub("0.4.0", rel.tgz)
  });
  const s = await u.apply();
  assert.strictEqual(s.apply.phase, "error");
  assert.match(s.apply.error, /Already on the latest/);
  rel.cleanup(); ws.cleanup();
});

test("an older release is never offered as an update", async () => {
  /* A release deleted or re-tagged on GitHub can make "latest" go backwards.
     Rolling the user back without asking is not an update. */
  const ws = workspace();
  const rel = releaseTarball("0.2.0");
  const u = createUpdater({
    dir: ws.root, version: "0.3.4", transport: fakeGitHub("0.2.0", rel.tgz)
  });
  const s = await u.check();
  assert.strictEqual(s.latest, "0.2.0");
  assert.strictEqual(s.available, false, "0.2.0 is not an update to 0.3.4");
  rel.cleanup(); ws.cleanup();
});

test("dependencies are only reinstalled when they actually changed", async () => {
  /* npm install is minutes on a Pi, where better-sqlite3 compiles from source.
     Running it for a release that changed no dependency is that wait for
     nothing — and it is the step most likely to fail. */
  const ws = workspace();
  installedAt(ws.root, "0.3.4");
  const installed = [];
  const run = (dir) => installed.push(dir);

  const same = releaseTarball("0.4.0");            // the same dependencies
  const a = await createUpdater({
    dir: ws.root, version: "0.3.4", exit: () => {}, installDependencies: run,
    transport: fakeGitHub("0.4.0", same.tgz)
  }).apply();
  assert.strictEqual(a.apply.error, null, a.apply.error);
  assert.deepStrictEqual(installed, [], "nothing changed, so nothing was reinstalled");

  const changed = releaseTarball("0.5.0", { deps: { "better-sqlite3": "^12.0.0" } });
  const b = await createUpdater({
    dir: ws.root, version: "0.4.0", exit: () => {}, installDependencies: run,
    transport: fakeGitHub("0.5.0", changed.tgz)
  }).apply();
  assert.strictEqual(b.apply.error, null, b.apply.error);
  assert.deepStrictEqual(installed, [ws.root], "a changed dependency is installed, in place");

  same.cleanup(); changed.cleanup(); ws.cleanup();
});

test("an update that cannot install its dependencies leaves the old one running", async () => {
  /* This is the step most likely to fail — minutes of compiling on a Pi, and
     a second trip to the network. Failing it AFTER the code was written over
     the install would leave new code against old modules: fine until the
     container next restarts, and then a server that will not start at all. */
  const ws = workspace();
  installedAt(ws.root, "0.3.4");
  const rel = releaseTarball("0.4.0", { deps: { "better-sqlite3": "^12.0.0" } });

  const s = await createUpdater({
    dir: ws.root, version: "0.3.4",
    exit: () => assert.fail("a failed install must not restart"),
    installDependencies: () => { throw new Error("installing the new dependencies failed"); },
    transport: fakeGitHub("0.4.0", rel.tgz)
  }).apply();

  assert.strictEqual(s.apply.phase, "error");
  assert.match(s.apply.error, /dependencies/);

  const read = (...p) => fs.readFileSync(path.join(ws.root, ...p), "utf8");
  assert.strictEqual(read("index.js"), "// MusicD Server 0.3.4\n", "the code is the old one");
  assert.strictEqual(read("lib", "db.js"), "// db 0.3.4\n");
  const pkg = JSON.parse(read("package.json"));
  assert.strictEqual(pkg.version, "0.3.4", "and so is the manifest");
  assert.deepStrictEqual(pkg.dependencies, { "better-sqlite3": "^11.10.0" },
    "including the dependencies npm was asked to change");
  assert.ok(!fs.existsSync(path.join(ws.root, ".update")) ||
            !fs.existsSync(path.join(ws.root, ".update", "unpacked")),
    "nothing is left staged");
  rel.cleanup(); ws.cleanup();
});

test("the status the endpoints hand out carries no download address", async () => {
  /* The URL is read from GitHub again at the moment of applying. Publishing it
     invites somebody to send it back, which is the thing being avoided. */
  const ws = workspace();
  const rel = releaseTarball("0.4.0");
  const u = createUpdater({
    dir: ws.root, version: "0.3.4", transport: fakeGitHub("0.4.0", rel.tgz)
  });
  const s = JSON.stringify(await u.check());
  assert.ok(!/tarball|codeload|\.tar\.gz/i.test(s), "the status is only a report: " + s);
  assert.match(s, /0\.4\.0/, "though it does say which version is on offer");
  rel.cleanup(); ws.cleanup();
});

test("a check that cannot reach GitHub reports that, rather than an update", async () => {
  const ws = workspace();
  const u = createUpdater({
    dir: ws.root, version: "0.3.4",
    transport: { getJson: async () => { throw new Error("getaddrinfo ENOTFOUND"); },
                 download: async () => assert.fail("nothing to download") }
  });
  const s = await u.check();
  assert.strictEqual(s.available, false, "no answer means no update on offer");
  assert.match(s.error, /ENOTFOUND/, "and the reason is kept");
  assert.strictEqual(s.checking, false, "the flag is cleared either way");
  ws.cleanup();
});

test("a failure leaves nothing half-installed and no staging behind", async () => {
  const ws = workspace();
  installedAt(ws.root, "0.3.4");
  const u = createUpdater({
    dir: ws.root, version: "0.3.4",
    exit: () => assert.fail("nothing was installed, so nothing may restart"),
    transport: { getJson: async () => { throw new Error("GitHub answered 503"); },
                 download: async () => assert.fail("nothing to download") }
  });
  const s = await u.apply();
  assert.strictEqual(s.apply.phase, "error");
  assert.match(s.apply.error, /503/);
  assert.strictEqual(fs.readFileSync(path.join(ws.root, "index.js"), "utf8"),
    "// MusicD Server 0.3.4\n", "the running build is untouched");
  assert.ok(!fs.existsSync(path.join(ws.root, ".update")), "and no staging is left behind");
  ws.cleanup();
});

/* ------------------------------------------------------------------ */
/*  The transport itself                                               */
/* ------------------------------------------------------------------ */

/*
 * The updater's own HTTPS code, driven against the shape GitHub really
 * answers with. Everything below the transport was covered by injecting a
 * stand-in for it, which meant this half — redirects, the size cap, reading
 * the body — had never run at all. `https.get` is replaced with a real
 * readable stream, so flowing mode, pipe() and the order listeners attach in
 * all behave as they will against a socket.
 */
const https = require("https");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

/*
 * A stand-in that REFUSES THINGS, not one that says yes to everything.
 *
 * The 415 that broke every in-app update between 0.4.0 and 0.4.3 was an Accept
 * header the archive endpoint does not take — a header a permissive fake never
 * looks at, which is why four passing tests said the transport was fine. So
 * this one checks the request the way GitHub does before it answers.
 */
function githubWouldRefuse(url, headers) {
  const accept = String((headers && headers.Accept) || "");
  if (url.includes("/tarball/") || url.includes("/zipball/")) {
    /* octet-stream is for a RELEASE ASSET. On an archive it is a 415. */
    if (/application\/octet-stream/.test(accept)) return 415;
  }
  if (url.includes("/releases/latest") && accept && !/vnd\.github|json|\*\/\*/.test(accept)) {
    return 415;
  }
  return 0;
}

function withFakeGitHub(routes, run) {
  const asked = [];
  const real = https.get;
  https.get = (options, cb) => {
    const host = options.hostname || options.host;
    const url = `https://${host}${options.path}`;
    asked.push({ url, headers: options.headers });
    const res = new PassThrough();
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    setImmediate(() => {
      const refused = githubWouldRefuse(url, options.headers);
      const answer = refused
        ? { status: refused, headers: {}, body: "" }
        : (routes(url) || { status: 404, headers: {}, body: "" });
      res.statusCode = answer.status;
      res.headers = answer.headers || {};
      cb(res);
      if (answer.body === undefined || answer.body === null) return res.end();
      /* In pieces, the way a socket delivers it: one end() would hide a
         mistake about when the file is opened relative to the data. */
      const buf = Buffer.from(answer.body);
      for (let i = 0; i < buf.length; i += 2048) res.write(buf.subarray(i, i + 2048));
      res.end();
    });
    return req;
  };
  return Promise.resolve(run(asked)).finally(() => { https.get = real; });
}

const RELEASE = (version) => JSON.stringify({
  tag_name: "v" + version,
  html_url: `https://github.com/meltface-80/MusicD-Server/releases/tag/v${version}`,
  body: "notes",
  tarball_url: `https://api.github.com/repos/meltface-80/MusicD-Server/tarball/v${version}`
});

test("an update installs over the REAL transport, redirect and all", async () => {
  const ws = workspace();
  installedAt(ws.root, "0.4.1");
  const rel = releaseTarball("0.4.2");
  const gz = fs.readFileSync(rel.tgz);

  let exited = null;
  await withFakeGitHub((url) => {
    if (url.includes("/releases/latest")) {
      return { status: 200, headers: {}, body: RELEASE("0.4.2") };
    }
    if (url.includes("api.github.com") && url.includes("/tarball/")) {
      /* Exactly what GitHub does: a 302 on to its own download host. */
      return { status: 302, headers: {
        location: "https://codeload.github.com/meltface-80/MusicD-Server/legacy.tar.gz/refs/tags/v0.4.2"
      } };
    }
    if (url.includes("codeload.github.com")) return { status: 200, headers: {}, body: gz };
    return null;
  }, async (asked) => {
    const s = await createUpdater({
      dir: ws.root, version: "0.4.1", exit: (c) => { exited = c; },
      installDependencies: () => assert.fail("the dependencies did not change")
    }).apply();

    assert.strictEqual(s.apply.error, null, "it did not fail: " + s.apply.error);
    assert.strictEqual(s.apply.phase, "restarting");
    assert.ok(asked.some(a => a.url.includes("codeload")), "the redirect was followed");
    assert.strictEqual(fs.readFileSync(path.join(ws.root, "index.js"), "utf8"),
      "// MusicD Server 0.4.2\n", "and the whole tarball landed, not a truncated one");
    assert.strictEqual(fs.readFileSync(path.join(ws.root, "data", "musicd.db"), "utf8"),
      "the user's library");
  });

  await new Promise(r => setTimeout(r, 700));
  assert.strictEqual(exited, updater.RESTART_EXIT_CODE);
  rel.cleanup(); ws.cleanup();
});

test("the archive is asked for with a header the archive endpoint takes", async () => {
  /* THE BUG THIS FILE EXISTS TO HAVE CAUGHT. `Accept: application/octet-stream`
     is what you send for a release asset; on the tarball endpoint GitHub
     answers 415 Unsupported Media Type, and every in-app update from 0.4.0 to
     0.4.3 died there. Nothing noticed because the fake here answered whatever
     it was asked — it now refuses the same way. */
  const ws = workspace();
  installedAt(ws.root, "0.4.1");
  const rel = releaseTarball("0.4.2");
  const gz = fs.readFileSync(rel.tgz);

  await withFakeGitHub((url) => {
    if (url.includes("/releases/latest")) return { status: 200, headers: {}, body: RELEASE("0.4.2") };
    if (url.includes("api.github.com") && url.includes("/tarball/")) {
      return { status: 302, headers: {
        location: "https://codeload.github.com/meltface-80/MusicD-Server/legacy.tar.gz/refs/tags/v0.4.2"
      } };
    }
    if (url.includes("codeload.github.com")) return { status: 200, headers: {}, body: gz };
    return null;
  }, async (asked) => {
    const s = await createUpdater({
      dir: ws.root, version: "0.4.1", exit: () => {},
      installDependencies: () => assert.fail("the dependencies did not change")
    }).apply();
    assert.strictEqual(s.apply.error, null, "it did not fail: " + s.apply.error);

    const archive = asked.find(a => a.url.includes("/tarball/"));
    assert.ok(archive, "the archive was asked for");
    assert.ok(!/application\/octet-stream/.test(archive.headers.Accept),
      "octet-stream on an archive is a 415 — was " + archive.headers.Accept);
    assert.strictEqual(archive.headers["X-GitHub-Api-Version"], "2022-11-28",
      "and the API version is pinned, so a future default cannot change the answer");
  });
  rel.cleanup(); ws.cleanup();
});

test("a redirect off GitHub is refused mid-chain", async () => {
  /* The first hop is GitHub and the second is wherever the answer says, so
     every hop goes through the host check — not just the one that was typed. */
  const ws = workspace();
  installedAt(ws.root, "0.4.1");
  await withFakeGitHub((url) => {
    if (url.includes("/releases/latest")) return { status: 200, headers: {}, body: RELEASE("0.4.2") };
    if (url.includes("/tarball/")) {
      return { status: 302, headers: { location: "https://evil.example/payload.tar.gz" } };
    }
    return null;
  }, async (asked) => {
    const s = await createUpdater({
      dir: ws.root, version: "0.4.1",
      exit: () => assert.fail("nothing was installed, so nothing may restart")
    }).apply();
    assert.strictEqual(s.apply.phase, "error");
    assert.match(s.apply.error, /refusing to fetch from evil\.example/);
    assert.ok(!asked.some(a => a.url.includes("evil.example")), "and it was never opened");
  });
  ws.cleanup();
});

test("being rate-limited says so, rather than reporting a bare 403", async () => {
  /* Sixty unauthenticated requests an hour PER ADDRESS, shared with every
     phone in the house. It is the likeliest reason an update refuses to
     install, and "GitHub answered 403" gives nobody anywhere to go. */
  const ws = workspace();
  const reset = Math.floor((Date.now() + 12 * 60000) / 1000);
  await withFakeGitHub(() => ({
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    body: ""
  }), async () => {
    const s = await createUpdater({ dir: ws.root, version: "0.4.1" }).check();
    assert.match(s.error, /rate-limiting/);
    assert.match(s.error, /1[12] minutes/, "and roughly when it lifts");
  });
  ws.cleanup();
});

test("a failure says which step it died in, and what this machine can do", async () => {
  /* "The update failed" is not a report anybody can act on, and the person who
     has to act on it is rarely standing next to the container's log. */
  const ws = workspace();
  installedAt(ws.root, "0.4.1");
  await withFakeGitHub((url) => {
    if (url.includes("/releases/latest")) return { status: 200, headers: {}, body: RELEASE("0.4.2") };
    return { status: 500, headers: {}, body: "" };   // the download falls over
  }, async () => {
    const s = await createUpdater({
      dir: ws.root, version: "0.4.1",
      exit: () => assert.fail("nothing was installed, so nothing may restart")
    }).apply();

    assert.strictEqual(s.apply.phase, "error");
    assert.match(s.apply.error, /while downloading/, "the step it died in");
    const d = s.apply.diagnosis;
    assert.ok(d, "and what the machine could do at the time");
    assert.strictEqual(d.step, "downloading");
    assert.strictEqual(d.writable, true, "whether it can write where it installs");
    assert.match(d.tar, /tar|missing/, "and whether tar is even there");
    assert.ok(d.node.startsWith("v"));
  });
  ws.cleanup();
});
