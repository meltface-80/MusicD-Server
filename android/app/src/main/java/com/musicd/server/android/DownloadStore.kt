package com.musicd.server.android

import android.content.Context
import android.os.Environment
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Albums kept on this phone, and the settings for keeping them.
 *
 * Each album is a folder named by its id — album.json (the album, its tracks
 * and how far the download has got), cover.jpg, and one file per track —
 * in the app's own storage on the phone or on an SD card. Those folders need
 * no storage permission; the catch is that Android deletes them if the app is
 * uninstalled (updates are fine).
 */
object DownloadStore {
    private const val PREFS = "downloads"

    const val QUALITY_ORIGINAL = "original"
    const val QUALITY_OPUS = "opus"

    // ------------------------------------------------------------ settings

    class Settings(val quality: String, val location: String, val wifiOnly: Boolean, val limitGb: Int)

    fun settings(c: Context): Settings {
        val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return Settings(
            quality = p.getString("quality", QUALITY_ORIGINAL) ?: QUALITY_ORIGINAL,
            location = p.getString("location", "phone") ?: "phone",
            wifiOnly = p.getBoolean("wifi_only", true),
            limitGb = p.getInt("limit_gb", 0)
        )
    }

    fun setQuality(c: Context, q: String) = edit(c) { putString("quality", q) }
    fun setLocation(c: Context, l: String) = edit(c) { putString("location", l) }
    fun setWifiOnly(c: Context, on: Boolean) = edit(c) { putBoolean("wifi_only", on) }
    fun setLimitGb(c: Context, gb: Int) = edit(c) { putInt("limit_gb", gb) }

