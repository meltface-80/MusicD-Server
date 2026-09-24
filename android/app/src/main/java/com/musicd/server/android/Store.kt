package com.musicd.server.android

import android.content.Context
import com.musicd.server.client.ServerAddress
import com.musicd.server.client.ServerClient

/**
 * What the app remembers: which server, this phone's sign-in to it, and the
 * last room. The sign-in token is kept per server, in the app's private
 * storage, and is dropped when the server changes.
 */
object Store {
    private const val PREFS = "musicd"
    private const val KEY_HOST = "host"
    private const val KEY_PORT = "port"
    private const val KEY_ZONE = "zone"
    private const val KEY_TOKEN = "token"
    private const val KEY_TOKEN_FOR = "token_for"
    private const val KEY_USER = "username"

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

    /** A client for the server, signed in — null until both are known. */
    fun client(context: Context): ServerClient? {
        val address = server(context) ?: return null
        val token = token(context) ?: return null
        return ServerClient(address, token = token)
    }
}
