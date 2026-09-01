/*
 * MusicD Server — installing an update from GitHub, in place.
 *
 * The app already noticed a new release and said so. This is the part that
 * acts on it: fetch the release's source tarball, unpack it, copy it over the
 * install directory, reinstall dependencies if they changed, and exit so the
 * supervisor starts the new code.
 *
 * WHAT THIS DOES NOT DO IS PULL A NEW IMAGE. There is no Docker socket in the
 * container and there should not be — handing a music server the ability to
 * start containers is a far larger thing than keeping itself current. It
 * rewrites the files of the running container instead. That survives a restart,
 * because a container's writable layer does, and the next
 * `docker run --pull always` lands on the same release from the image, so the
 * two paths agree rather than fighting. What is never touched is DATA_DIR.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const https = require("https");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawnSync } = require("child_process");

/* The repository this build updates from, fixed in code. It is deliberately
   NOT a setting and never comes from the request: an endpoint that installs
   and runs whatever it is pointed at is a remote shell, not an updater. */
const OWNER = "meltface-80";
const REPO = "MusicD-Server";

/* Where a download may come from. GitHub answers the API with a redirect to
   its object store, so the list is the hosts that chain legitimately ends on.
   Anything else is refused rather than followed. */
const ALLOWED_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com"
]);

const USER_AGENT = "musicd-server-updater";
const REQUEST_TIMEOUT_MS = 20000;
const DOWNLOAD_LIMIT = 64 * 1024 * 1024;   /* a source tarball is well under a megabyte */
const NPM_TIMEOUT_MS = 10 * 60 * 1000;

/* Exit code for "I have updated myself, please start me again". Any non-zero
   code restarts the container under `--restart unless-stopped`; 75 is
   EX_TEMPFAIL, which reads as "try again" rather than "this crashed" in a log. */
const RESTART_EXIT_CODE = 75;

/* Nothing here is generated, so the whole install is replaceable — except the
   library and its art cache, which are the user's, and node_modules, which is
   built for this machine and is replaced only when the dependencies change. */
const KEEP = [".git", "node_modules", "data", ".update"];

/* ------------------------------------------------------------------ */
/*  Versions                                                           */
/* ------------------------------------------------------------------ */

/* Numeric, one field at a time. A string comparison puts "0.10.0" before
   "0.9.0", which is the wrong way round and would offer a downgrade as an
   update. Same rule as the client's isNewer(), and the suite checks they
   still agree. */
function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

/* ------------------------------------------------------------------ */
/*  GitHub                                                             */
/* ------------------------------------------------------------------ */

/* Every URL the updater is about to open, including each redirect hop. What
   comes back is unpacked and executed, so "somewhere on the internet" is not
   good enough — it has to be GitHub, over TLS. */
function assertAllowed(url) {
  const target = typeof url === "string" ? new URL(url) : url;
  if (target.protocol !== "https:") throw new Error("refusing a non-HTTPS URL");
  if (!ALLOWED_HOSTS.has(target.hostname)) {
    throw new Error("refusing to fetch from " + target.hostname);
  }
  return target;
}

/*
 * One GET, following redirects by hand so every hop is checked against the
 * host list. `https.get` would follow nothing at all, and a library that
 * follows for you follows anywhere — which is the whole risk being managed
 * here, since what comes back is unpacked and executed.
 */
function get(url, { headers = {}, onResponse }, hops = 6) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = assertAllowed(url); }
    catch (e) { return reject(e); }

    const req = https.get({
      hostname: target.hostname,
      path: target.pathname + target.search,
      headers: { "User-Agent": USER_AGENT, ...headers }
    }, (res) => {
      const { statusCode, headers: h } = res;
      if ([301, 302, 303, 307, 308].includes(statusCode) && h.location) {
        res.resume();
        if (hops <= 0) return reject(new Error("too many redirects"));
        const next = new URL(h.location, target.origin).toString();
        return resolve(get(next, { headers, onResponse }, hops - 1));
      }
      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        return reject(Object.assign(
          new Error("GitHub answered " + statusCode), { status: statusCode }));
      }
      resolve(onResponse(res));
    });

    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("GitHub timed out")));
  });
}

function getJson(url) {
  return get(url, {
    headers: { Accept: "application/vnd.github+json" },
    onResponse: (res) => new Promise((resolve, reject) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error("GitHub sent something that is not JSON")); }
      });
      res.on("error", reject);
    })
  });
}

