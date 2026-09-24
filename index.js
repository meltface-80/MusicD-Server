"use strict";
/*
 * MusicD Server — your own music files, played to Sonos.
 *
 *   browser / PWA / Android app ──HTTP──▶  this server  ──Sonos UPnP──▶  rooms
 *                                              │                           │
 *                                              └──── /stream/t<id>.flac ◀──┘
 *
 * The interface is MusicD Remote's. Underneath, instead of a Roon Core, there
 * is a library scanned from your music folder and the Sonos control from the
 * Caldera / UPnP-to-Sonos bridges. Sonos fetches each track from this server:
 * as stored when it is within 24-bit/48 kHz, resampled to 24/48 FLAC when it
 * is above that.
 */
const path = require("path");
const fs = require("fs");
const express = require("express");
const compression = require("compression");

const pkg = require("./package.json");
const { createAuth } = require("./lib/server/auth");
const DB = require("./lib/library/db");
const { Scanner } = require("./lib/library/scanner");
const { Library } = require("./lib/library/index");
const { Artwork } = require("./lib/library/artwork");
const { ZoneManager } = require("./lib/sonos/zones");
const { localIp } = require("./lib/sonos/topology");
const STREAM = require("./lib/stream");
const FF = require("./lib/ffmpeg");
const shareLinks = require("./lib/share-links");
const { Playback, trackIdFromUri, planFor } = require("./lib/server/playback");
const { Features } = require("./lib/server/features");

const list = v => String(v || "").split(",").map(s => s.trim()).filter(Boolean);

