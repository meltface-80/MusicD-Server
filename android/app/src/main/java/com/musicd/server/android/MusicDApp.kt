package com.musicd.server.android

import android.app.AlertDialog
import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Build
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

/**
 * The app's process. Its one job: when MusicD crashes, keep what went wrong
 * (the stack trace) so the next start can show it and offer to share it —
 * a crash on a phone otherwise leaves nothing to go on.
 */
class MusicDApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CrashLog.install(this)
    }
}

object CrashLog {
    private fun file(c: Context) = File(c.filesDir, "last-crash.txt")

    fun install(c: Context) {
        val app = c.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            runCatching {
                val sw = StringWriter()
                e.printStackTrace(PrintWriter(sw))
                file(app).writeText(
                    "MusicD ${BuildConfig.VERSION_NAME} · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}) · " +
                        "${Build.MANUFACTURER} ${Build.MODEL}\nThread: ${thread.name}\n\n$sw"
                )
            }
            previous?.uncaughtException(thread, e)
        }
    }

    /** After a crash: say so, once, and offer the details to share. */
    fun offer(activity: Activity) {
        val f = file(activity)
        if (!f.exists()) return
        val text = runCatching { f.readText() }.getOrDefault("")
        f.delete()
        if (text.isBlank()) return
        AlertDialog.Builder(activity)
            .setTitle("MusicD stopped last time")
            .setMessage("Sharing the details helps get it fixed.\n\n" + text.take(1200))
            .setPositiveButton("Share details") { _, _ ->
                runCatching {
                    activity.startActivity(Intent.createChooser(
                        Intent(Intent.ACTION_SEND).setType("text/plain")
                            .putExtra(Intent.EXTRA_SUBJECT, "MusicD crash")
                            .putExtra(Intent.EXTRA_TEXT, text),
                        "Share crash details"))
                }
            }
            .setNegativeButton("Close", null)
            .show()
    }
}
