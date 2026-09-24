package com.musicd.server.client

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * The few calls the native parts of the app make. Everything a person sees in
 * the main window is the server's own page in a WebView; this is only for the
 * lock screen, the notification, the widget and the Quick Settings tile, which
 * have no page to ask.
 *
 * Plain HttpURLConnection, no library: seven GETs and POSTs of small JSON.
 */
class ServerClient(
    val address: ServerAddress,
    private val timeoutMs: Int = 6000,
    /** This phone's sign-in (see [Account]); sent with every request. */
    val token: String? = null
) {

    class ServerException(val status: Int, message: String) : IOException(message) {
        /** Signed out: the account was reset, or this phone was signed out in Settings. */
        val signedOut get() = status == 401
    }

    fun health(): Health = Health.parse(getJson("/api/health"))

    fun zones(): Zones = Zones.parse(getJson("/api/shortcut/zones"))

    /**
     * The zone's state. With [waitFor] the server holds the request until
     * something changes (or ~20 s pass), which is how the notification follows
     * the speaker without polling.
     */
    fun zoneState(zoneId: String, waitFor: Long? = null): ZoneState {
        val q = StringBuilder("/api/zone-state?zone=").append(enc(zoneId))
        var timeout = timeoutMs
        if (waitFor != null) {
            q.append("&wait_for=").append(waitFor).append("&timeout=20000")
            timeout = 30_000
        }
        return ZoneState.parse(getJson(q.toString(), timeout))
    }

    fun control(zoneId: String, command: String) {
        post("/api/control", JSONObject().put("zone_or_output_id", zoneId).put("command", command))
    }

    fun volumeRelative(outputId: String, delta: Int) {
        post("/api/volume", JSONObject().put("output_id", outputId).put("how", "relative").put("value", delta))
    }

    fun volumeAbsolute(outputId: String, value: Int) {
        post("/api/volume", JSONObject().put("output_id", outputId).put("how", "absolute").put("value", value))
    }

    /** A random album in [zoneId] (or the server's own choice of room). Returns the album title. */
    fun playRandom(zoneId: String?): String {
        val path = "/api/shortcut/play-random" + (zoneId?.let { "?zone=" + enc(it) } ?: "")
        val j = getJson(path, 20_000)
        return j.optJSONObject("album")?.optString("title", "") ?: ""
    }

    fun imageUrl(imageKey: String, size: Int): String =
        address.baseUrl + "/api/image/" + enc(imageKey) + "?size=" + size

    fun bytes(url: String): ByteArray {
        val c = open(url, timeoutMs)
        try {
            if (c.responseCode != 200) throw ServerException(c.responseCode, "HTTP ${c.responseCode}")
            return c.inputStream.use { it.readBytes() }
        } finally {
            c.disconnect()
        }
    }

    // ------------------------------------------------------------------ http

    private fun open(url: String, timeout: Int): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = minOf(timeout, 5000)
            readTimeout = timeout
            useCaches = false
            setRequestProperty("Accept", "application/json")
            if (token != null) setRequestProperty("Authorization", "Bearer $token")
        }

    fun getJson(path: String, timeout: Int = timeoutMs): JSONObject {
        val c = open(address.baseUrl + path, timeout)
        try {
            return readJson(c)
        } finally {
            c.disconnect()
        }
    }

    fun post(path: String, body: JSONObject, timeout: Int = timeoutMs): JSONObject {
        val c = open(address.baseUrl + path, timeout)
        try {
            c.requestMethod = "POST"
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            return readJson(c)
        } finally {
            c.disconnect()
        }
    }

    private fun readJson(c: HttpURLConnection): JSONObject {
        val code = c.responseCode
        val stream = if (code >= 400) c.errorStream else c.inputStream
        val text = stream?.use { s ->
            val out = ByteArrayOutputStream()
            s.copyTo(out)
            out.toString("UTF-8")
        } ?: ""
        val j = try { JSONObject(text) } catch (e: Exception) { null }
        if (code >= 400) {
            throw ServerException(code, j?.optString("error")?.takeIf { it.isNotEmpty() } ?: "HTTP $code")
        }
        return j ?: throw ServerException(code, "The server answered with something that isn't JSON")
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}
