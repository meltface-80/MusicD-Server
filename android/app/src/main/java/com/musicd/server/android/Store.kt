package com.musicd.server.android

import android.content.Context
import com.musicd.server.client.ServerAddress
import com.musicd.server.client.ServerClient

/**
 * What the app remembers: which server, this phone's sign-in to it, and the
 * last room. The sign-in token is kept per server, in the app's private
 * storage, and is dropped when the server changes.
 *
 * Away from home the same server is reached on its Tailscale address (see
 * [Away]); the sign-in is the same one, so it belongs to the home address.
 */
object Store {
    private const val PREFS = "musicd"
    private const val KEY_HOST = "host"
    private const val KEY_PORT = "port"
    private const val KEY_ZONE = "zone"
    private const val KEY_TOKEN = "token"
    private const val KEY_TOKEN_FOR = "token_for"
    private const val KEY_USER = "username"
    private const val KEY_AWAY_LEARNED = "away_learned"
    private const val KEY_AWAY_TYPED = "away_typed"
    private const val KEY_AWAY_NOW = "away_now"

    fun server(context: Context): ServerAddress? {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val host = p.getString(KEY_HOST, null) ?: return null
        val port = p.getInt(KEY_PORT, ServerAddress.DEFAULT_PORT)
        return ServerAddress(host, port)
    }

    fun setServer(context: Context, address: ServerAddress) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_HOST, address.host)
            .putInt(KEY_PORT, address.port)
            .apply()
    }

    /** This phone's sign-in to the current server, or null. */
    fun token(context: Context): String? {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val server = server(context)?.toString() ?: return null
        return if (p.getString(KEY_TOKEN_FOR, null) == server) p.getString(KEY_TOKEN, null) else null
    }

    fun username(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_USER, null)

    fun setToken(context: Context, token: String?, username: String? = null) {
        val e = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        if (token == null) e.remove(KEY_TOKEN).remove(KEY_TOKEN_FOR)
        else e.putString(KEY_TOKEN, token).putString(KEY_TOKEN_FOR, server(context)?.toString())
        if (username != null) e.putString(KEY_USER, username)
        e.apply()
    }

    fun lastPort(context: Context): Int =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY_PORT, ServerAddress.DEFAULT_PORT)

    fun zone(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ZONE, null)

    fun setZone(context: Context, zoneId: String?) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_ZONE, zoneId).apply()
    }

    // ------------------------------------------------------------ away

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** The server's Tailscale address: typed on the connect screen, else as the server said. */
    fun awayAddress(context: Context): ServerAddress? {
        val p = prefs(context)
        val s = p.getString(KEY_AWAY_TYPED, null) ?: p.getString(KEY_AWAY_LEARNED, null) ?: return null
        return ServerAddress.fromUrl(s)
    }

    fun awayTyped(context: Context): String? = prefs(context).getString(KEY_AWAY_TYPED, null)

    fun setAwayTyped(context: Context, url: String?) {
        prefs(context).edit().apply { if (url.isNullOrBlank()) remove(KEY_AWAY_TYPED) else putString(KEY_AWAY_TYPED, url) }.apply()
    }

    fun setAwayLearned(context: Context, url: String?) {
        if (url == prefs(context).getString(KEY_AWAY_LEARNED, null)) return
        prefs(context).edit().apply { if (url.isNullOrBlank()) remove(KEY_AWAY_LEARNED) else putString(KEY_AWAY_LEARNED, url) }.apply()
    }

    /** Away from home right now (and there's an away address to use). */
    fun isAway(context: Context): Boolean = prefs(context).getBoolean(KEY_AWAY_NOW, false) && awayAddress(context) != null

    fun setAway(context: Context, away: Boolean) {
        prefs(context).edit().putBoolean(KEY_AWAY_NOW, away).apply()
    }

    /** The address to use now: home, or the Tailscale one away. */
    fun active(context: Context): ServerAddress? =
        if (isAway(context)) awayAddress(context) else server(context)

    /** A server address (stream, cover) moved to the address in use now. */
    fun localize(context: Context, url: String): String {
        val home = server(context)?.baseUrl ?: return url
        return com.musicd.server.client.Route.rewrite(url, home, awayAddress(context)?.baseUrl, isAway(context))
    }

    /** A client for the server, signed in — null until both are known. */
    fun client(context: Context): ServerClient? {
        val address = active(context) ?: return null
        val token = token(context) ?: return null
        return ServerClient(address, token = token)
    }
}
