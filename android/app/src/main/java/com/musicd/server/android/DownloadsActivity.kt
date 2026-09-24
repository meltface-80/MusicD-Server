package com.musicd.server.android

import android.app.Activity
import android.app.AlertDialog
import android.content.ComponentName
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
import android.widget.SeekBar
import android.widget.Switch
import android.widget.TextView
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.musicd.server.client.ServerClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * Downloads: what's on this phone, and the settings for it — the app's own
 * screen, which works with no server at all. Tap an album to play it here
 * (or pick a track); press and hold to remove it. The bar at the bottom is
 * the player: what's playing, with its controls.
 *
 * With the server out of reach the app opens here by itself
 * ([EXTRA_OFFLINE]), rather than on an error.
 */
class DownloadsActivity : Activity() {

    companion object {
        const val EXTRA_OFFLINE = "offline"
    }

    private val main = Handler(Looper.getMainLooper())
    private val work = Executors.newSingleThreadExecutor()
    private lateinit var list: LinearLayout
    private lateinit var summary: TextView
    private var lastShown = ""
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private lateinit var bar: LinearLayout
    private lateinit var barArt: ImageView
    private lateinit var barTitle: TextView
    private lateinit var barArtist: TextView
    private lateinit var barPlay: Button
    private lateinit var barSeek: SeekBar
    private var barArtUri: String? = null
    private var seeking = false

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
        if (intent?.getBooleanExtra(EXTRA_OFFLINE, false) == true) col.addView(offlineBanner())
        col.addView(heading("On this phone"))
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(list)
        col.addView(heading("Download settings"))
        col.addView(settingsBlock())
        col.addView(Button(this).apply {
            text = "Back to MusicD"
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = px(24) })

        val scroll = ScrollView(this).apply {
            isFillViewport = true
            addView(col)
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
            addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(playerBar(), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }
        Insets.pad(root)
        setContentView(root)
        refreshFromServer()
    }

