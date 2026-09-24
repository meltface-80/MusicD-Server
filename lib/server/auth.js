"use strict";
/*
 * auth.js — one account, signed-in devices, and the gate in front of it all.
 *
 * No cloud: the account lives in the server's database. It is made on first
 * run, from a device on the home network, and until it exists the server
 * serves nothing but the page that makes it.
 *
 * Signing in is SRP (public/srp.js): the device proves it knows the password
 * without sending it, and the server proves it knows the account, so a fake
 * server can't complete a sign-in either. The server keeps only the SRP salt
 * and verifier.
 *
 * Each signed-in browser, app or wall display is a device with its own random
 * token (only its hash is stored). Browsers carry it in an HttpOnly cookie;
 * the Android app sends it as a bearer token. Any device can be signed out
 * from Settings, and a forgotten password is reset on the server itself:
 * `docker exec musicd-server node reset-password.js`.
 *
 * Sonos speakers can't sign in. The addresses they are given for audio and
 * covers carry a signature, and requests from the speakers' own addresses are
 * let through too, so a queue made before an update keeps playing.
 */
const crypto = require("crypto");
const SRP = require("../../public/srp");

const COOKIE = "musicd_session";
const YEAR = 365 * 86400;
const REAUTH_MS = 5 * 60 * 1000;
const MIN_ITERATIONS = 1000;

// Private and link-local ranges: "the home network".
function isLocal(ip) {
  let a = String(ip || "");
  if (a.startsWith("::ffff:")) a = a.slice(7);
  if (a === "::1" || a.startsWith("127.")) return true;
  if (/^fe80:/i.test(a) || /^f[cd][0-9a-f]{2}:/i.test(a)) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a);
  if (!m) return false;
  const x = Number(m[1]), y = Number(m[2]);
  return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254);
}

