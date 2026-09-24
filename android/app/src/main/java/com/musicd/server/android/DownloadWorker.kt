package com.musicd.server.android

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Downloads one album: its details, its cover, then each track in turn.
 *
 * Run by WorkManager, so it waits for the network the settings ask for (Wi-Fi
 * only, by default), survives the app being closed, and is retried after a
 * failure. Each track goes to a .part file first and resumes from where it
 * stopped; only a complete file takes the track's real name.
 */
class DownloadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    companion object {
        private const val TAG = "Downloads"
        private const val KEY_ALBUM = "album"
        private const val KEY_QUALITY = "quality"

        private fun workName(id: Int) = "album-$id"

        /** Queue an album. [title]/[artist] show in the list until the details arrive. */
        fun enqueue(c: Context, id: Int, quality: String, title: String, artist: String) {
            val dir = DownloadStore.dirOf(c, id) ?: File(DownloadStore.target(c).dir, id.toString())
            val existing = DownloadStore.load(dir)
            if (existing == null || existing.quality != quality) {
                if (existing != null) dir.deleteRecursively()
                DownloadStore.save(dir, DownloadStore.Album(
                    id, title, artist, null, quality, null, "queued", null, emptyList(), System.currentTimeMillis()
                ))
            } else if (existing.state != "done") {
                existing.state = "queued"; existing.error = null
                DownloadStore.save(dir, existing)
            }
            val s = DownloadStore.settings(c)
            val req = OneTimeWorkRequest.Builder(DownloadWorker::class.java)
                .setInputData(Data.Builder().putInt(KEY_ALBUM, id).putString(KEY_QUALITY, quality).build())
                .setConstraints(Constraints.Builder()
                    .setRequiredNetworkType(if (s.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
                    .build())
                .setBackoffCriteria(BackoffPolicy.LINEAR, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(c).enqueueUniqueWork(workName(id), ExistingWorkPolicy.REPLACE, req)
        }

        fun cancel(c: Context, id: Int) {
            WorkManager.getInstance(c).cancelUniqueWork(workName(id))
        }
    }

    private class Stop(message: String) : Exception(message)

    override fun doWork(): Result {
        val c = applicationContext
        val id = inputData.getInt(KEY_ALBUM, 0)
        val quality = inputData.getString(KEY_QUALITY) ?: DownloadStore.QUALITY_ORIGINAL
        val dir = DownloadStore.dirOf(c, id) ?: return Result.success()     // removed meanwhile
        val server = Store.server(c) ?: return Result.retry()
        val token = Store.token(c) ?: return Result.retry()
        var album = DownloadStore.load(dir) ?: return Result.success()
        return try {
            if (album.tracks.isEmpty()) album = fetchDetails(server.baseUrl, token, id, quality, album, dir)
            album.state = "downloading"; album.error = null
            DownloadStore.save(dir, album)

            // Room for it, within the limit and on the disk.
            val remaining = album.tracks.filter { !it.done }.sumOf { it.size }
            val limit = DownloadStore.settings(c).limitGb.toLong() * 1024L * 1024L * 1024L
            if (limit > 0 && DownloadStore.usedBytes(c) + remaining > limit) {
                throw Stop("Over the ${DownloadStore.settings(c).limitGb} GB limit — remove something or raise the limit")
            }
            if (dir.usableSpace < remaining + 50L * 1024 * 1024) throw Stop("Not enough free space")

            val cover = File(dir, "cover.jpg")
            if (!cover.exists()) runCatching { fetch(server.baseUrl, token, artPath(album), cover) }

            for (t in album.tracks) {
                if (isStopped) return Result.retry()
                if (t.done && File(dir, t.fileName()).exists()) continue
                val path = "/api/download/t${t.id}?quality=$quality"
                fetch(server.baseUrl, token, path, File(dir, t.fileName()))
                t.done = true
                DownloadStore.save(dir, album)
            }
            album.state = "done"
            DownloadStore.save(dir, album)
            Result.success()
        } catch (e: Stop) {
            album.state = "failed"; album.error = e.message
            DownloadStore.save(dir, album)
            Result.failure()
        } catch (e: Exception) {
            Log.i(TAG, "album $id: ${e.message} — will try again")
            album.state = "waiting"; album.error = e.message
            DownloadStore.save(dir, album)
            Result.retry()
        }
    }

    private var artUrl: String? = null
    private fun artPath(a: DownloadStore.Album) = artUrl ?: "/api/image/${a.imageKey}?size=1200"

    private fun fetchDetails(base: String, token: String, id: Int, quality: String, old: DownloadStore.Album, dir: File): DownloadStore.Album {
        val c = open("$base/api/download/album?offset=$id&quality=$quality", token)
        try {
            if (c.responseCode == 404) throw Stop("That album is no longer in the library")
            if (c.responseCode != 200) throw IOException("HTTP ${c.responseCode}")
            val j = JSONObject(c.inputStream.bufferedReader().readText())
            artUrl = j.optString("art_url").takeIf { it.isNotEmpty() }
            val ts = j.getJSONArray("tracks")
            val a = DownloadStore.Album(
                id, j.optString("title", old.title), j.optString("artist", old.artist),
                if (j.isNull("year")) null else j.optInt("year"), quality,
                j.optString("image_key").takeIf { it.isNotEmpty() }, "downloading", null,
                (0 until ts.length()).map { i ->
                    val t = ts.getJSONObject(i)
                    DownloadStore.Track(
                        t.getLong("id"), t.optString("title"), t.optString("artist"), t.optInt("disc_no", 1),
                        if (t.isNull("track_no")) null else t.optInt("track_no"),
                        t.optDouble("duration", 0.0), t.optString("ext", "flac"), t.optLong("size"), false
                    )
                },
                old.addedAt
            )
            DownloadStore.save(dir, a)
            return a
        } finally {
            c.disconnect()
        }
    }

    /** GET to [dest] via a .part file, resuming a partial one. */
    private fun fetch(base: String, token: String, pathOrUrl: String, dest: File) {
        val part = File(dest.parentFile, dest.name + ".part")
        val have = if (part.exists()) part.length() else 0L
        val url = if (pathOrUrl.startsWith("http")) pathOrUrl else base + pathOrUrl
        val c = open(url, token)
        if (have > 0) c.setRequestProperty("Range", "bytes=$have-")
        try {
            val code = c.responseCode
            if (code == 404) throw Stop("A track is no longer in the library — remove this album and download it again")
            if (code != 200 && code != 206) throw IOException("HTTP $code")
            val append = code == 206 && have > 0
            c.inputStream.use { input ->
                FileOutputStream(part, append).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        if (isStopped) throw IOException("stopped")
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                    }
                }
            }
            if (!part.renameTo(dest)) throw IOException("couldn't save ${dest.name}")
        } finally {
            c.disconnect()
        }
    }

    private fun open(url: String, token: String): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 120_000   // a conversion on the server can take a while
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("User-Agent", "MusicDAndroid/${BuildConfig.VERSION_NAME}")
        }
}
