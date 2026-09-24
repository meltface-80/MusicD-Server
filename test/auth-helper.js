"use strict";
/*
 * Signing in from the tests, the way a device does: the account made with a
 * verifier, then SRP. Iterations are kept low so the tests stay quick.
 */
const SRP = require("../public/srp");

const USER = "tester", PASS = "correct horse battery staple", ITER = 1000;

async function post(base, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return Object.assign({ status: r.status }, j);
}

/* Create the account (or sign in if it exists) → a bearer token. */
async function signIn(base, { username = USER, password = PASS, iterations = ITER, create = true } = {}) {
  const st = await fetch(base + "/api/auth/status").then(r => r.json());
  if (st.setup_required) {
    if (!create) throw new Error("no account");
    const v = SRP.makeVerifier(username, password, iterations);
    const r = await post(base, "/api/auth/setup", { username, salt: v.salt, verifier: v.verifier, iterations, want_token: true, kind: "android", device_name: "test" });
    if (!r.token) throw new Error("setup failed: " + JSON.stringify(r));
    return r.token;
  }
  const ch = await post(base, "/api/auth/challenge", { username });
  const start = SRP.clientStart();
  const proof = SRP.clientProof(username, password, ch.salt, ch.iterations, start, ch.B);
  const r = await post(base, "/api/auth/verify", { id: ch.id, A: start.A, M1: proof.M1, want_token: true, kind: "android", device_name: "test" });
  if (!r.token) throw new Error("sign in failed: " + JSON.stringify(r));
  if (r.M2 !== proof.expectM2) throw new Error("server proof wrong");
  return r.token;
}

module.exports = { signIn, post, USER, PASS, ITER };
