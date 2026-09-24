/*
 * srp.js — signing in without the password ever crossing the network.
 *
 * SRP-6a (RFC 5054's 2048-bit group, SHA-256): the device and the server each
 * prove they know the account, and neither sends the password. A fake server
 * can't complete it either, because it can't produce the server's proof
 * without the verifier made at account creation.
 *
 * The same file runs in the browser (the sign-in page), in Node (the server
 * and its tests) and is mirrored in Kotlin (android/core Srp.kt) — they must
 * agree to the byte, which test/srp.test.js checks against a fixed vector.
 *
 * Everything is written out by hand, SHA-256 included: the page is usually
 * served over plain http on the home network, where browsers withhold
 * crypto.subtle.
 *
 * The password is stretched with PBKDF2-HMAC-SHA256 (iterations stored per
 * account) before it goes into SRP, so a copy of the server's database can't
 * be guessed against cheaply.
 *
 *   x = H(salt | H(username | ":" | PBKDF2(password, salt, iterations, 32)))
 *   v = g^x                          (stored by the server, with salt)
 *   A = g^a            B = k·v + g^b     k = H(N | PAD(g))
 *   u = H(PAD(A) | PAD(B))
 *   S = (B − k·g^x)^(a + u·x)  =  (A·v^u)^b
 *   K = H(PAD(S))   M1 = H(PAD(A) | PAD(B) | K)   M2 = H(PAD(A) | M1 | K)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MusicdSrp = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ------------------------------------------------------------- SHA-256
  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const W = new Uint32Array(64);

  // One 64-byte block into the state (8 words), in place.
  function compress(st, buf, off) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      W[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = st[0], b = st[1], c = st[2], d = st[3], e = st[4], f = st[5], g = st[6], h = st[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    st[0] = (st[0] + a) | 0; st[1] = (st[1] + b) | 0; st[2] = (st[2] + c) | 0; st[3] = (st[3] + d) | 0;
    st[4] = (st[4] + e) | 0; st[5] = (st[5] + f) | 0; st[6] = (st[6] + g) | 0; st[7] = (st[7] + h) | 0;
  }

  function stateBytes(st) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = st[i] >>> 24; out[i * 4 + 1] = st[i] >>> 16; out[i * 4 + 2] = st[i] >>> 8; out[i * 4 + 3] = st[i];
    }
    return out;
  }

  // SHA-256 of `msg`, continuing from `st` after `already` bytes were hashed.
  function finish(st, msg, already) {
    const len = msg.length, total = already + len;
    const padLen = ((len + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(padLen);
    buf.set(msg);
    buf[len] = 0x80;
    const bits = total * 8;
    const hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
    buf[padLen - 8] = hi >>> 24; buf[padLen - 7] = hi >>> 16; buf[padLen - 6] = hi >>> 8; buf[padLen - 5] = hi;
    buf[padLen - 4] = lo >>> 24; buf[padLen - 3] = lo >>> 16; buf[padLen - 2] = lo >>> 8; buf[padLen - 1] = lo;
    for (let off = 0; off < padLen; off += 64) compress(st, buf, off);
    return stateBytes(st);
  }

  function sha256(bytes) {
    return finish(Int32Array.from(IV), toBytes(bytes), 0);
  }

  // ------------------------------------------------------ HMAC and PBKDF2

  function hmacKeyStates(key) {
    let k = toBytes(key);
    if (k.length > 64) k = sha256(k);
    const ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) { ipad[i] = (k[i] || 0) ^ 0x36; opad[i] = (k[i] || 0) ^ 0x5c; }
    const inner = Int32Array.from(IV), outer = Int32Array.from(IV);
    compress(inner, ipad, 0);
    compress(outer, opad, 0);
    return { inner, outer };
  }

  function hmacWith(states, msg) {
    const ih = finish(Int32Array.from(states.inner), toBytes(msg), 64);
    return finish(Int32Array.from(states.outer), ih, 64);
  }

  function hmacSha256(key, msg) { return hmacWith(hmacKeyStates(key), msg); }

  // PBKDF2-HMAC-SHA256, one 32-byte block (all SRP needs).
  function pbkdf2(password, salt, iterations) {
    const states = hmacKeyStates(password);
    const s = toBytes(salt);
    const first = new Uint8Array(s.length + 4);
    first.set(s);
    first[s.length + 3] = 1;
    let u = hmacWith(states, first);
    const out = u.slice();
    for (let i = 1; i < iterations; i++) {
      u = hmacWith(states, u);
      for (let j = 0; j < 32; j++) out[j] ^= u[j];
    }
    return out;
  }

  // ------------------------------------------------------------- helpers

  function utf8(s) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
    return Uint8Array.from(Buffer.from(s, "utf8"));
  }
  function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (typeof x === "string") return utf8(x);
    if (Array.isArray(x)) return Uint8Array.from(x);
    if (x && x.buffer) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    throw new TypeError("bytes expected");
  }
  function concat() {
    const parts = Array.prototype.map.call(arguments, toBytes);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function toHex(b) {
    let s = "";
    for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }
  function fromHex(h) {
    const s = String(h).replace(/^0x/, "");
    if (!/^[0-9a-f]*$/i.test(s) || s.length % 2) throw new Error("bad hex");
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }
  function bytesToBig(b) { const h = toHex(b); return h ? BigInt("0x" + h) : 0n; }
  function bigToBytes(n, len) {
    let h = n.toString(16);
    if (h.length % 2) h = "0" + h;
    let b = fromHex(h);
    if (len && b.length < len) { const p = new Uint8Array(len); p.set(b, len - b.length); b = p; }
    return b;
  }
  function modPow(base, exp, mod) {
    let r = 1n, b = base % mod, e = exp;
    while (e > 0n) {
      if (e & 1n) r = (r * b) % mod;
      e >>= 1n;
      b = (b * b) % mod;
    }
    return r;
  }
  function randomBytes(n) {
    const out = new Uint8Array(n);
    const c = (typeof crypto !== "undefined" && crypto.getRandomValues) ? crypto : null;
    if (c) { c.getRandomValues(out); return out; }
    return Uint8Array.from(require("crypto").randomBytes(n));
  }

  // --------------------------------------------------------------- SRP-6a

  // RFC 5054, 2048-bit group.
  const N = BigInt("0x" +
    "AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310D" +
    "CD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF74" +
    "7359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D" +
    "5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB6" +
    "94B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73");
  const g = 2n;
  const NLEN = 256;
  const PAD = n => bigToBytes(n, NLEN);
  const H = function () { return sha256(concat.apply(null, arguments)); };
  const k = bytesToBig(H(PAD(N), PAD(g)));

  function normUser(username) { return String(username || "").trim().toLowerCase(); }

  function privateKey(username, password, saltHex, iterations) {
    const salt = fromHex(saltHex);
    const stretched = pbkdf2(utf8(String(password)), salt, iterations);
    return bytesToBig(H(salt, H(utf8(normUser(username)), utf8(":"), stretched)));
  }

  /* Account creation, on the device: → { salt, verifier } (hex). */
  function makeVerifier(username, password, iterations, saltHex) {
    const salt = saltHex || toHex(randomBytes(16));
    const x = privateKey(username, password, salt, iterations);
    return { salt, verifier: toHex(PAD(modPow(g, x, N))) };
  }

  /* The device's half. a is random unless given (tests). */
  function clientStart(aHex) {
    const a = aHex ? BigInt("0x" + aHex) : bytesToBig(randomBytes(32));
    const A = modPow(g, a, N);
    return { a, A: toHex(PAD(A)) };
  }

  /* With the server's salt/B: → { M1, expectM2, K } (hex). Throws on a bad B. */
  function clientProof(username, password, saltHex, iterations, start, BHex) {
    const B = BigInt("0x" + BHex);
    if (B % N === 0n) throw new Error("bad server value");
    const A = BigInt("0x" + start.A);
    const u = bytesToBig(H(PAD(A), PAD(B)));
    if (u === 0n) throw new Error("bad server value");
    const x = privateKey(username, password, saltHex, iterations);
    const base = ((B - (k * modPow(g, x, N)) % N) + N) % N;
    const S = modPow(base, start.a + u * x, N);
    const K = H(PAD(S));
    const M1 = H(PAD(A), PAD(B), K);
    const M2 = H(PAD(A), M1, K);
    return { M1: toHex(M1), expectM2: toHex(M2), K: toHex(K) };
  }

  /* The server's half, from the stored verifier. b is random unless given. */
  function serverStart(verifierHex, bHex) {
    const v = BigInt("0x" + verifierHex);
    const b = bHex ? BigInt("0x" + bHex) : bytesToBig(randomBytes(32));
    const B = (k * v + modPow(g, b, N)) % N;
    return { b, v, B: toHex(PAD(B)) };
  }

  /* Check the device's proof: → { ok, M2, K }. */
  function serverVerify(start, AHex, M1Hex) {
    const A = BigInt("0x" + AHex);
    if (A % N === 0n) return { ok: false };
    const B = BigInt("0x" + start.B);
    const u = bytesToBig(H(PAD(A), PAD(B)));
    if (u === 0n) return { ok: false };
    const S = modPow((A * modPow(start.v, u, N)) % N, start.b, N);
    const K = H(PAD(S));
    const M1 = toHex(H(PAD(A), PAD(B), K));
    if (!timingSafeEqualHex(M1, String(M1Hex || "").toLowerCase())) return { ok: false };
    return { ok: true, M2: toHex(H(PAD(A), fromHex(M1), K)), K: toHex(K) };
  }

  function timingSafeEqualHex(a, b) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
  }

  return {
    ITERATIONS: 100000,
    sha256, hmacSha256, pbkdf2, toHex, fromHex, normUser,
    makeVerifier, clientStart, clientProof, serverStart, serverVerify
  };
});
