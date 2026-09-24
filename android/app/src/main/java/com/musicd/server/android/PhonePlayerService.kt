package com.musicd.server.android

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.musicd.server.client.Phone
import com.musicd.server.client.ServerClient
import com.musicd.server.client.phoneCommands
import com.musicd.server.client.phoneHello
import com.musicd.server.client.phoneReport
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import kotlin.math.roundToInt

/**
 * "This phone": the phone as one of MusicD Server's zones.
 *
 * The server keeps the queue and sends commands (load an album, pause, skip,
 * seek, volume…), collected here with a long poll; ExoPlayer plays them
 * through the phone's speaker or headphones, and what it is doing goes back to
 * the server, which shows it like any Sonos room — on this phone's own page
 * and on every other device. Media3 provides the notification, lock screen,
 * headset buttons and Android Auto.
 *
 * Audio comes from the server's /stream addresses, the same ones Sonos is
 * given (FLAC up to 24-bit/48 kHz, anything higher converted on the server) —
 * or, for a track that has been downloaded, from the phone itself. Away from
 * home (see [Away]) the same addresses go to the server's Tailscale address
 * and ask for Opus 256 kbps, and a track cut off by the switch picks up
 * where it stopped.
 *
 * Downloaded albums also play with no server at all (ACTION_PLAY_LOCAL, from
 * the Downloads screen). While it plays those, the server's commands that
 * would rearrange a queue it doesn't know are ignored, and the plays are
 * kept to send once the server is reachable again.
 *
 * Started while the app is open; it stays running while it plays. Closed and
 * idle, it stops, and the phone drops out of the zone list shortly after.
 */
@OptIn(UnstableApi::class)
class PhonePlayerService : MediaSessionService() {

    companion object {
        private const val TAG = "PhonePlayer"
        private const val WAIT_MS = 25_000
        const val ACTION_PLAY_LOCAL = "com.musicd.server.android.action.PLAY_LOCAL"
        const val EXTRA_ALBUM = "album"
        const val EXTRA_INDEX = "index"

        fun start(context: Context) {
            if (Store.token(context) == null) return
            runCatching { context.startService(Intent(context, PhonePlayerService::class.java)) }
                .onFailure { Log.w(TAG, "could not start the phone player", it) }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private val reports = Executors.newSingleThreadExecutor()
    private var session: MediaSession? = null
    private lateinit var player: ExoPlayer
    private lateinit var audio: AudioManager
    @Volatile private var running = false
    private var worker: Thread? = null
    private var seq = 0L
    private var reportPending = false
    /** Playing downloads from the Downloads screen rather than the server's queue. */
    private var localMode = false
    private var loggedKey: String? = null
    private var retries = 0

    override fun onCreate() {
        super.onCreate()
        audio = getSystemService(AudioManager::class.java)
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("MusicDAndroid/${BuildConfig.VERSION_NAME}")
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(8_000)
            .setReadTimeoutMs(20_000)
        Store.token(this)?.let { http.setDefaultRequestProperties(mapOf("Authorization" to "Bearer $it")) }
        // Each address is sent where the server is now — home or away — as
        // it's opened; downloaded tracks are files and go straight through.
        val routed = ResolvingDataSource.Factory(http) { spec ->
            spec.withUri(Uri.parse(Store.localize(this, spec.uri.toString())))
        }
        val sources = DefaultDataSource.Factory(this, routed)

        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(sources))
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
                /* handleAudioFocus = */ true
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        player.addListener(object : Player.Listener {
            override fun onEvents(p: Player, events: Player.Events) = reportSoon()
            override fun onIsPlayingChanged(isPlaying: Boolean) { if (isPlaying) retries = 0 }
            override fun onPlayerError(error: PlaybackException) = resumeAfterError(error)
        })
        Away.watch(this)

        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        session = MediaSession.Builder(this, player).setSessionActivity(open).build()

        running = true
        worker = Thread({ loop() }, "phone-commands").apply { isDaemon = true; start() }
        main.postDelayed(heartbeat, 10_000)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_PLAY_LOCAL) {
            playLocal(intent.getIntExtra(EXTRA_ALBUM, 0), intent.getIntExtra(EXTRA_INDEX, 0))
        }
        return super.onStartCommand(intent, flags, startId)
    }

