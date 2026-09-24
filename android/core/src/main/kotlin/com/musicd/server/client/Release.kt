package com.musicd.server.client

import org.json.JSONObject

/**
 * The newest Android app, as GitHub Actions publishes it: dist/latest.json
 * beside the APK on the main branch.
 */
class Release(val version: String, val url: String, val sha256: String) {

    companion object {
        const val LATEST = "https://github.com/meltface-80/MusicD-Server/raw/main/dist/latest.json"

        fun parse(j: JSONObject): Release? {
            val v = j.optString("version").trim()
            val u = j.optString("url").trim()
            if (v.isEmpty() || !u.startsWith("https://")) return null
            return Release(v, u, j.optString("sha256").trim().lowercase())
        }

        /** Numbers compared part by part: 0.3.10 is newer than 0.3.9. */
        fun compare(a: String, b: String): Int {
            val x = a.trim().removePrefix("v").split('.', '-').map { it.toIntOrNull() ?: 0 }
            val y = b.trim().removePrefix("v").split('.', '-').map { it.toIntOrNull() ?: 0 }
            for (i in 0 until maxOf(x.size, y.size)) {
                val d = (x.getOrElse(i) { 0 }).compareTo(y.getOrElse(i) { 0 })
                if (d != 0) return d
            }
            return 0
        }
    }

    fun newerThan(installed: String) = compare(version, installed) > 0
}
