package com.musicd.server.android

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import com.musicd.server.client.ServerClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * Downloads: what's on this phone, and the settings for it — the one screen
 * that works with no server at all. Tap an album to play it here (or pick a
 * track); press and hold to remove it.
 */
class DownloadsActivity : Activity() {

    private val main = Handler(Looper.getMainLooper())
    private val work = Executors.newSingleThreadExecutor()
    private lateinit var list: LinearLayout
    private lateinit var summary: TextView
    private var lastShown = ""

    private val dp get() = resources.displayMetrics.density
    private fun px(v: Int) = (v * dp).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(20), px(24), px(20), px(24))
        }
        col.addView(TextView(this).apply {
            text = "Downloads"
            setTextColor(WHITE); textSize = 26f; typeface = Typeface.DEFAULT_BOLD
        })
        summary = TextView(this).apply { setTextColor(DIM); textSize = 14f; setPadding(0, px(6), 0, px(8)) }
        col.addView(summary)
        col.addView(settingsBlock())
        col.addView(heading("On this phone"))
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(list)
        col.addView(Button(this).apply {
            text = "Back to MusicD"
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = px(24) })

        val scroll = ScrollView(this).apply {
            setBackgroundColor(BG)
            isFillViewport = true
            addView(col)
        }
        Insets.pad(scroll)
        setContentView(scroll)
        refreshFromServer()
    }

    override fun onResume() {
        super.onResume()
        tick.run()
    }

    override fun onPause() {
        main.removeCallbacks(tick)
        super.onPause()
    }

    override fun onDestroy() {
        work.shutdownNow()
        super.onDestroy()
    }

    // While downloads run, the list follows them.
    private val tick = object : Runnable {
        override fun run() {
            render()
            main.postDelayed(this, 2000)
        }
    }

    // ------------------------------------------------------------ settings

    private fun settingsBlock(): View {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val s = DownloadStore.settings(this)

        box.addView(label("Quality (you can choose each time)"))
        box.addView(spinner(
            listOf("Original — the files as they are", "Opus 256 kbps — about a tenth of the size"),
            if (s.quality == DownloadStore.QUALITY_OPUS) 1 else 0
        ) { i -> DownloadStore.setQuality(this, if (i == 1) DownloadStore.QUALITY_OPUS else DownloadStore.QUALITY_ORIGINAL) })

        val places = DownloadStore.places(this)
        box.addView(label("Save to"))
        box.addView(spinner(
            places.map { "${it.label} — ${gb(it.freeBytes)} free" },
            places.indexOfFirst { it.id == s.location }.coerceAtLeast(0)
        ) { i -> DownloadStore.setLocation(this, places[i].id) })
        if (places.size > 1) box.addView(note("Albums already downloaded stay where they are."))

        val limits = listOf(0, 8, 16, 32, 64, 128, 256)
        box.addView(label("Size limit"))
        box.addView(spinner(
            limits.map { if (it == 0) "No limit" else "$it GB" },
            limits.indexOf(s.limitGb).coerceAtLeast(0)
        ) { i -> DownloadStore.setLimitGb(this, limits[i]) })

        box.addView(Switch(this).apply {
            text = "Download on Wi-Fi only"
            setTextColor(WHITE); textSize = 16f
            isChecked = s.wifiOnly
            setPadding(0, px(14), 0, px(6))
            setOnCheckedChangeListener { _, on -> DownloadStore.setWifiOnly(this@DownloadsActivity, on) }
        })
        box.addView(note("Downloads live in this app's storage: no permission needed, but uninstalling the app deletes them (updates don't)."))
        return box
    }

    private fun spinner(items: List<String>, selected: Int, onPick: (Int) -> Unit): Spinner =
        Spinner(this).apply {
            adapter = ArrayAdapter(this@DownloadsActivity, android.R.layout.simple_spinner_dropdown_item, items)
            setSelection(selected)
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(p: AdapterView<*>?, v: View?, position: Int, id: Long) = onPick(position)
                override fun onNothingSelected(p: AdapterView<*>?) {}
            }
        }

    // ------------------------------------------------------------ list

    private fun render() {
        val albums = DownloadStore.albums(this)
        val sig = albums.joinToString("|") { "${it.first.id}:${it.first.state}:${it.first.doneCount}:${it.first.title}" }
        summary.text = "${albums.count { it.first.state == "done" }} albums · ${gb(DownloadStore.usedBytes(this))} used"
        if (sig == lastShown) return
        lastShown = sig
        list.removeAllViews()
        if (albums.isEmpty()) {
            list.addView(note("Nothing here yet. On an album's page, choose ⋯ → Download to this phone."))
            return
        }
        for ((a, dir) in albums) list.addView(row(a, dir))
    }

    private fun row(a: DownloadStore.Album, dir: File): View {
        val r = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, px(8), 0, px(8))
        }
        val art = ImageView(this).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(CARD)
            val cover = File(dir, "cover.jpg")
            if (cover.exists()) {
                val o = BitmapFactory.Options().apply { inSampleSize = 4 }
                runCatching { BitmapFactory.decodeFile(cover.path, o) }.getOrNull()?.let { setImageBitmap(it) }
            }
        }
        r.addView(art, LinearLayout.LayoutParams(px(64), px(64)))
        val text = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(12), 0, 0, 0)
        }
        text.addView(TextView(this).apply { this.text = a.title; setTextColor(WHITE); textSize = 16f; maxLines = 2 })
        text.addView(TextView(this).apply { this.text = a.artist; setTextColor(DIM); textSize = 14f; maxLines = 1 })
        text.addView(TextView(this).apply { this.text = stateLine(a); setTextColor(FAINT); textSize = 12f })
        r.addView(text, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        r.setOnClickListener { open(a) }
        r.setOnLongClickListener { confirmRemove(a); true }
        return r
    }

    private fun stateLine(a: DownloadStore.Album): String {
        val q = if (a.quality == DownloadStore.QUALITY_OPUS) "Opus 256" else "Original"
        return when (a.state) {
            "done" -> "${a.tracks.size} tracks · ${gb(a.totalBytes)} · $q"
            "downloading" -> "Downloading ${a.doneCount} of ${a.tracks.size} · $q"
            "queued" -> "Waiting to start · $q"
            "waiting" -> "Waiting for the network · ${a.doneCount} of ${a.tracks.size}"
            "failed" -> "Couldn't download: ${a.error ?: "unknown"}"
            else -> a.state
        }
    }

    private fun open(a: DownloadStore.Album) {
        if (a.state != "done") {
            AlertDialog.Builder(this).setTitle(a.title).setMessage(stateLine(a))
                .setPositiveButton("Try again") { _, _ -> DownloadWorker.enqueue(this, a.id, a.quality, a.title, a.artist) }
                .setNeutralButton("Remove") { _, _ -> confirmRemove(a) }
                .setNegativeButton("Close", null).show()
            return
        }
        val names = a.tracks.mapIndexed { i, t -> "${i + 1}. ${t.title}" }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("${a.title} — ${a.artist}")
            .setItems(names) { _, which -> play(a, which) }
            .setPositiveButton("Play album") { _, _ -> play(a, 0) }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun play(a: DownloadStore.Album, index: Int) {
        startService(Intent(this, PhonePlayerService::class.java)
            .setAction(PhonePlayerService.ACTION_PLAY_LOCAL)
            .putExtra(PhonePlayerService.EXTRA_ALBUM, a.id)
            .putExtra(PhonePlayerService.EXTRA_INDEX, index))
    }

    private fun confirmRemove(a: DownloadStore.Album) {
        AlertDialog.Builder(this)
            .setTitle("Remove from this phone?")
            .setMessage("${a.title} — ${a.artist}\n\nIt stays in your library on the server.")
            .setPositiveButton("Remove") { _, _ -> DownloadStore.remove(this, a.id); lastShown = ""; render() }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // ------------------------------------------------------------ server

    /** New titles, artists, years and covers from the server, when it's there. */
    private fun refreshFromServer() {
        val client: ServerClient = Store.client(this) ?: return
        work.execute {
            runCatching {
                val albums = DownloadStore.albums(this)
                if (albums.isEmpty()) return@runCatching
                val ids = JSONArray()
                albums.forEach { ids.put(it.first.id) }
                val j = client.post("/api/download/albums", JSONObject().put("ids", ids))
                val rows = j.getJSONArray("albums")
                for (i in 0 until rows.length()) {
                    val r = rows.getJSONObject(i)
                    if (!r.optBoolean("exists")) continue
                    val (a, dir) = albums.firstOrNull { it.first.id == r.getInt("id") } ?: continue
                    val key = r.optString("image_key")
                    val changed = a.title != r.optString("title") || a.artist != r.optString("artist") || a.imageKey != key
                    if (!changed) continue
                    val newCover = a.imageKey != key
                    a.title = r.optString("title", a.title)
                    a.artist = r.optString("artist", a.artist)
                    a.year = if (r.isNull("year")) null else r.optInt("year")
                    a.imageKey = key
                    DownloadStore.save(dir, a)
                    if (newCover) runCatching {
                        File(dir, "cover.jpg").writeBytes(client.bytes(r.getString("art_url")))
                    }
                }
            }
            main.post { lastShown = ""; if (!isFinishing) render() }
        }
    }

    // ------------------------------------------------------------ bits

    private fun heading(t: String) = TextView(this).apply {
        text = t.uppercase(); setTextColor(FAINT); textSize = 12f; letterSpacing = 0.08f
        setPadding(0, px(24), 0, px(8))
    }
    private fun label(t: String) = TextView(this).apply { text = t; setTextColor(DIM); textSize = 13f; setPadding(0, px(14), 0, px(4)) }
    private fun note(t: String) = TextView(this).apply { text = t; setTextColor(FAINT); textSize = 12f; setPadding(0, px(6), 0, 0) }
    private fun gb(bytes: Long): String =
        if (bytes >= 1L shl 30) String.format("%.1f GB", bytes / (1L shl 30).toDouble())
        else String.format("%d MB", bytes / (1L shl 20))

    private companion object {
        const val BG = 0xFF0E1012.toInt()
        const val CARD = 0xFF252A2F.toInt()
        const val WHITE = 0xFFFFFFFF.toInt()
        const val DIM = 0xFFBFC7CE.toInt()
        const val FAINT = 0xFF6B737A.toInt()
    }
}
