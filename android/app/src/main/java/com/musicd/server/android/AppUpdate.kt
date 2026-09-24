package com.musicd.server.android

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import androidx.core.content.FileProvider
import com.musicd.server.client.Release
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * The app keeps itself up to date: it looks at the APK GitHub Actions
 * publishes (dist/latest.json on main), and when that's newer than this one
 * it offers to fetch it and install it over the top — the same signing key
 * every time, so nothing is uninstalled and downloads stay on the phone.
 *
 * Updating the server (its own in-app updater) doesn't touch the app, so the
 * app looks for itself: when it opens, at most once an hour, and on demand
 * from Settings → System.
 */
object AppUpdate {
    private const val TAG = "AppUpdate"
    private const val PREFS = "app_update"
    private const val CHECK_EVERY_MS = 60L * 60 * 1000
    private const val SNOOZE_MS = 24L * 60 * 60 * 1000

    private val work = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var busy = false

    /** Look, and offer an update if there is one. [asked]: from the button — always look, always answer. */
    fun check(activity: Activity, asked: Boolean = false) {
        val p = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (busy) return
        if (!asked && now - p.getLong("checked_at", 0) < CHECK_EVERY_MS) return
        busy = true
        work.execute {
            val r = runCatching { latest() }.onFailure { Log.i(TAG, "couldn't look for an update: ${it.message}") }.getOrNull()
            p.edit().putLong("checked_at", now).apply()
            main.post {
                busy = false
                if (activity.isFinishing) return@post
                when {
                    r == null -> if (asked) toast(activity, "Couldn't reach GitHub to look for an update")
                    !r.newerThan(BuildConfig.VERSION_NAME) ->
                        if (asked) toast(activity, "MusicD is up to date (v${BuildConfig.VERSION_NAME})")
                    !asked && p.getString("snoozed", null) == r.version && now - p.getLong("snoozed_at", 0) < SNOOZE_MS -> {}
                    else -> offer(activity, r)
                }
            }
        }
    }

    private fun offer(activity: Activity, r: Release) {
        AlertDialog.Builder(activity)
            .setTitle("Update MusicD")
            .setMessage("Version ${r.version} of the app is available (this is ${BuildConfig.VERSION_NAME}). " +
                "It installs over this one — your sign-in and downloads stay.")
            .setPositiveButton("Update") { _, _ -> download(activity, r) }
            .setNegativeButton("Later") { _, _ ->
                activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString("snoozed", r.version).putLong("snoozed_at", System.currentTimeMillis()).apply()
            }
            .show()
    }

    private fun apkFile(c: Context, r: Release) = File(File(c.cacheDir, "updates").apply { mkdirs() }, "musicd-${r.version}.apk")

    private fun download(activity: Activity, r: Release) {
        val dest = apkFile(activity, r)
        if (dest.exists() && (r.sha256.isEmpty() || sha256(dest) == r.sha256)) { install(activity, dest); return }
        val progress = AlertDialog.Builder(activity)
            .setTitle("Updating MusicD")
            .setMessage("Downloading version ${r.version}…")
            .setCancelable(false)
            .show()
        busy = true
        work.execute {
            val result = runCatching {
                // Only the newest one is kept.
                dest.parentFile?.listFiles()?.forEach { if (it != dest) it.delete() }
                fetch(r.url, dest) { pct -> main.post { progress.setMessage("Downloading version ${r.version}… $pct%") } }
                if (r.sha256.isNotEmpty() && sha256(dest) != r.sha256) {
                    dest.delete()
                    throw IOException("the download was damaged — try again")
                }
            }
            main.post {
                busy = false
                runCatching { progress.dismiss() }
                if (activity.isFinishing) return@post
                result.onSuccess { install(activity, dest) }
                    .onFailure { toast(activity, "Couldn't download the update: ${it.message}") }
            }
        }
    }

    /** Hand the APK to Android's installer — which asks, once, to allow installs from MusicD. */
    private fun install(activity: Activity, apk: File) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
            AlertDialog.Builder(activity)
                .setTitle("Allow MusicD to install updates")
                .setMessage("Android asks once: turn on \"Allow from this source\" for MusicD, come back, and tap Update again.")
                .setPositiveButton("Open settings") { _, _ ->
                    runCatching {
                        activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
                    }
                }
                .setNegativeButton("Cancel", null)
                .show()
            // Asked again when the app is back in front.
            activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong("checked_at", 0).remove("snoozed").apply()
            return
        }
        val uri = FileProvider.getUriForFile(activity, activity.packageName + ".shares", apk)
        runCatching {
            activity.startActivity(Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure { toast(activity, "Couldn't open the installer: ${it.message}") }
    }

    private fun latest(): Release? {
        val c = open(Release.LATEST)
        try {
            if (c.responseCode != 200) throw IOException("HTTP ${c.responseCode}")
            return Release.parse(JSONObject(c.inputStream.bufferedReader().readText()))
        } finally {
            c.disconnect()
        }
    }

    private fun fetch(url: String, dest: File, onProgress: (Int) -> Unit) {
        val c = open(url, readTimeout = 60_000)
        try {
            if (c.responseCode != 200) throw IOException("HTTP ${c.responseCode}")
            val total = c.contentLengthLong
            var got = 0L
            var shown = -1
            c.inputStream.use { input ->
                FileOutputStream(dest).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        got += n
                        if (total > 0) {
                            val pct = (got * 100 / total).toInt()
                            if (pct != shown) { shown = pct; onProgress(pct) }
                        }
                    }
                }
            }
        } finally {
            c.disconnect()
        }
    }

    /** GitHub answers raw/… with a redirect to its file host, which HttpURLConnection follows (https → https). */
    private fun open(url: String, readTimeout: Int = 15_000): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            this.readTimeout = readTimeout
            instanceFollowRedirects = true
            useCaches = false
            setRequestProperty("User-Agent", "MusicDAndroid/${BuildConfig.VERSION_NAME}")
        }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { s ->
            val buf = ByteArray(64 * 1024)
            while (true) { val n = s.read(buf); if (n < 0) break; md.update(buf, 0, n) }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun toast(c: Context, s: String) = Toast.makeText(c, s, Toast.LENGTH_LONG).show()
}
