package com.musicd.server.android

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.webkit.JavascriptInterface
import android.widget.Toast
import org.json.JSONArray

/**
 * What the server's page can ask of the app about downloads — only inside
 * this app; the page offers nothing when the bridge isn't there, so browsers
 * and the iPhone home-screen app are unchanged.
 *
 *   MusicdDownloads.status(albumId)   → {"state": none|queued|downloading|waiting|done|failed, …}
 *   MusicdDownloads.download(albumId, title, artist)   asks Original / Opus 256, then queues it
 *   MusicdDownloads.remove(albumId)   asks, then deletes it from the phone
 *   MusicdDownloads.open()            the Downloads screen
 *   MusicdDownloads.ids()             albums fully on the phone, as a JSON array
 *   MusicdDownloads.all()             every album on the phone or on its way:
 *                                     [{"id", "state", "done", "total"}, …], newest first
 *
 * And the other way: whenever a download starts, moves on, finishes or is
 * removed, the app calls window.__musicdDownloadsChanged() on the page
 * (MainActivity), so what it shows follows along without a reload.
 */
class DownloadsBridge(private val activity: Activity) {

    companion object { const val NAME = "MusicdDownloads" }

    @JavascriptInterface
    fun status(albumId: Int): String = DownloadStore.status(activity, albumId).toString()

    @JavascriptInterface
    fun ids(): String {
        val a = JSONArray()
        for ((album, _) in DownloadStore.albums(activity)) if (album.state == "done") a.put(album.id)
        return a.toString()
    }

    @JavascriptInterface
    fun all(): String {
        val a = JSONArray()
        for ((album, _) in DownloadStore.albums(activity)) {
            a.put(org.json.JSONObject().put("id", album.id).put("state", album.state)
                .put("done", album.doneCount).put("total", album.tracks.size))
        }
        return a.toString()
    }

    @JavascriptInterface
    fun download(albumId: Int, title: String, artist: String) {
        activity.runOnUiThread { askQuality(albumId, title, artist) }
    }

    @JavascriptInterface
    fun remove(albumId: Int) {
        activity.runOnUiThread {
            val a = DownloadStore.album(activity, albumId) ?: return@runOnUiThread
            AlertDialog.Builder(activity)
                .setTitle("Remove from this phone?")
                .setMessage("${a.title} — ${a.artist}\n\nIt stays in your library on the server.")
                .setPositiveButton("Remove") { _, _ ->
                    DownloadStore.remove(activity, albumId)
                    Toast.makeText(activity, "Removed from this phone", Toast.LENGTH_SHORT).show()
                }
                .setNegativeButton("Cancel", null)
                .show()
        }
    }

    @JavascriptInterface
    fun open() {
        activity.runOnUiThread { activity.startActivity(Intent(activity, DownloadsActivity::class.java)) }
    }

    private fun askQuality(albumId: Int, title: String, artist: String) {
        val options = arrayOf("Original — the files as they are", "Opus 256 kbps — about a tenth of the size")
        val values = arrayOf(DownloadStore.QUALITY_ORIGINAL, DownloadStore.QUALITY_OPUS)
        var chosen = values.indexOf(DownloadStore.settings(activity).quality).coerceAtLeast(0)
        val s = DownloadStore.settings(activity)
        val where = DownloadStore.target(activity).label + if (s.wifiOnly) " · on Wi-Fi" else ""
        AlertDialog.Builder(activity)
            .setTitle("Download to this phone")
            .setSingleChoiceItems(options, chosen) { _, which -> chosen = which }
            .setPositiveButton("Download") { _, _ ->
                DownloadWorker.enqueue(activity, albumId, values[chosen], title, artist)
                Toast.makeText(activity, "Downloading $title — $where", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }
}
