#!/usr/bin/env node
"use strict";
/*
 * reset-password.js — forgot the password? Run this on the server:
 *
 *     docker exec musicd-server node reset-password.js
 *
 * It removes the account and signs every device out. Nothing else changes:
 * the library, your edits, playlists and history all stay. Then open MusicD
 * Server from a device on your home network (the Android app or a browser)
 * and create the account again.
 */
const path = require("path");
const DB = require("./lib/library/db");

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const db = DB.open(dataDir, { log: () => {} });
const had = db.raw.prepare("SELECT username FROM account WHERE id = 1").get();
const devices = db.raw.prepare("DELETE FROM devices").run().changes;
db.raw.prepare("DELETE FROM account").run();
db.close();

if (had) {
  console.log(`The account "${had.username}" was removed and ${devices} device(s) signed out.`);
} else {
  console.log("There was no account to remove.");
}
console.log("Open MusicD Server on a device on your home network to create the account again.");
