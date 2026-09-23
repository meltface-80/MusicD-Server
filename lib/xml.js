"use strict";
/*
 * xml.js — the few XML chores the server has: escaping what it writes, and
 * reading what Sonos writes back.
 *
 * Parsing goes through fast-xml-parser with namespaces stripped. Sonos is
 * consistent about its prefixes but UPnP as a whole is not, and every consumer
 * here asks for a local name ("Track", "ZoneGroupMember", "res"), never a
 * qualified one.
 */
const { XMLParser } = require("fast-xml-parser");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Entities inside SOAP arguments (a DIDL document inside a string) must come
  // back decoded, which is what processEntities does; the XML itself never
  // declares any, so there is nothing for an entity expansion to amplify.
  processEntities: true,
  htmlEntities: false
});

function parse(text) {
  if (!text || typeof text !== "string") return null;
  try { return parser.parse(text); } catch (e) { return null; }
}

function escape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// fast-xml-parser gives one child as an object and several as an array; every
// caller wants a list.
function list(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Text content of a node that may be a bare string or {"#text": ..., "@attr": ...}.
function text(v) {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object" && v["#text"] != null) return String(v["#text"]);
  return "";
}

module.exports = { parse, escape, list, text };