function clientIp(req) {
  let a = (req.socket && req.socket.remoteAddress) || "";
  if (a.startsWith("::ffff:")) a = a.slice(7);
  return a;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const sha256hex = s => crypto.createHash("sha256").update(String(s)).digest("hex");

// "iPhone · Safari" from a browser's user agent — enough to tell devices apart.
function deviceNameFromUA(ua) {
  const s = String(ua || "");
  const os = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android"
    : /Macintosh/.test(s) ? "Mac" : /Windows/.test(s) ? "Windows" : /CrOS/.test(s) ? "Chromebook"
    : /Linux/.test(s) ? "Linux" : "Browser";
  const br = /Edg\//.test(s) ? "Edge" : /Firefox\//.test(s) ? "Firefox" : /CriOS|Chrome\//.test(s) ? "Chrome"
    : /Safari\//.test(s) ? "Safari" : "";
  return br ? `${os} · ${br}` : os;
}

const cleanName = (s, fallback) => String(s || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80) || fallback;
const isHex = (s, min, max) => typeof s === "string" && s.length >= min && s.length <= max && /^[0-9a-f]+$/i.test(s) && s.length % 2 === 0;

function createAuth(ctx) {
  const { db, log = () => {} } = ctx;
  const raw = db.raw;
  const q = {
    account: raw.prepare("SELECT * FROM account WHERE id = 1"),
    // Setup never replaces an account, even when two devices race to make one.
    newAccount: raw.prepare(`INSERT OR IGNORE INTO account(id, username, salt, verifier, iterations, created_at, updated_at)
                             VALUES(1, @username, @salt, @verifier, @iterations, @now, @now)`),
    putAccount: raw.prepare(`INSERT INTO account(id, username, salt, verifier, iterations, created_at, updated_at)
                             VALUES(1, @username, @salt, @verifier, @iterations, @now, @now)
                             ON CONFLICT(id) DO UPDATE SET username=excluded.username, salt=excluded.salt,
                               verifier=excluded.verifier, iterations=excluded.iterations, updated_at=excluded.updated_at`),
    device: raw.prepare("SELECT * FROM devices WHERE token_hash = ?"),
    devices: raw.prepare("SELECT id, name, kind, created_at, last_seen, last_ip FROM devices ORDER BY last_seen DESC"),
    addDevice: raw.prepare(`INSERT INTO devices(id, token_hash, name, kind, created_at, last_seen, last_ip)
                            VALUES(@id, @token_hash, @name, @kind, @now, @now, @ip)`),
    seen: raw.prepare("UPDATE devices SET last_seen = ?, last_ip = ? WHERE id = ?"),
    dropDevice: raw.prepare("DELETE FROM devices WHERE id = ?")
  };

  // A per-install secret for URL signatures and decoy salts.
  let secret = db.setting("authSecret", null);
  if (!secret) { secret = crypto.randomBytes(32).toString("hex"); db.setSetting("authSecret", secret); }

  const account = () => q.account.get() || null;

  // ----------------------------------------------------------- devices

  function issueDevice(req, { name, kind }) {
    const token = crypto.randomBytes(32).toString("base64url");
    const dev = {
      id: crypto.randomBytes(9).toString("base64url"),
      token_hash: sha256hex(token),
      name: cleanName(name, deviceNameFromUA(req.headers["user-agent"])),
      kind: kind === "android" ? "android" : "browser",
      now: Date.now(),
      ip: clientIp(req)
    };
    q.addDevice.run(dev);
    log(`[auth] signed in: ${dev.name} (${dev.kind}) from ${dev.ip}`);
    return { token, device: { id: dev.id, name: dev.name, kind: dev.kind } };
  }

  function tokenOf(req) {
    const h = String(req.headers.authorization || "");
    if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim();
    return parseCookies(req.headers.cookie)[COOKIE] || null;
  }

  // The signed-in device making this request, or null.
  function deviceOf(req) {
    if (req._musicdDevice !== undefined) return req._musicdDevice;
    const t = tokenOf(req);
    let dev = null;
    if (t && account()) {
      dev = q.device.get(sha256hex(t)) || null;
      if (dev && Date.now() - dev.last_seen > 60000) q.seen.run(Date.now(), clientIp(req), dev.id);
    }
    req._musicdDevice = dev;
    return dev;
  }

  function setCookie(req, res, token, remember) {
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.append("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax` +
      (remember ? `; Max-Age=${YEAR}` : "") + (secure ? "; Secure" : ""));
  }
  function clearCookie(res) {
    res.append("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  // --------------------------------------------------------- lockout
  // Five wrong passwords from one address in 15 minutes locks that address
  // out for 15 minutes; every failure anywhere also slows the next attempt.
  const failures = new Map();   // ip -> [timestamps]
  let recentFailures = [];
  function lockedFor(ip) {
    const now = Date.now();
    const list = (failures.get(ip) || []).filter(t => now - t < 15 * 60000);
    failures.set(ip, list);
    return list.length >= 5 ? Math.max(0, list[list.length - 1] + 15 * 60000 - now) : 0;
  }
  function failed(ip) {
    const now = Date.now();
    failures.set(ip, (failures.get(ip) || []).concat(now));
    recentFailures = recentFailures.filter(t => now - t < 3600000).concat(now);
    if (failures.size > 5000) failures.delete(failures.keys().next().value);
    log(`[auth] wrong password from ${ip}`);
  }
  const slowdown = () => new Promise(r => setTimeout(r, Math.min(3000, 150 * recentFailures.length)));

  // ------------------------------------------------------ SRP sessions
  const challenges = new Map();   // id -> { username, start, expires, real }
  function sweep() {
    const now = Date.now();
    for (const [id, c] of challenges) if (c.expires < now) challenges.delete(id);
    while (challenges.size > 500) challenges.delete(challenges.keys().next().value);
  }

  // A made-up account for a username that doesn't exist, so a stranger can't
  // tell which names are real. The same name always gets the same salt.
  function decoy(username) {
    const salt = crypto.createHmac("sha256", secret).update("salt:" + username).digest("hex").slice(0, 32);
    const x = BigInt("0x" + crypto.createHmac("sha256", secret).update("x:" + username).digest("hex"));
    // Any value will do as a verifier; it only has to be stable.
    return { salt, verifier: x.toString(16).padStart(64, "0"), iterations: SRP.ITERATIONS };
  }

  const reauthed = new Map();     // device id -> until

  // ------------------------------------------------------------ signing
  const sig = p => crypto.createHmac("sha256", secret).update(p).digest("base64url").slice(0, 22);
  function signUrl(url) {
    const u = String(url);
    const i = u.indexOf("://");
    const start = i >= 0 ? u.indexOf("/", i + 3) : 0;
    const pathOnly = u.slice(start).split("?")[0];
    return u + (u.includes("?") ? "&" : "?") + "s=" + sig(pathOnly);
  }
  function speakerIps() {
    try { return new Set((ctx.zones && ctx.zones.topology.hosts) || []); } catch (e) { return new Set(); }
  }

  // --------------------------------------------------------------- gate
  const OPEN = new Set(["/api/health", "/login", "/login.html", "/login.js", "/srp.js", "/manifest.json",
    "/favicon.ico", "/apple-touch-icon.png"]);
  const isOpen = p => OPEN.has(p) || p.startsWith("/api/auth/") || p.startsWith("/icons/");
  const isMedia = p => p.startsWith("/stream/") || p.startsWith("/api/image/");

  function gate(req, res, next) {
    const p = req.path;
    if (isOpen(p)) return next();
    if (isMedia(p)) {
      const s = req.query ? String(req.query.s || "") : "";
      if (/^[A-Za-z0-9_-]{22}$/.test(s) && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(sig(p)))) return next();
      if (speakerIps().has(clientIp(req))) return next();
    }
    const acct = account();
    if (acct && deviceOf(req)) return next();
    const page = req.method === "GET" && !p.startsWith("/api/") && !isMedia(p) && !/\.(js|css|png|jpe?g|svg|ico|woff2?|json|map)$/i.test(p);
    if (page) return res.redirect(302, "/login?next=" + encodeURIComponent(req.originalUrl));
    res.status(401).json(acct
      ? { error: "Sign in to MusicD Server", sign_in_required: true }
      : { error: "Create the MusicD Server account first", setup_required: true });
  }

  // ---------------------------------------------------------------- API
  function mount(app) {
    const who = req => ({ username: (account() || {}).username || null });

    app.get("/api/auth/status", (req, res) => {
      const acct = account();
      const dev = deviceOf(req);
      res.json({
        setup_required: !acct,
        can_setup: !acct && isLocal(clientIp(req)),
        signed_in: !!dev,
        username: dev ? acct.username : null,
        device: dev ? { id: dev.id, name: dev.name, kind: dev.kind } : null
      });
    });

    app.post("/api/auth/setup", (req, res) => {
      const b = req.body || {};
      if (account()) return res.status(409).json({ error: "The account already exists — sign in instead" });
      if (!isLocal(clientIp(req))) {
        return res.status(403).json({ error: "Create the account from a device on your home network" });
      }
      const username = SRP.normUser(b.username);
      const iterations = parseInt(b.iterations, 10);
      if (!username || username.length > 64 || /[\u0000-\u001f]/.test(username)) return res.status(400).json({ error: "Choose a username" });
      if (!isHex(b.salt, 32, 128) || !isHex(b.verifier, 2, 512) || /^0+$/.test(b.verifier)) return res.status(400).json({ error: "Bad account details" });
      if (!(iterations >= MIN_ITERATIONS && iterations <= 10000000)) return res.status(400).json({ error: "Bad account details" });
      const made = q.newAccount.run({ username, salt: b.salt.toLowerCase(), verifier: b.verifier.toLowerCase(), iterations, now: Date.now() }).changes;
      if (!made) return res.status(409).json({ error: "The account already exists — sign in instead" });
      log(`[auth] account created for ${username} from ${clientIp(req)}`);
      const issued = issueDevice(req, { name: b.device_name, kind: b.kind });
      if (b.want_token) return res.json({ ok: true, token: issued.token, device: issued.device, username });
      setCookie(req, res, issued.token, b.remember !== false);
      res.json({ ok: true, device: issued.device, username });
    });

    app.post("/api/auth/challenge", (req, res) => {
      const ip = clientIp(req);
      const wait = lockedFor(ip);
      if (wait) return res.status(429).json({ error: `Too many wrong passwords — try again in ${Math.ceil(wait / 60000)} min` });
      const acct = account();
      if (!acct) return res.status(409).json({ error: "Create the account first", setup_required: true });
      const username = SRP.normUser((req.body || {}).username);
      const real = username === acct.username;
      const rec = real ? acct : decoy(username);
      const start = SRP.serverStart(rec.verifier);
      sweep();
      const id = crypto.randomBytes(12).toString("base64url");
      challenges.set(id, { username, start, real, expires: Date.now() + 60000 });
      res.json({ id, salt: rec.salt, iterations: rec.iterations, B: start.B });
    });

    app.post("/api/auth/verify", async (req, res) => {
      const b = req.body || {};
      const ip = clientIp(req);
      const wait = lockedFor(ip);
      if (wait) return res.status(429).json({ error: `Too many wrong passwords — try again in ${Math.ceil(wait / 60000)} min` });
      const c = challenges.get(String(b.id || ""));
      challenges.delete(String(b.id || ""));
      if (!c || c.expires < Date.now()) return res.status(400).json({ error: "That sign-in took too long — try again" });
      await slowdown();
      const r = c.real && isHex(b.A, 2, 512) ? SRP.serverVerify(c.start, b.A, String(b.M1 || "")) : { ok: false };
      if (!r.ok) {
        failed(ip);
        return res.status(401).json({ error: "Wrong username or password" });
      }
      failures.delete(ip);
      if (b.purpose === "reauth") {
        const dev = deviceOf(req);
        if (!dev) return res.status(401).json({ error: "Sign in first" });
        reauthed.set(dev.id, Date.now() + REAUTH_MS);
        return res.json({ ok: true, M2: r.M2 });
      }
      const issued = issueDevice(req, { name: b.device_name, kind: b.kind });
      if (b.want_token) return res.json({ ok: true, M2: r.M2, token: issued.token, device: issued.device, username: c.username });
      setCookie(req, res, issued.token, b.remember !== false);
      res.json({ ok: true, M2: r.M2, device: issued.device, username: c.username });
    });

    app.post("/api/auth/logout", (req, res) => {
      const dev = deviceOf(req);
      if (dev) { q.dropDevice.run(dev.id); log(`[auth] signed out: ${dev.name}`); }
      clearCookie(res);
      res.json({ ok: true });
    });

    app.get("/api/auth/devices", (req, res) => {
      const dev = deviceOf(req);
      if (!dev) return res.status(401).json({ error: "Sign in to MusicD Server", sign_in_required: true });
      res.json({
        username: who(req).username,
        devices: q.devices.all().map(d => Object.assign({}, d, { current: d.id === dev.id }))
      });
    });

    app.post("/api/auth/devices/revoke", (req, res) => {
      const dev = deviceOf(req);
      if (!dev) return res.status(401).json({ error: "Sign in to MusicD Server", sign_in_required: true });
      const id = String((req.body || {}).id || "");
      const n = q.dropDevice.run(id).changes;
      if (n) log(`[auth] device ${id} signed out by ${dev.name}`);
      if (id === dev.id) clearCookie(res);
      res.json({ ok: !!n });
    });

    app.post("/api/auth/password", (req, res) => {
      const dev = deviceOf(req);
      if (!dev) return res.status(401).json({ error: "Sign in to MusicD Server", sign_in_required: true });
      if (!((reauthed.get(dev.id) || 0) > Date.now())) return res.status(403).json({ error: "Enter your current password first" });
      const b = req.body || {};
      const iterations = parseInt(b.iterations, 10);
      if (!isHex(b.salt, 32, 128) || !isHex(b.verifier, 2, 512) || !(iterations >= MIN_ITERATIONS && iterations <= 10000000)) {
        return res.status(400).json({ error: "Bad account details" });
      }
      const acct = account();
      q.putAccount.run({ username: acct.username, salt: b.salt.toLowerCase(), verifier: b.verifier.toLowerCase(), iterations, now: Date.now() });
      reauthed.delete(dev.id);
      log(`[auth] password changed from ${dev.name}`);
      res.json({ ok: true });
    });
  }

  return { gate, mount, signUrl, deviceOf, isLocal, account };
}

module.exports = { createAuth, isLocal, deviceNameFromUA, COOKIE };
