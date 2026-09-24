package com.musicd.server.client

/**
 * Home or away: which address the app talks to the server on.
 *
 * At home it's the server's address on the home network. Away — off the home
 * Wi-Fi, on mobile data — it's the server's Tailscale address, and the server
 * treats the phone as away: only "This phone" plays, and tracks come as
 * Opus 256 kbps rather than lossless, for mobile data.
 *
 * The server hands out addresses (stream, artwork) on its home address;
 * [rewrite] moves them to whichever one is in use now.
 */
object Route {

    /**
     * Off Wi-Fi (or Ethernet) the phone is away whatever answers; on Wi-Fi it
     * is home if the home address answers — someone else's Wi-Fi is away too.
     */
    fun away(onWifi: Boolean, homeAnswers: Boolean): Boolean = !(onWifi && homeAnswers)

    /**
     * [url] on the address in use: [home] or [away] (base URLs). A track's
     * stream away asks for Opus (`q=opus`); at home it doesn't. Addresses on
     * anything else are left alone.
     */
    fun rewrite(url: String, home: String, away: String?, isAway: Boolean): String {
        val from = listOfNotNull(home, away).map { it.trimEnd('/') }
            .firstOrNull { url.startsWith("$it/") } ?: return url
        val to = (if (isAway && away != null) away else home).trimEnd('/')
        var rest = url.substring(from.length)
        rest = rest.replace(Regex("([?&])q=opus(&|$)")) { m -> if (m.groupValues[2] == "&") m.groupValues[1] else "" }
        if (isAway && away != null && rest.startsWith("/stream/")) {
            rest += (if (rest.contains('?')) "&" else "?") + "q=opus"
        }
        return to + rest
    }
}
