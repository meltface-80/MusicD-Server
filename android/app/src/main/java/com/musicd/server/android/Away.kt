package com.musicd.server.android

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.musicd.server.client.Route
import com.musicd.server.client.ServerAddress
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * Home or away, followed as the phone's network changes.
 *
 * On the home Wi-Fi the app talks to the server on its home address. Off it —
 * mobile data, or someone else's Wi-Fi — it switches to the server's
 * Tailscale address, asking the Tailscale app to connect if it isn't already,
 * and back again when the phone is home. Away, the server offers only this
 * phone to play on (no Sonos rooms), and streams Opus 256 kbps.
 *
 * The Tailscale app is asked with its own broadcast (the one Tasker uses); it
 * doesn't answer, so the only proof is the server answering on its Tailscale
 * address. If the app hasn't got it on its own, "Always-on VPN" for Tailscale
 * in Android's settings does the same job.
 */
object Away {
    private const val TAG = "Away"
    private const val TAILSCALE = "com.tailscale.ipn"
    private const val TAILSCALE_RECEIVER = "com.tailscale.ipn.IPNReceiver"

    private val work = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArrayList<(Boolean) -> Unit>()
    @Volatile private var watching = false
    @Volatile private var pending = false
    /** Tailscale was switched on by this app, so it may switch it off at home. */
    @Volatile private var weConnected = false

    /** [l] hears `away` whenever it changes (on the main thread). */
    fun listen(l: (Boolean) -> Unit) { listeners += l }
    fun unlisten(l: (Boolean) -> Unit) { listeners -= l }

    /** Follow the phone's network from now on (once per process). */
    fun watch(context: Context) {
        val app = context.applicationContext
        if (!watching) {
            watching = true
            val cm = app.getSystemService(ConnectivityManager::class.java)
            runCatching {
                cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) = recheck(app)
                    override fun onLost(network: Network) = recheck(app)
                    override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = recheck(app)
                })
            }.onFailure { Log.w(TAG, "can't follow the network", it) }
        }
        recheck(app)
    }

    /** Look again soon — changes come in bursts, so they're gathered for a moment. */
    fun recheck(context: Context) {
        if (pending) return
        pending = true
        main.postDelayed({
            pending = false
            work.execute { check(context.applicationContext) }
        }, 1500)
    }

    /** Where we are now, decided and stored. Blocking; not on the main thread. */
    fun check(c: Context): Boolean {
        val home = Store.server(c) ?: return false
        val awayAt = Store.awayAddress(c)
        val wasAway = Store.isAway(c)
        val homeAnswers = onWifi(c) && answers(home, 1500)
        val away = awayAt != null && Route.away(onWifi(c), homeAnswers)

        if (away && awayAt != null && !answers(awayAt, 3000)) {
            // Not through yet: ask the Tailscale app, then give it a little while.
            if (tailscale(c, connect = true)) weConnected = true
            val until = System.currentTimeMillis() + 15_000
            var ok = false
            while (!ok && System.currentTimeMillis() < until) {
                try { Thread.sleep(1500) } catch (e: InterruptedException) { return wasAway }
                ok = answers(awayAt, 3000)
            }
            if (!ok) Log.i(TAG, "the server isn't answering on $awayAt either")
        }
        if (!away && homeAnswers && weConnected) {
            // Home again: Tailscale goes off if this app turned it on.
            tailscale(c, connect = false)
            weConnected = false
        }
        if (away != wasAway) {
            Log.i(TAG, if (away) "away: using $awayAt" else "home: using $home")
            Store.setAway(c, away)
            main.post { for (l in listeners) runCatching { l(away) } }
        }
        return away
    }

    /** On Wi-Fi or Ethernet (a VPN on top of it counts; mobile data doesn't). */
    @Suppress("DEPRECATION")
    private fun onWifi(c: Context): Boolean {
        val cm = c.getSystemService(ConnectivityManager::class.java) ?: return false
        return runCatching {
            cm.allNetworks.any { n ->
                val caps = cm.getNetworkCapabilities(n) ?: return@any false
                !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                    (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
            }
        }.getOrDefault(false)
    }

    private fun answers(a: ServerAddress, timeoutMs: Int): Boolean = runCatching {
        val conn = URL(a.baseUrl + "/api/health").openConnection() as HttpURLConnection
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
        try { conn.responseCode == 200 } finally { conn.disconnect() }
    }.getOrDefault(false)

    private fun tailscale(c: Context, connect: Boolean): Boolean = runCatching {
        c.sendBroadcast(Intent(if (connect) "$TAILSCALE.CONNECT_VPN" else "$TAILSCALE.DISCONNECT_VPN")
            .setClassName(TAILSCALE, TAILSCALE_RECEIVER))
        true
    }.getOrElse { Log.i(TAG, "couldn't ask Tailscale: ${it.message}"); false }
}
