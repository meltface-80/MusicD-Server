"use strict";
/*
 * soap.js — firing UPnP actions at a Sonos player.
 *
 * Ported from Caldera Sonos Bridge's soap.py. An unreachable player is an
 * ordinary condition on a home network, so every failure — a fault, a timeout,
 * a refused connection — comes back as one UPnPError that callers can catch
 * without caring which it was.
 */
const http = require("http");
const XML = require("../xml");

class UPnPError extends Error {
  constructor(code, description) {
    super(`UPnP error ${code}: ${description || ERROR_TEXT[code] || "Unknown error"}`);
    this.code = Number(code) || 501;
    this.description = description || ERROR_TEXT[code] || "Unknown error";
  }
}

const ERROR_TEXT = {
  401: "Invalid Action",
  402: "Invalid Args",
  501: "Action Failed",
  600: "Argument Value Invalid",
  701: "Transition not available",
  702: "No contents",
  705: "Transport is locked",
  710: "Seek mode not supported",
  711: "Illegal seek target",
  714: "Illegal MIME-type",
  718: "Invalid InstanceID",
  800: "Command not supported (grouped room?)",
  804: "Queue full or bad index"
};

function buildArgs(args) {
  return Object.entries(args || {})
    .map(([k, v]) => `<${k}>${XML.escape(v == null ? "" : v)}</${k}>`)
    .join("");
}

function buildRequest(serviceType, action, args) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"' +
    ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${buildArgs(args)}</u:${action}></s:Body>` +
    "</s:Envelope>";
}

function parseResponse(body, action) {
  const doc = XML.parse(body);
  const env = doc && doc.Envelope;
  const soapBody = env && env.Body;
  if (!soapBody) throw new UPnPError(501, "Malformed SOAP response");
  if (soapBody.Fault) {
    const f = soapBody.Fault;
    const err = f.detail && f.detail.UPnPError;
    const code = err && Number(XML.text(err.errorCode));
    const desc = err && XML.text(err.errorDescription);
    throw new UPnPError(code || 501, desc || "");
  }
  const node = soapBody[`${action}Response`] || soapBody[action] ||
    Object.values(soapBody).find(v => v && typeof v === "object");
  const out = {};
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("@")) continue;
      out[k] = XML.text(v);
    }
  }
  return out;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });

function call(url, serviceType, action, args, timeoutMs = 10000) {
  const payload = Buffer.from(buildRequest(serviceType, action, args), "utf8");
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new UPnPError(501, "bad url " + url)); }
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method: "POST",
      agent,
      headers: {
        "Content-Type": 'text/xml; charset="utf-8"',
        "SOAPACTION": `"${serviceType}#${action}"`,
        "Content-Length": payload.length
      },
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 400 && !text.includes("Fault")) {
          return reject(new UPnPError(501, `HTTP ${res.statusCode} from ${url}`));
        }
        try { resolve(parseResponse(text, action)); } catch (e) { reject(e); }
      });
      res.on("error", e => reject(new UPnPError(501, e.message)));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", e => reject(new UPnPError(501, `Sonos player at ${u.host} is not responding: ${e.message}`)));
    req.end(payload);
  });
}

function httpGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs, agent }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new UPnPError(501, `HTTP ${res.statusCode} fetching ${url}`));
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", e => reject(new UPnPError(501, e.message)));
  });
}

module.exports = { UPnPError, buildRequest, parseResponse, call, httpGet };
