/*
 * login.js — the sign-in page. Creates the account on first run, or signs in,
 * with SRP (srp.js): the page proves it knows the password and checks the
 * server's proof back, so the password itself is never sent.
 */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const show = id => ["loading", "setup", "notlocal", "signin"].forEach(x => $(x).classList.toggle("hidden", x !== id));

  // Only a path on this server, never somewhere else.
  function nextUrl() {
    const n = new URLSearchParams(location.search).get("next") || "/";
    return /^\/(?!\/)/.test(n) && !n.startsWith("/login") ? n : "/";
  }
  const go = () => location.replace(nextUrl());

  async function post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    return j;
  }

  // Let the button repaint before the password stretching (a second or so) runs.
  const paint = () => new Promise(r => setTimeout(r, 30));

  async function status() {
    show("loading");
    try {
      const s = await (await fetch("/api/auth/status", { credentials: "same-origin", cache: "no-store" })).json();
      if (s.signed_in) return go();
      if (s.setup_required) return show(s.can_setup ? "setup" : "notlocal");
      show("signin");
      $("si-user").focus();
    } catch (e) {
      $("loading").querySelector("p").textContent = "Can't reach MusicD Server. Is the container running?";
      setTimeout(status, 5000);
    }
  }

  $("setup").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("su-err"), btn = $("su-go");
    err.textContent = "";
    const user = $("su-user").value.trim(), p1 = $("su-pass").value, p2 = $("su-pass2").value;
    if (!user) return (err.textContent = "Choose a username.");
    if (p1.length < 8) return (err.textContent = "Use at least 8 characters for the password.");
    if (p1 !== p2) return (err.textContent = "The two passwords don't match.");
    btn.disabled = true; btn.textContent = "Creating…";
    await paint();
    try {
      const v = MusicdSrp.makeVerifier(user, p1, MusicdSrp.ITERATIONS);
      await post("/api/auth/setup", { username: user, salt: v.salt, verifier: v.verifier, iterations: MusicdSrp.ITERATIONS, remember: true });
      go();
    } catch (x) {
      err.textContent = x.message;
      btn.disabled = false; btn.textContent = "Create account";
    }
  });

  $("signin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("si-err"), btn = $("si-go");
    err.textContent = "";
    const user = $("si-user").value.trim(), pass = $("si-pass").value;
    if (!user || !pass) return (err.textContent = "Enter your username and password.");
    btn.disabled = true; btn.textContent = "Signing in…";
    await paint();
    try {
      const ch = await post("/api/auth/challenge", { username: user });
      const start = MusicdSrp.clientStart();
      const proof = MusicdSrp.clientProof(user, pass, ch.salt, ch.iterations, start, ch.B);
      const r = await post("/api/auth/verify", { id: ch.id, A: start.A, M1: proof.M1, remember: $("si-remember").checked });
      // The server has to prove it knows the account too: anything else is not our server.
      if (r.M2 !== proof.expectM2) throw new Error("That server couldn't prove it's yours — not signing in.");
      go();
    } catch (x) {
      err.textContent = x.message;
      btn.disabled = false; btn.textContent = "Sign in";
      $("si-pass").select();
    }
  });

  status();
})();