function download(url, dest) {
  return get(url, {
    headers: { Accept: "application/octet-stream" },
    onResponse: (res) => new Promise((resolve, reject) => {
      let seen = 0;
      const file = fs.createWriteStream(dest);
      res.on("data", (chunk) => {
        seen += chunk.length;
        /* A download with no ceiling is a way to fill the disk the library
           lives on. Nothing this project publishes comes close to the limit. */
        if (seen > DOWNLOAD_LIMIT) {
          res.destroy();
          file.destroy();
          reject(new Error("the download is larger than this can possibly be"));
        }
      });
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve(seen)));
      file.on("error", reject);
      res.on("error", reject);
    })
  });
}

/* ------------------------------------------------------------------ */
/*  Unpacking and overlaying                                           */
/* ------------------------------------------------------------------ */

/* A GitHub source tarball wraps everything in one directory named for the
   owner, repo and commit. Find it rather than guessing the name. */
async function singleChildDir(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(dir, entries[0].name);
  }
  return dir;
}

async function copyOver(from, to, keep) {
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    if (keep.includes(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await fsp.mkdir(dst, { recursive: true });
      await copyOver(src, dst, keep);
    } else if (entry.isFile()) {
      await fsp.copyFile(src, dst);
    }
    /* Anything else — a socket, a device node — is not part of a source
       tarball and is not copied. */
  }
}

async function readDependencies(dir) {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(dir, "package.json"), "utf8"));
    return JSON.stringify(pkg.dependencies || {});
  } catch {
    /* No package.json to read yet, or an unreadable one. Treated as "unknown",
       which makes the comparison below unequal and reinstalls — the safe way
       round, since a missing dependency is a server that will not start. */
    return "";
  }
}

/* Put the new package.json and lockfile in place and hand back a way to undo
   it. Only the manifests move: npm reads nothing else, and moving nothing else
   is what keeps a failed install from being a half-applied update. */
async function stageManifests(from, to) {
  const undo = [];
  for (const name of ["package.json", "package-lock.json"]) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (!fs.existsSync(src)) continue;
    const had = fs.existsSync(dst) ? await fsp.readFile(dst) : null;
    undo.push(async () => {
      if (had) await fsp.writeFile(dst, had);
      else await fsp.rm(dst, { force: true });
    });
    await fsp.copyFile(src, dst);
  }
  return async () => { for (const step of undo) await step(); };
}

