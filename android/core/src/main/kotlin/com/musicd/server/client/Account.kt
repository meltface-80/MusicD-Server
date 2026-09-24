package com.musicd.server.client

import org.json.JSONObject

/**
 * The server's one account, from the phone: create it on first run, or sign
 * in. Either way the password never leaves the phone — [Srp] proves it — and
 * the server has to prove it knows the account too, so a sign-in to anything
 * but your own server fails. The result is this phone's own token, which the
 * server can sign out from Settings.
 */
class Account(private val client: ServerClient) {

    class Status(val setupRequired: Boolean, val canSetup: Boolean, val signedIn: Boolean, val username: String?)

    class Session(val token: String, val username: String)

    class AuthException(message: String) : Exception(message)

    fun status(): Status {
        val j = client.getJson("/api/auth/status")
        return Status(
            setupRequired = j.optBoolean("setup_required"),
            canSetup = j.optBoolean("can_setup"),
            signedIn = j.optBoolean("signed_in"),
            username = j.optString("username").takeIf { it.isNotEmpty() && !j.isNull("username") }
        )
    }

    /** First run: make the account (home network only) and sign this phone in. */
    fun create(username: String, password: String, deviceName: String, iterations: Int = Srp.ITERATIONS): Session {
        val v = Srp.makeVerifier(username, password, iterations)
        val j = call("/api/auth/setup", JSONObject()
            .put("username", username).put("salt", v.salt).put("verifier", v.verifier)
            .put("iterations", iterations).put("want_token", true)
            .put("kind", "android").put("device_name", deviceName))
        return Session(j.getString("token"), j.optString("username", Srp.normUser(username)))
    }

    fun signIn(username: String, password: String, deviceName: String): Session {
        val ch = call("/api/auth/challenge", JSONObject().put("username", username))
        val start = Srp.clientStart()
        val proof = try {
            Srp.clientProof(username, password, ch.getString("salt"), ch.getInt("iterations"), start, ch.getString("B"))
        } catch (e: IllegalArgumentException) {
            throw AuthException("That server gave an answer no MusicD Server would — not signing in.")
        }
        val j = call("/api/auth/verify", JSONObject()
            .put("id", ch.getString("id")).put("A", start.A).put("M1", proof.M1)
            .put("want_token", true).put("kind", "android").put("device_name", deviceName))
        if (j.optString("M2") != proof.expectM2) {
            throw AuthException("That server couldn't prove it's yours — not signing in.")
        }
        return Session(j.getString("token"), j.optString("username", Srp.normUser(username)))
    }

    fun signOut() {
        runCatching { client.post("/api/auth/logout", JSONObject()) }
    }

    private fun call(path: String, body: JSONObject): JSONObject = try {
        client.post(path, body, 20_000)
    } catch (e: ServerClient.ServerException) {
        throw AuthException(e.message ?: "HTTP ${e.status}")
    }
}
