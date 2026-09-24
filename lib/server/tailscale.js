"use strict";
/*
 * tailscale.js — this server's address on your tailnet, for the phone to use
 * away from home. Tailscale runs on the host (the container shares its
 * network), so its interface is visible here: tailscale0, or any address in
 * Tailscale's 100.64.0.0/10. TAILSCALE_ADDRESS overrides it — an IP, a
 * MagicDNS name, or a full http(s):// address.
 */
const os = require("os");

const inTailnet = a => {
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(a);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
};

function tailscaleIp(ifaces = os.networkInterfaces()) {
  const v4 = list => (list || []).filter(i => i.family === "IPv4" || i.family === 4).map(i => i.address);
  const named = v4(ifaces.tailscale0).find(inTailnet);
  if (named) return named;
  for (const list of Object.values(ifaces)) {
    const a = v4(list).find(inTailnet);
    if (a) return a;
  }
  return null;
}

/* "http://100.x.y.z:3500", or null when there's no Tailscale here. */
function awayAddress(port, env = process.env, ifaces) {
  const set = String(env.TAILSCALE_ADDRESS || "").trim().replace(/\/+$/, "");
  if (set) return /^https?:\/\//i.test(set) ? set : `http://${set.includes(":") ? set : set + ":" + port}`;
  const ip = tailscaleIp(ifaces);
  return ip ? `http://${ip}:${port}` : null;
}

module.exports = { awayAddress, tailscaleIp, inTailnet };