const config = {
  port: Number(process.env.PORT) || 3500,
  musicDir: process.env.MUSIC_DIR || "/music",
  dataDir: process.env.DATA_DIR || path.join(__dirname, "data"),
  serverIp: process.env.SERVER_IP || process.env.BRIDGE_IP || "",
  sonosHosts: list(process.env.SONOS_HOSTS),
  include: list(process.env.INCLUDE_ZONES),
  exclude: list(process.env.EXCLUDE_ZONES),
  scanHours: Number(process.env.SCAN_INTERVAL_HOURS) || 6,
  transcodeCacheGb: Number(process.env.TRANSCODE_CACHE_GB) || 4,
  debug: !!process.env.DEBUG
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function createServer(overrides = {}) {
  Object.assign(config, overrides);
  const db = DB.open(config.dataDir, { log });
  const library = new Library(db, { musicRoot: config.musicDir, log });
  const scanner = new Scanner({ db, root: config.musicDir, log });
  const artwork = new Artwork({ library, cacheDir: path.join(config.dataDir, "art"), log });
  const transcoder = new STREAM.Transcoder({
    cacheDir: path.join(config.dataDir, "transcode"),
    maxBytes: config.transcodeCacheGb * 1024 ** 3,
    log
  });
  const advertisedIp = () => config.serverIp || localIp();
  // The speakers found last time are asked first, so after a restart or an
  // update the rooms are back in a second or two instead of after discovery.
  const knownHosts = (db.setting("sonosKnownHosts", []) || []).filter(h => !config.sonosHosts.includes(h));
  const zones = new ZoneManager({
    seedHosts: config.sonosHosts.concat(knownHosts), bindIp: config.serverIp || localIp(),
    include: config.include, exclude: config.exclude, log, trackIdFromUri
  });
  zones.topology.onHosts = (ips) => {
    const next = [...new Set(ips)].sort();
    if (JSON.stringify(next) !== JSON.stringify(db.setting("sonosKnownHosts", []))) db.setSetting("sonosKnownHosts", next);
  };

  const ctx = {
    config, db, library, scanner, artwork, transcoder, zones, log, version: pkg.version,
    baseUrl: () => `http://${advertisedIp()}:${config.port}`,
    shareServices: () => {
      const v = db.setting("shareServices", null);
      return v === null ? shareLinks.defaultServiceIds() : shareLinks.sanitiseIds(v, shareLinks.knownServiceIds());
    },
    shareReviews: () => {
      const v = db.setting("shareReviews", null);
      return v === null ? shareLinks.defaultReviewIds() : shareLinks.sanitiseIds(v, shareLinks.knownReviewIds());
    },
    afterScan: () => {
      library.reload();
      artwork.prewarm(400).catch(() => {});
      features.kickSmartPicks();
    }
  };
  // One account and its signed-in devices; everything below sits behind it.
  const auth = ctx.auth = createAuth(ctx);
  ctx.playback = new Playback(ctx);
  const features = ctx.features = new Features(ctx);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.use(auth.gate);
  auth.mount(app);

  // ---------------------------------------------------------------- stream
  // Before compression: audio must go out byte for byte, with ranges.
  app.get(/^\/stream\/t(\d+)\.([a-z0-9]+)$/i, (req, res) => {
    const t = library.track(Number(req.params[0]));
    if (!t) return res.status(404).end();
    const p = planFor(t);
    if (!p.transcode) {
      res.set("Content-Type", p.mime);
      res.set("Cache-Control", "no-store");
      return res.sendFile(t.path, { dotfiles: "allow", acceptRanges: true }, (err) => {
        if (err && !res.headersSent) res.status(err.statusCode || 404).end();
      });
    }
    const job = transcoder.start(Object.assign({}, t), p);
    if (job.done && !job.failed) {
      res.set("Content-Type", p.mime);
      res.set("Cache-Control", "no-store");
      return res.sendFile(job.final, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    }
    if (job.done && job.failed) return res.status(500).end();
    STREAM.tailFollow(req, res, job, p.mime);
  });

  app.use(compression());
  app.use((req, res, next) => {
    if (!config.debug || !req.path.startsWith("/api/") || /zone-state|image\//.test(req.path)) return next();
    const t0 = Date.now();
    res.on("finish", () => log("[http]", req.method, req.originalUrl, "->", res.statusCode, (Date.now() - t0) + "ms"));
    next();
  });

  require("./lib/server/api-library")(app, ctx);
  require("./lib/server/api-playback")(app, ctx);
  require("./lib/server/api-playlists")(app, ctx);
  require("./lib/server/api-phone")(app, ctx);

  app.get("/api/health", (req, res) => res.json({
    ok: true, version: pkg.version, albums: library.count, rooms: zones.topology.rooms().length,
    ffmpeg: FF.info().ok, soxr: FF.info().soxr, transcode_cache: transcoder.cacheStats()
  }));
  app.use("/api", (req, res) => res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` }));

  const pub = path.join(__dirname, "public");
  app.get(["/display", "/display/"], (req, res) => res.sendFile(path.join(pub, "display.html")));
  app.get("/login", (req, res) => res.sendFile(path.join(pub, "login.html")));
  // The interface. The Android app keeps the page clear of the system bars
  // itself, so it gets the page without viewport-fit=cover: otherwise newer
  // WebViews report the bars as safe-area insets too and the page leaves the
  // same space twice (a gap over the top buttons, the mini player riding high).
  function sendApp(req, res) {
    const file = path.join(pub, "index.html");
    res.set("Vary", "User-Agent");
    if (!/MusicDAndroid\//.test(req.headers["user-agent"] || "")) return res.sendFile(file);
    fs.readFile(file, "utf8", (err, html) => {
      if (err) return res.status(500).end();
      res.set("Cache-Control", "no-cache");
      res.type("html").send(html.replace(/,\s*viewport-fit=cover/, ""));
    });
  }
  app.get(["/", "/index.html"], sendApp);
  // And the stylesheet with every safe-area allowance at zero, for the same
  // reason — whatever the WebView reports, the app has already made the room.
  app.get("/style.css", (req, res, next) => {
    if (!/MusicDAndroid\//.test(req.headers["user-agent"] || "")) return next();
    fs.readFile(path.join(pub, "style.css"), "utf8", (err, css) => {
      if (err) return next();
      res.set("Cache-Control", "no-cache");
      res.set("Vary", "User-Agent");
      res.type("css").send(css.replace(/env\(safe-area-inset-(top|bottom|left|right)\)/g, "0px"));
    });
  });
  app.use(express.static(pub, {
    maxAge: "1h",
    index: false,
    setHeaders(res, file) { if (/\.(html|js|css|json)$/.test(file)) res.setHeader("Cache-Control", "no-cache"); }
  }));
  // Anything else is the single-page app, so a deep link still opens it.
  app.get("*", sendApp);

  async function start() {
    library.reload();
    const ff = FF.info();
    log(`[musicd] MusicD Server ${pkg.version} — music in ${config.musicDir}, data in ${config.dataDir}`);
    const parent = path.dirname(config.musicDir), base = path.basename(config.musicDir);
    let strays = [];
    try { strays = fs.readdirSync(parent).filter(n => n !== base && n.startsWith(base) && fs.statSync(path.join(parent, n)).isDirectory()); } catch (e) {}
    if (strays.length) {
      log(`[musicd] WARNING: ${strays.map(n => path.join(parent, n)).join(", ")} will not be scanned — mount each music folder inside ${config.musicDir}, e.g. -v /path/to/Music:${path.join(config.musicDir, "name")}:ro`);
    }
    log(ff.ok ? `[musicd] ${ff.version}${ff.soxr ? " (soxr resampler)" : ""}` : "[musicd] WARNING: ffmpeg not found — hi-res files cannot be converted for Sonos");
    await new Promise((resolve, reject) => {
      const srv = app.listen(config.port, "0.0.0.0", resolve);
      srv.on("error", reject);
      ctx.httpServer = srv;
    });
    log(`[musicd] listening on ${ctx.baseUrl()} — open it in a browser`);
    zones.start();
    features.wire();
    // Albums found by a scan appear (and play) as it goes, not only at the end.
    scanner.onProgress = () => library.reload();
    const scan = () => scanner.scan().then(r => { if (r.status !== "running") ctx.afterScan(); })
      .catch(e => log("[scan] " + e.message));
    ctx.scanTimers = [setTimeout(scan, 500), setInterval(scan, config.scanHours * 3600 * 1000)];
    ctx.scanTimers[1].unref();
    return ctx;
  }

  async function stop() {
    zones.stop();
    for (const t of ctx.scanTimers || []) clearTimeout(t);
    scanner.onProgress = null;
    if (ctx.httpServer) {
      const closed = new Promise(r => ctx.httpServer.close(r));
      // Kept-alive connections too, or a client (or the next server on this
      // port, after an in-app update) talks to a socket that's going away.
      if (ctx.httpServer.closeAllConnections) ctx.httpServer.closeAllConnections();
      await closed;
    }
    db.close();
  }

  return { app, ctx, start, stop };
}

module.exports = { createServer, config };

if (require.main === module) {
  const s = createServer();
  s.start().catch(e => { console.error(e); process.exit(1); });
  const bye = () => { s.stop().finally(() => process.exit(0)); };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
}
