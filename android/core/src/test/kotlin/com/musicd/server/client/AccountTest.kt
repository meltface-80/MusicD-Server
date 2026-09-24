package com.musicd.server.client

import com.sun.net.httpserver.HttpServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.net.InetSocketAddress

/** Account against a small stand-in for the server's /api/auth endpoints. */
class AccountTest {
    private lateinit var http: HttpServer
    private var salt = ""
    private var verifier = ""
    private var iterations = 0
    private var pending: Srp.ServerStart? = null
    private var lieAboutProof = false
    private var lastAuth: String? = null

    @Before fun start() {
        http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        http.createContext("/") { ex ->
            lastAuth = ex.requestHeaders.getFirst("Authorization")
            val body = ex.requestBody.readBytes().toString(Charsets.UTF_8).let { if (it.isEmpty()) JSONObject() else JSONObject(it) }
            val out: JSONObject = when (ex.requestURI.path) {
                "/api/auth/status" -> JSONObject().put("setup_required", verifier.isEmpty()).put("can_setup", true).put("signed_in", false)
                "/api/auth/setup" -> {
                    salt = body.getString("salt"); verifier = body.getString("verifier"); iterations = body.getInt("iterations")
                    JSONObject().put("ok", true).put("token", "tok-setup").put("username", body.getString("username").lowercase())
                }
                "/api/auth/challenge" -> {
                    val s = Srp.serverStart(verifier); pending = s
                    JSONObject().put("id", "c1").put("salt", salt).put("iterations", iterations).put("B", s.B)
                }
                "/api/auth/verify" -> {
                    val r = Srp.serverVerify(pending!!, body.getString("A"), body.getString("M1"))
                    if (!r.ok) {
                        val b = """{"error":"Wrong username or password"}""".toByteArray()
                        ex.sendResponseHeaders(401, b.size.toLong()); ex.responseBody.use { it.write(b) }; return@createContext
                    }
                    JSONObject().put("ok", true).put("M2", if (lieAboutProof) "00" else r.M2).put("token", "tok-signin").put("username", "lewis")
                }
                else -> JSONObject().put("ok", true)
            }
            val b = out.toString().toByteArray()
            ex.responseHeaders.add("Content-Type", "application/json")
            ex.sendResponseHeaders(200, b.size.toLong())
            ex.responseBody.use { it.write(b) }
        }
        http.start()
    }

    @After fun stop() = http.stop(0)

    private fun client(token: String? = null) = ServerClient(ServerAddress("127.0.0.1", http.address.port), 5000, token)

    @Test fun `creates the account, then signs in with the password`() {
        val acct = Account(client())
        assertTrue(acct.status().setupRequired)
        assertEquals("tok-setup", acct.create("Lewis", "long password", "Pixel", iterations = 1000).token)
        assertTrue(verifier.isNotEmpty())
        assertEquals("tok-signin", acct.signIn("lewis", "long password", "Pixel").token)
    }

    @Test fun `a wrong password is refused`() {
        Account(client()).create("Lewis", "long password", "Pixel", iterations = 1000)
        try {
            Account(client()).signIn("lewis", "nope", "Pixel")
            fail("signed in with the wrong password")
        } catch (e: Account.AuthException) {
            assertEquals("Wrong username or password", e.message)
        }
    }

    @Test fun `a server that can't prove it knows the account is refused`() {
        Account(client()).create("Lewis", "long password", "Pixel", iterations = 1000)
        lieAboutProof = true
        try {
            Account(client()).signIn("lewis", "long password", "Pixel")
            fail("trusted a server that couldn't prove itself")
        } catch (e: Account.AuthException) {
            assertTrue(e.message!!.contains("prove"))
        }
    }

    @Test fun `the token goes with every request`() {
        client("abc").getJson("/api/status")
        assertEquals("Bearer abc", lastAuth)
    }
}
