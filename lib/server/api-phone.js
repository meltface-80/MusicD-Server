"use strict";
/*
 * api-phone.js — the Android app as a player (see lib/sonos/phones.js).
 *
 *   POST /api/phone/hello     the app's player has started (empty) → its zone id,
 *                             and where to find this server away from home
 *   GET  /api/phone/commands  ?after=<seq>: what to do next, held open ~25 s
 *   POST /api/phone/state     what the player is actually doing
 *
 * Only a signed-in Android app can be a phone zone, and only as itself: the
 * zone id comes from the device's sign-in, never from the request.
 */
const { awayAddress } = require("./tailscale");

module.exports = function mountPhone(app, ctx) {
  const { zones, auth } = ctx;
  const phones = zones.phones;

  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { res.status(e.status || 500).json({ error: e.message || String(e) }); }
  };
  function phoneDevice(req) {
    const dev = auth.deviceOf(req);
    if (!dev || dev.kind !== "android") {
      const e = new Error("Only the MusicD Android app can play as a phone");
      e.status = 403;
      throw e;
    }
    return dev;
  }

  app.post("/api/phone/hello", wrap(async (req, res) => {
    const dev = phoneDevice(req);
    res.json(Object.assign(phones.hello(dev.id, (req.body || {}).name || dev.name), {
      away: auth.isAway(req),
      away_address: awayAddress(ctx.config.port)
    }));
  }));

  app.get("/api/phone/commands", wrap(async (req, res) => {
    const dev = phoneDevice(req);
    const after = Math.max(0, parseInt(req.query.after, 10) || 0);
    const wait = Math.max(0, Math.min(25000, parseInt(req.query.wait, 10) || 0));
    res.json(await phones.commands(phones.constructor.uidFor(dev.id), after, wait));
  }));

  app.post("/api/phone/state", wrap(async (req, res) => {
    const dev = phoneDevice(req);
    phones.report(phones.constructor.uidFor(dev.id), req.body || {});
    res.json({ ok: true });
  }));
};