function defaultInstallDependencies(dir) {
  const npm = spawnSync("npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: dir, stdio: "inherit", timeout: NPM_TIMEOUT_MS });
  if (npm.error) throw new Error("could not run npm: " + npm.error.message);
  if (npm.status !== 0) throw new Error("installing the new dependencies failed");
}

/* ------------------------------------------------------------------ */
/*  The updater                                                        */
/* ------------------------------------------------------------------ */

/*
 * `dir` is the install to overwrite, `version` what is running now, and
 * `exit` is how the process ends — injected so the tests can watch it happen
 * rather than taking the suite down with it.
 */
function createUpdater({
  dir, version,
  exit = (code) => process.exit(code),
  /* How it talks to GitHub, and how it reinstalls. Both are injected so the
     tests can walk a real update all the way through without a network and
     without a ten-minute compile — never from a request or the environment,
     which is the distinction the whole file turns on. */
  transport = { getJson, download },
  installDependencies = defaultInstallDependencies
} = {}) {
  const state = {
    current: version,
    latest: null,
    available: false,
    notes: null,
    url: null,
    checkedAt: 0,
    checking: false,
    error: null,
    /* idle | checking | downloading | unpacking | installing | restarting | error */
    phase: "idle",
    phaseError: null,
    target: null
  };

  /* The download URL is deliberately NOT in here. It is read from GitHub
     again at the moment of applying, so nothing that reaches this process
     from outside can influence what gets installed. */
  let downloadUrl = null;

  function status() {
    return {
      current: state.current,
      latest: state.latest,
      available: state.available,
      notes: state.notes,
      url: state.url,
      checkedAt: state.checkedAt,
      checking: state.checking,
      error: state.error,
      apply: { phase: state.phase, error: state.phaseError, version: state.target }
    };
  }

  async function check() {
    if (state.checking) return status();
    state.checking = true;
    state.error = null;
    try {
      const release = await transport.getJson(
        `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`);
      const tag = String(release.tag_name || "");
      const latest = tag.replace(/^v/, "");
      if (!parseVersion(latest)) throw new Error("no released version to compare with");

      state.latest = latest;
      state.available = compareVersions(latest, state.current) > 0;
      state.url = release.html_url || `https://github.com/${OWNER}/${REPO}/releases`;
      state.notes = (release.body || "").trim().slice(0, 4000) || null;
      /* tarball_url is GitHub's own, for this release's tag. Taking it from
         the response rather than composing it means a renamed repository
         still resolves; the host check above is what keeps that safe. */
      downloadUrl = release.tarball_url ||
        `https://api.github.com/repos/${OWNER}/${REPO}/tarball/${tag}`;
      state.checkedAt = Date.now();
    } catch (e) {
      state.error = e.message;
    } finally {
      state.checking = false;
    }
    return status();
  }

  const BUSY = ["checking", "downloading", "unpacking", "installing", "restarting"];

  function busy() { return BUSY.includes(state.phase); }

  function setPhase(phase, error = null) {
    state.phase = phase;
    state.phaseError = error;
  }

  /*
   * Install the latest release over this one and restart.
   *
   * Everything happens in a staging directory first, and nothing in the
   * install is touched until the download has been unpacked and checked to be
   * a real build. A failure before that point leaves the running version
   * exactly as it was.
   */
  async function apply() {
    if (busy()) return status();

    setPhase("checking");
    state.target = null;
    try {
      /* Always re-check. The available flag may be minutes old, and the URL
         has to be freshly from GitHub for the guarantee above to mean
         anything. */
      await check();
      if (state.error) throw new Error(state.error);
      if (!state.available) throw new Error("Already on the latest version.");
      if (!downloadUrl) throw new Error("that release has nothing to download");

      state.target = state.latest;
      const staging = path.join(dir, ".update");
      const tarball = path.join(staging, "release.tar.gz");
      const unpacked = path.join(staging, "unpacked");

      await fsp.rm(staging, { recursive: true, force: true });
      await fsp.mkdir(unpacked, { recursive: true });

      setPhase("downloading");
      await transport.download(downloadUrl, tarball);

      setPhase("unpacking");
      /* No shell. The one argument that is not a literal is a path this
         process just made up, but a shell here would be one interpolation
         away from being the hole this whole file is careful about. */
      const tar = spawnSync("tar", ["-xzf", tarball, "-C", unpacked],
        { stdio: "ignore", timeout: REQUEST_TIMEOUT_MS * 3 });
      if (tar.error) throw new Error("could not run tar: " + tar.error.message);
      if (tar.status !== 0) throw new Error("the download would not unpack");

      const build = await singleChildDir(unpacked);
      for (const needed of ["index.js", "package.json", "lib", "public"]) {
        if (!fs.existsSync(path.join(build, needed))) {
          throw new Error("the download is not a MusicD Server build (no " + needed + ")");
        }
      }
      const staged = JSON.parse(await fsp.readFile(path.join(build, "package.json"), "utf8"));
      if (staged.version !== state.target) {
        throw new Error(`that release says it is ${staged.version}, not ${state.target}`);
      }

      /* DEPENDENCIES FIRST, code second — the order matters more than it looks.
         `npm install` is the step most likely to fail: it is minutes on a Pi
         where better-sqlite3 compiles from source, and it is the one step that
         needs a second network. Installing after the overlay means a failure
         there leaves the new code on disk against the old modules, which works
         for as long as this process lives and then will not start. Doing it
         first, with the manifests put back if it fails, means a failure leaves
         the install exactly as it was.

         And only when they actually changed. Running it for a release that
         touched no dependency is that wait and that risk for nothing. */
      if (await readDependencies(dir) !== await readDependencies(build)) {
        setPhase("installing");
        const restore = await stageManifests(build, dir);
        try {
          installDependencies(dir);
        } catch (e) {
          await restore();
          throw e;
        }
      }

      await copyOver(build, dir, KEEP);
      await fsp.rm(staging, { recursive: true, force: true });

      setPhase("restarting");
      console.log(`[update] installed ${state.target} — restarting`);
      /* Long enough for the answer to this request to reach the browser that
         asked, so it knows to start watching for the server to come back. */
      setTimeout(() => exit(RESTART_EXIT_CODE), 500);
    } catch (e) {
      console.error("[update] " + e.message);
      setPhase("error", e.message);
      /* A download nobody is going to install is just a file on the disk the
         library lives on. The next attempt starts from a clean staging
         directory anyway, so there is nothing here worth keeping. */
      await fsp.rm(path.join(dir, ".update"), { recursive: true, force: true })
        .catch(() => { /* already gone, or never made — either is fine */ });
    }
    return status();
  }

  return { status, check, apply, busy };
}

module.exports = {
  createUpdater, parseVersion, compareVersions, assertAllowed,
  OWNER, REPO, ALLOWED_HOSTS, RESTART_EXIT_CODE, KEEP
};
