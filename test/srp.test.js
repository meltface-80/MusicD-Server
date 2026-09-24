"use strict";
/*
 * public/srp.js: its hashes against Node's own, a full sign-in both ways, and
 * the fixed example (test/srp-vector.json) the Android app's Kotlin copy is
 * checked against too — phone and server must agree to the byte.
 */
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const SRP = require("../public/srp");
const V = require("./srp-vector.json");

test("SHA-256, HMAC and PBKDF2 match Node's crypto", () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const b = crypto.randomBytes(n);
    assert.equal(SRP.toHex(SRP.sha256(b)), crypto.createHash("sha256").update(b).digest("hex"), "sha256 " + n);
  }
  for (const kl of [0, 5, 64, 65, 100]) {
    const k = crypto.randomBytes(kl), m = crypto.randomBytes(77);
    assert.equal(SRP.toHex(SRP.hmacSha256(k, m)), crypto.createHmac("sha256", k).update(m).digest("hex"), "hmac " + kl);
  }
  const pw = Buffer.from("pässword"), salt = crypto.randomBytes(16);
  assert.equal(SRP.toHex(SRP.pbkdf2(pw, salt, 1500)), crypto.pbkdf2Sync(pw, salt, 1500, 32, "sha256").toString("hex"));
});

test("a sign-in succeeds with the password and fails without it", () => {
  const v = SRP.makeVerifier("Someone", "right", 1000);
  const cs = SRP.clientStart(), ss = SRP.serverStart(v.verifier);
  const ok = SRP.clientProof(" someone ", "right", v.salt, 1000, cs, ss.B);
  const r = SRP.serverVerify(ss, cs.A, ok.M1);
  assert.equal(r.ok, true);
  assert.equal(r.M2, ok.expectM2);
  const bad = SRP.clientProof("someone", "wrong", v.salt, 1000, cs, ss.B);
  assert.equal(SRP.serverVerify(ss, cs.A, bad.M1).ok, false);
  assert.throws(() => SRP.clientProof("someone", "right", v.salt, 1000, cs, "00"), /bad server value/);
});

test("the fixed example still comes out the same (Kotlin checks it too)", () => {
  const v = SRP.makeVerifier(V.username, V.password, V.iterations, V.salt);
  assert.equal(v.verifier, V.verifier);
  const cs = SRP.clientStart(V.a), ss = SRP.serverStart(V.verifier, V.b);
  assert.equal(cs.A, V.A);
  assert.equal(ss.B, V.B);
  const p = SRP.clientProof(V.username, V.password, V.salt, V.iterations, cs, V.B);
  assert.equal(p.M1, V.M1);
  assert.equal(p.K, V.K);
  assert.equal(SRP.serverVerify(ss, V.A, V.M1).M2, V.M2);
});
