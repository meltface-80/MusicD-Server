package com.musicd.server.android

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Automatic downloads: the phone keeps today's Smart Picks, the Album of the
 * day and the newest albums by itself (whichever are switched on in the
 * Downloads screen), in the quality chosen there.
 *
 * A few times a day it asks the server for those lists (/api/download/auto),
 * downloads what's new — through the same queue, Wi-Fi rules and size limit
 * as any download — and removes what it downloaded that has since dropped
 * off them. An album you downloaded yourself is never removed.
 */
class AutoDownloads(context: Context, params: WorkerParameters) : Worker(context, params) {

    companion object {
        private const val TAG = "AutoDownloads"
        private const val PERIODIC = "auto-downloads"
        private const val NOW = "auto-downloads-now"

        private fun constraints(c: Context) = Constraints.Builder()
            .setRequiredNetworkType(if (DownloadStore.settings(c).wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .build()

        /** Keep it running every few hours while it's switched on (called when the app opens). */
        fun schedule(c: Context) {
            val wm = WorkManager.getInstance(c)
            if (!DownloadStore.settings(c).autoOn) { wm.cancelUniqueWork(PERIODIC); return }
            wm.enqueueUniquePeriodicWork(
                PERIODIC, ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequest.Builder(AutoDownloads::class.java, 6, TimeUnit.HOURS)
                    .setConstraints(constraints(c)).build()
            )
        }

        /** The settings changed: bring the phone in line now, and keep it so. */
        fun runNow(c: Context) {
            val wm = WorkManager.getInstance(c)
            wm.enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequest.Builder(AutoDownloads::class.java).build())
            wm.cancelUniqueWork(PERIODIC)
            schedule(c)
        }
    }

    override fun doWork(): Result {
        val c = applicationContext
        val s = DownloadStore.settings(c)
        val keep = HashMap<Int, Pair<String, String>>()
        if (s.autoOn) {
            val client = Store.client(c) ?: return Result.retry()
            try {
                val j = client.getJson("/api/download/auto?picks=${if (s.autoPicks) 1 else 0}" +
                    "&aotd=${if (s.autoAotd) 1 else 0}&recent=${s.autoRecent}", 20_000)
                val a = j.getJSONArray("albums")
                for (i in 0 until a.length()) {
                    val o = a.getJSONObject(i)
                    keep[o.getInt("id")] = o.optString("title") to o.optString("artist")
                }
            } catch (e: Exception) {
                Log.i(TAG, "couldn't ask the server: ${e.message}")
                return Result.retry()
            }
        }
        // Let go of what dropped off the lists (only what this downloaded).
        for ((album, _) in DownloadStore.albums(c)) {
            if (album.auto && album.id !in keep) DownloadStore.remove(c, album.id)
        }
        // And fetch what's new.
        for ((id, names) in keep) {
            if (DownloadStore.album(c, id) != null) continue
            DownloadWorker.enqueue(c, id, s.quality, names.first, names.second, auto = true)
        }
        return Result.success()
    }
}