    private fun offlineBanner(): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(CARD)
        setPadding(px(14), px(12), px(14), px(12))
        addView(TextView(this@DownloadsActivity).apply {
            text = "MusicD Server can't be reached — here's what's on this phone."
            setTextColor(WHITE); textSize = 14f
        })
        addView(Button(this@DownloadsActivity).apply {
            text = "Try the server again"
            setOnClickListener { finish() }     // MainActivity tries again as it comes back
        })
    }

    // ------------------------------------------------------------ player bar

    private fun playerBar(): View {
        bar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(CARD)
            setPadding(px(12), px(6), px(12), px(8))
            visibility = View.GONE
        }
        barSeek = SeekBar(this).apply {
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(sb: SeekBar?, p: Int, fromUser: Boolean) {}
                override fun onStartTrackingTouch(sb: SeekBar?) { seeking = true }
                override fun onStopTrackingTouch(sb: SeekBar?) {
                    seeking = false
                    controller?.seekTo((sb?.progress ?: 0).toLong() * 1000)
                }
            })
        }
        bar.addView(barSeek)
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        barArt = ImageView(this).apply { scaleType = ImageView.ScaleType.CENTER_CROP; setBackgroundColor(BG) }
        row.addView(barArt, LinearLayout.LayoutParams(px(48), px(48)))
        val names = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(px(10), 0, px(6), 0) }
        barTitle = TextView(this).apply { setTextColor(WHITE); textSize = 15f; maxLines = 1 }
        barArtist = TextView(this).apply { setTextColor(DIM); textSize = 13f; maxLines = 1 }
        names.addView(barTitle); names.addView(barArtist)
        row.addView(names, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        fun control(label: String, action: () -> Unit) = Button(this).apply {
            text = label; textSize = 18f; minWidth = 0; minimumWidth = 0
            setOnClickListener { action() }
        }
        row.addView(control("⏮") { controller?.seekToPrevious() }, LinearLayout.LayoutParams(px(52), px(48)))
        barPlay = control("▶") { controller?.let { if (it.isPlaying) it.pause() else { if (it.playbackState == Player.STATE_ENDED) it.seekTo(0, 0); it.play() } } }
        row.addView(barPlay, LinearLayout.LayoutParams(px(52), px(48)))
        row.addView(control("⏭") { controller?.seekToNext() }, LinearLayout.LayoutParams(px(52), px(48)))
        bar.addView(row)
        return bar
    }

    override fun onStart() {
        super.onStart()
        // The phone player, controlled from here like from the lock screen.
        val token = SessionToken(this, ComponentName(this, PhonePlayerService::class.java))
        val f = MediaController.Builder(this, token).buildAsync()
        controllerFuture = f
        f.addListener({
            val c = runCatching { f.get() }.getOrNull() ?: return@addListener
            if (isFinishing || isDestroyed) { c.release(); return@addListener }
            controller = c
            c.addListener(object : Player.Listener {
                override fun onEvents(player: Player, events: Player.Events) = updateBar()
            })
            updateBar()
        }, { r -> main.post(r) })
    }

    override fun onStop() {
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controllerFuture = null
        controller = null
        super.onStop()
    }

    private fun updateBar() {
        val c = controller
        if (c == null || c.mediaItemCount == 0) { bar.visibility = View.GONE; return }
        bar.visibility = View.VISIBLE
        val m = c.mediaMetadata
        barTitle.text = m.title ?: ""
        barArtist.text = listOfNotNull(m.artist, m.albumTitle).joinToString(" · ")
        barPlay.text = if (c.isPlaying || (c.playWhenReady && c.playbackState == Player.STATE_BUFFERING)) "⏸" else "▶"
        val art = m.artworkUri?.toString()
        if (art != barArtUri) {
            barArtUri = art
            barArt.setImageDrawable(null)
            // Downloaded covers are files; a streamed track's cover is left to the notification.
            if (art != null && art.startsWith("file:")) {
                val o = BitmapFactory.Options().apply { inSampleSize = 4 }
                runCatching { BitmapFactory.decodeFile(android.net.Uri.parse(art).path, o) }.getOrNull()?.let { barArt.setImageBitmap(it) }
            }
        }
        val dur = c.duration
        barSeek.max = if (dur > 0) (dur / 1000).toInt() else 0
        if (!seeking) barSeek.progress = (c.currentPosition / 1000).toInt()
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

    // While downloads run, the list follows them (and the bar, the track).
    private val tick = object : Runnable {
        override fun run() {
            render()
            if (::bar.isInitialized) updateBar()
            main.postDelayed(this, 1000)
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

        box.addView(switch("Download on Wi-Fi only", s.wifiOnly) { DownloadStore.setWifiOnly(this, it) })
        box.addView(note("Downloads live in this app's storage: no permission needed, but uninstalling the app deletes them (updates don't)."))

        // Automatic downloads.
        box.addView(heading("Automatic downloads"))
        box.addView(note("Kept on the phone by themselves, in the quality above, and removed again when they drop off " +
            "the list. Albums you download yourself are never removed."))
        box.addView(switch("Today's Smart Picks", s.autoPicks) { DownloadStore.setAutoPicks(this, it); AutoDownloads.runNow(this) })
        box.addView(switch("Album of the day", s.autoAotd) { DownloadStore.setAutoAotd(this, it); AutoDownloads.runNow(this) })
        val recent = listOf(0, 5, 10, 20, 30)
        box.addView(label("Recently added albums"))
        box.addView(spinner(
            recent.map { if (it == 0) "Off" else "The newest $it" },
            recent.indexOf(s.autoRecent).coerceAtLeast(0)
        ) { i ->
            if (recent[i] != DownloadStore.settings(this).autoRecent) {
                DownloadStore.setAutoRecent(this, recent[i]); AutoDownloads.runNow(this)
            }
        })
        return box
    }

    private fun switch(text: String, on: Boolean, onChange: (Boolean) -> Unit): Switch =
        Switch(this).apply {
            this.text = text
            setTextColor(WHITE); textSize = 16f
            isChecked = on
            setPadding(0, px(14), 0, px(6))
            setOnCheckedChangeListener { _, v -> onChange(v) }
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
        val q = (if (a.quality == DownloadStore.QUALITY_OPUS) "Opus 256" else "Original") + if (a.auto) " · automatic" else ""
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
                .setPositiveButton("Try again") { _, _ -> DownloadWorker.enqueue(this, a.id, a.quality, a.title, a.artist, a.auto) }
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
                        File(dir, "cover.jpg").writeBytes(client.bytes(Store.localize(this, r.getString("art_url"))))
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