    /** A downloaded album, from the phone's own storage. */
    private fun playLocal(albumId: Int, index: Int) {
        val dir = DownloadStore.dirOf(this, albumId) ?: return
        val a = DownloadStore.load(dir) ?: return
        val cover = File(dir, "cover.jpg").takeIf { it.exists() }?.let { Uri.fromFile(it) }
        val items = a.tracks.filter { it.done && File(dir, it.fileName()).exists() }.map { t ->
            MediaItem.Builder()
                .setUri(Uri.fromFile(File(dir, t.fileName())))
                .setMediaId(t.id.toString())
                .setMediaMetadata(MediaMetadata.Builder()
                    .setTitle(t.title).setArtist(t.artist).setAlbumTitle(a.title)
                    .apply { cover?.let { setArtworkUri(it) } }
                    .build())
                .build()
        }
        if (items.isEmpty()) return
        localMode = true
        loggedKey = null
        player.setMediaItems(items, index.coerceIn(0, items.size - 1), 0L)
        player.prepare()
        player.play()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiped away while idle: stop, and the phone leaves the zone list.
        if (!player.playWhenReady || player.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        running = false
        worker?.interrupt()
        main.removeCallbacksAndMessages(null)
        session?.run {
            player.release()
            release()
        }
        session = null
        reports.shutdown()
        super.onDestroy()
    }

    // ------------------------------------------------------------ commands

    private fun loop() {
        var hello = false
        var failures = 0
        while (running) {
            val client = Store.client(this)
            if (client == null) { pause(5_000); continue }
            try {
                if (!hello) {
                    val h = client.phoneHello(deviceName())
                    seq = h.seq
                    Store.setAwayLearned(this, h.awayAddress)
                    hello = true
                    reportSoon()
                }
                sendOfflinePlays(client)
                val batch = client.phoneCommands(seq, WAIT_MS)
                seq = batch.seq
                failures = 0
                if (batch.commands.isNotEmpty()) {
                    val done = CountDownLatch(1)
                    main.post {
                        for (c in batch.commands) runCatching { apply(c) }.onFailure { Log.w(TAG, "command ${c.op} failed", it) }
                        done.countDown()
                    }
                    done.await()
                }
            } catch (e: InterruptedException) {
                return
            } catch (e: ServerClient.ServerException) {
                if (e.signedOut) { main.post { stopSelf() }; return }
                if (e.status == 409) hello = false            // the server forgot us (restarted): start again
                failures++
                pause(minOf(15_000L, 1_000L * failures))
            } catch (e: Exception) {
                failures++
                if (failures == 1) Log.i(TAG, "server unreachable: ${e.message}")
                pause(minOf(15_000L, 1_000L * failures))
            }
        }
    }

    /** Plays made with no server, once there is one. */
    private fun sendOfflinePlays(client: ServerClient) {
        val plays = DownloadStore.pendingPlays(this)
        if (plays.length() == 0) return
        runCatching {
            client.post("/api/phone/plays", JSONObject().put("plays", plays))
            DownloadStore.clearPlays(this, plays.length())
        }
    }

    private fun pause(ms: Long) {
        try { Thread.sleep(ms) } catch (e: InterruptedException) { running = false }
    }

    private fun mediaItem(it: Phone.Item): MediaItem {
        val meta = MediaMetadata.Builder()
            .setTitle(it.title)
            .setArtist(it.artist)
            .setAlbumTitle(it.album)
            .apply { it.artUrl?.let { u -> setArtworkUri(Uri.parse(Store.localize(this@PhonePlayerService, u))) } }
            .build()
        // A downloaded copy plays in place of the stream.
        val local = DownloadStore.trackFile(this, it.trackId)
        return MediaItem.Builder()
            .setUri(if (local != null) Uri.fromFile(local) else Uri.parse(it.url))
            .setMediaId(it.trackId?.toString() ?: it.url)
            .setMediaMetadata(meta)
            .build()
    }

    /**
     * The network went (leaving the house, say): once the phone is on its
     * new route, carry on from the same place — a few tries, then give up.
     */
    private fun resumeAfterError(error: PlaybackException) {
        Log.i(TAG, "playback stopped: ${error.errorCodeName}")
        if (localMode || retries >= 4 || player.mediaItemCount == 0) return
        val wasPlaying = player.playWhenReady
        retries++
        Away.recheck(this)
        main.postDelayed({
            if (!running) return@postDelayed
            player.prepare()
            player.playWhenReady = wasPlaying
        }, 3000L * retries)
    }

    private fun ensurePrepared() {
        if (player.playbackState == Player.STATE_IDLE) player.prepare()
    }

    /** One command from the server, on the main thread. */
    private fun apply(c: Phone.Command) {
        if (c.op == "load" || c.op == "sync") localMode = false
        // Playing downloads: the server's queue isn't the one playing, so its
        // queue edits don't apply (transport, volume and modes still do).
        if (localMode && c.op in setOf("insert", "remove", "clear", "jump")) return
        when (c.op) {
            "load", "sync" -> {
                val items = c.items.map(::mediaItem)
                if (items.isEmpty()) { player.clearMediaItems(); player.stop(); return }
                val index = c.index.coerceIn(0, items.size - 1)
                player.setMediaItems(items, index, (c.seconds * 1000).toLong())
                player.prepare()
                player.playWhenReady = c.play
            }
            "insert" -> {
                val at = c.at.coerceIn(0, player.mediaItemCount)
                player.addMediaItems(at, c.items.map(::mediaItem))
                if (c.play && !player.isPlaying) {
                    if (player.playbackState == Player.STATE_ENDED || player.playbackState == Player.STATE_IDLE) {
                        player.seekTo(at, 0)
                    }
                    ensurePrepared()
                    player.play()
                }
            }
            "remove" -> if (c.index in 0 until player.mediaItemCount) player.removeMediaItem(c.index)
            "clear" -> { player.clearMediaItems(); player.stop() }
            "play" -> {
                if (player.playbackState == Player.STATE_ENDED) player.seekTo(0, 0)
                ensurePrepared()
                player.play()
            }
            "pause" -> player.pause()
            "stop" -> { player.pause(); player.stop() }
            "next" -> player.seekToNextMediaItem()
            "previous" -> player.seekToPrevious()
            "seek" -> player.seekTo((c.seconds * 1000).toLong())
            "jump" -> if (c.index in 0 until player.mediaItemCount) {
                player.seekTo(c.index, 0)
                ensurePrepared()
                player.play()
            }
            "volume" -> {
                val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                audio.setStreamVolume(AudioManager.STREAM_MUSIC, (c.value / 100.0 * max).roundToInt().coerceIn(0, max), 0)
            }
            "mute" -> audio.adjustStreamVolume(
                AudioManager.STREAM_MUSIC,
                if (c.muted) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE, 0
            )
            "mode" -> {
                player.shuffleModeEnabled = c.shuffle
                player.repeatMode = when (c.loop) {
                    "loop" -> Player.REPEAT_MODE_ALL
                    "loop_one" -> Player.REPEAT_MODE_ONE
                    else -> Player.REPEAT_MODE_OFF
                }
            }
            else -> Log.w(TAG, "unknown command ${c.op}")
        }
        reportSoon()
    }

    // ------------------------------------------------------------ reports

    private val heartbeat = object : Runnable {
        override fun run() {
            // While playing, the position and the volume keys' effect.
            if (player.isPlaying) {
                if (localMode) logLocalPlay()
                report()
            }
            if (running) main.postDelayed(this, 10_000)
        }
    }

    private fun reportSoon() {
        if (reportPending) return
        reportPending = true
        main.postDelayed({ reportPending = false; report() }, 300)
    }

    /** A downloaded track heard long enough to count, the same rule as the server's. */
    private fun logLocalPlay() {
        val item = player.currentMediaItem ?: return
        val key = item.mediaId + "@" + player.currentMediaItemIndex
        if (key == loggedKey) return
        val dur = if (player.duration > 0) player.duration / 1000.0 else 60.0
        if (player.currentPosition / 1000.0 >= minOf(30.0, maxOf(5.0, dur / 2))) {
            loggedKey = key
            item.mediaId.toLongOrNull()?.let { DownloadStore.addPlay(this, it) }
        }
    }

    /** Read the player (main thread), send it (background). */
    private fun report() {
        // Playing downloads the server doesn't know about: it sees the phone as idle.
        val count = if (localMode) 0 else player.mediaItemCount
        val state = when {
            count == 0 -> "stopped"
            player.isPlaying -> "playing"
            player.playbackState == Player.STATE_BUFFERING && player.playWhenReady -> "loading"
            player.playbackState == Player.STATE_ENDED -> "stopped"
            player.playbackState == Player.STATE_IDLE && !player.playWhenReady -> "stopped"
            else -> "paused"
        }
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        val muted = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && audio.isStreamMute(AudioManager.STREAM_MUSIC)
        val r = Phone.Report(
            index = if (count > 0) player.currentMediaItemIndex else -1,
            positionSeconds = player.currentPosition / 1000.0,
            durationSeconds = if (player.duration > 0) player.duration / 1000.0 else 0.0,
            state = state,
            shuffle = player.shuffleModeEnabled,
            loop = when (player.repeatMode) {
                Player.REPEAT_MODE_ALL -> "loop"
                Player.REPEAT_MODE_ONE -> "loop_one"
                else -> "disabled"
            },
            volume = (audio.getStreamVolume(AudioManager.STREAM_MUSIC) * 100.0 / max).roundToInt(),
            muted = muted
        )
        val client = Store.client(this) ?: return
        runCatching { reports.execute { runCatching { client.phoneReport(r) } } }
    }

    private fun deviceName(): String {
        val maker = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
        val model = Build.MODEL
        return if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model"
    }
}
