package com.musicd.server.android

import android.content.Context
import com.musicd.server.client.ServerAddress
import com.musicd.server.client.ServerClient

/** The one thing the app has to remember: which server, and the last room. */
object Store {
    private const val PREFS = "musicd"
    private const val KEY_HOST = "host"
    private const val KEY_PORT = "port"
    private const val KEY_ZONE = "zone"

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

    fun lastPort(context: Context): Int =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY_PORT, ServerAddress.DEFAULT_PORT)

    fun zone(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ZONE, null)

    fun setZone(context: Context, zoneId: String?) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_ZONE, zoneId).apply()
    }

    fun client(context: Context): ServerClient? = server(context)?.let { ServerClient(it) }
}