    private fun edit(c: Context, f: android.content.SharedPreferences.Editor.() -> Unit) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply(f).apply()
    }

    // ------------------------------------------------------------ places

    class Place(val id: String, val label: String, val dir: File) {
        val freeBytes: Long get() = runCatching { dir.usableSpace }.getOrDefault(0L)
    }

    /** Phone storage, then an SD card if there is one. */
    fun places(c: Context): List<Place> {
        val dirs = c.getExternalFilesDirs("music").filterNotNull()
        val out = ArrayList<Place>()
        dirs.forEachIndexed { i, d ->
            val removable = i > 0 && runCatching { Environment.isExternalStorageRemovable(d) }.getOrDefault(true)
            if (i == 0) out += Place("phone", "Phone storage", d)
            else if (removable && out.none { it.id == "sd" }) out += Place("sd", "SD card", d)
        }
        if (out.isEmpty()) out += Place("phone", "Phone storage", File(c.filesDir, "music"))
        out.forEach { it.dir.mkdirs() }
        return out
    }

    /** Where a new download goes: the chosen place, or phone storage if the card is gone. */
    fun target(c: Context): Place {
        val all = places(c)
        return all.firstOrNull { it.id == settings(c).location } ?: all.first()
    }

    // ------------------------------------------------------------ albums

    class Track(
        val id: Long, val title: String, val artist: String, val disc: Int, val number: Int?,
        val duration: Double, val ext: String, val size: Long, var done: Boolean
    ) {
        fun fileName() = "$id.$ext"
    }

    class Album(
        val id: Int, var title: String, var artist: String, var year: Int?, val quality: String,
        var imageKey: String?, var state: String, var error: String?, val tracks: List<Track>, val addedAt: Long
    ) {
        val doneCount get() = tracks.count { it.done }
        val totalBytes get() = tracks.sumOf { it.size }
    }

    fun dirOf(c: Context, id: Int): File? =
        places(c).map { File(it.dir, id.toString()) }.firstOrNull { File(it, "album.json").exists() }

    fun albums(c: Context): List<Pair<Album, File>> =
        places(c).flatMap { p -> p.dir.listFiles()?.toList() ?: emptyList() }
            .filter { File(it, "album.json").exists() }
            .mapNotNull { d -> load(d)?.let { it to d } }
            .sortedByDescending { it.first.addedAt }

    fun album(c: Context, id: Int): Album? = dirOf(c, id)?.let { load(it) }

    fun load(dir: File): Album? = runCatching {
        val j = JSONObject(File(dir, "album.json").readText())
        val tracks = j.optJSONArray("tracks") ?: JSONArray()
        Album(
            id = j.getInt("id"), title = j.optString("title"), artist = j.optString("artist"),
            year = if (j.isNull("year") || !j.has("year")) null else j.optInt("year"),
            quality = j.optString("quality", QUALITY_ORIGINAL),
            imageKey = j.optString("image_key").takeIf { it.isNotEmpty() },
            state = j.optString("state", "queued"),
            error = j.optString("error").takeIf { it.isNotEmpty() },
            tracks = (0 until tracks.length()).map { i ->
                val t = tracks.getJSONObject(i)
                Track(
                    t.getLong("id"), t.optString("title"), t.optString("artist"), t.optInt("disc_no", 1),
                    if (t.isNull("track_no") || !t.has("track_no")) null else t.optInt("track_no"),
                    t.optDouble("duration", 0.0), t.optString("ext", "flac"), t.optLong("size"), t.optBoolean("done")
                )
            },
            addedAt = j.optLong("added_at")
        )
    }.getOrNull()

    fun save(dir: File, a: Album) {
        val tracks = JSONArray()
        for (t in a.tracks) tracks.put(JSONObject()
            .put("id", t.id).put("title", t.title).put("artist", t.artist).put("disc_no", t.disc)
            .put("track_no", t.number ?: JSONObject.NULL).put("duration", t.duration).put("ext", t.ext)
            .put("size", t.size).put("done", t.done))
        val j = JSONObject()
            .put("id", a.id).put("title", a.title).put("artist", a.artist).put("year", a.year ?: JSONObject.NULL)
            .put("quality", a.quality).put("image_key", a.imageKey ?: "").put("state", a.state)
            .put("error", a.error ?: "").put("tracks", tracks).put("added_at", a.addedAt)
        dir.mkdirs()
        val tmp = File(dir, "album.json.tmp")
        tmp.writeText(j.toString())
        tmp.renameTo(File(dir, "album.json"))
        index = null
    }

    fun remove(c: Context, id: Int) {
        DownloadWorker.cancel(c, id)
        dirOf(c, id)?.deleteRecursively()
        index = null
    }

    fun usedBytes(c: Context): Long =
        places(c).sumOf { p -> p.dir.walkTopDown().filter { it.isFile }.sumOf { it.length() } }

    /** What the album page shows for an album: state and progress. */
    fun status(c: Context, id: Int): JSONObject {
        val a = album(c, id) ?: return JSONObject().put("state", "none")
        return JSONObject().put("state", a.state).put("done", a.doneCount).put("total", a.tracks.size)
            .put("error", a.error ?: "").put("quality", a.quality)
    }

    // ------------------------------------------------------------ tracks

    @Volatile private var index: Map<Long, File>? = null

    /** The downloaded file for a library track, if it's on the phone. */
    fun trackFile(c: Context, trackId: Long?): File? {
        if (trackId == null) return null
        val idx = index ?: buildIndex(c).also { index = it }
        return idx[trackId]?.takeIf { it.exists() }
    }

    private fun buildIndex(c: Context): Map<Long, File> {
        val m = HashMap<Long, File>()
        for ((a, dir) in albums(c)) for (t in a.tracks) if (t.done) m[t.id] = File(dir, t.fileName())
        return m
    }

    // ------------------------------------------------------------ offline plays

    /** Plays made with no server, kept until they can be sent. */
    fun addPlay(c: Context, trackId: Long) {
        val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val a = runCatching { JSONArray(p.getString("plays", "[]")) }.getOrDefault(JSONArray())
        if (a.length() < 5000) a.put(JSONObject().put("track_id", trackId).put("ts", System.currentTimeMillis()))
        p.edit().putString("plays", a.toString()).apply()
    }

    fun pendingPlays(c: Context): JSONArray =
        runCatching { JSONArray(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("plays", "[]")) }
            .getOrDefault(JSONArray())

    fun clearPlays(c: Context, sent: Int) {
        val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val a = pendingPlays(c)
        val rest = JSONArray()
        for (i in sent until a.length()) rest.put(a.get(i))
        p.edit().putString("plays", rest.toString()).apply()
    }
}
