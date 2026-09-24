package com.musicd.server.client

import org.json.JSONArray
import org.json.JSONObject

/**
 * The phone as a player: what the server tells it to do, and what it reports
 * back. The server keeps the queue and sends commands (see the server's
 * lib/sonos/phones.js); the app plays them with Media3 and reports its state.
 */
object Phone {

    class Item(
        val url: String,
        val trackId: Long?,
        val title: String,
        val artist: String,
        val album: String,
        val artUrl: String?,
        val durationSeconds: Double
    )

    /** One command. Only the fields its [op] uses are set. */
    class Command(
        val seq: Long,
        val op: String,
        val items: List<Item> = emptyList(),
        val index: Int = 0,
        val at: Int = 0,
        val seconds: Double = 0.0,
        val play: Boolean = false,
        val value: Int = 0,
        val muted: Boolean = false,
        val shuffle: Boolean = false,
        val loop: String = "disabled"
    )

    class Batch(val seq: Long, val commands: List<Command>)

    /** [awayAddress]: where the server is away from home (Tailscale), if it knows. */
    class Hello(val zoneId: String, val seq: Long, val away: Boolean = false, val awayAddress: String? = null)

    /** What the player is doing, as the server wants to hear it. */
    class Report(
        val index: Int,
        val positionSeconds: Double,
        val durationSeconds: Double,
        val state: String,
        val shuffle: Boolean,
        val loop: String,
        val volume: Int,
        val muted: Boolean
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("index", index).put("position", positionSeconds).put("duration", durationSeconds)
            .put("state", state).put("shuffle", shuffle).put("loop", loop)
            .put("volume", volume).put("muted", muted)
    }

    fun parseItems(a: JSONArray?): List<Item> {
        if (a == null) return emptyList()
        return (0 until a.length()).map { i ->
            val o = a.getJSONObject(i)
            Item(
                url = o.getString("url"),
                trackId = if (o.isNull("track_id") || !o.has("track_id")) null else o.optLong("track_id"),
                title = o.optString("title", ""),
                artist = o.optString("artist", ""),
                album = o.optString("album", ""),
                artUrl = o.optString("art_url", "").takeIf { it.isNotEmpty() },
                durationSeconds = o.optDouble("duration", 0.0).let { if (it.isNaN()) 0.0 else it }
            )
        }
    }

    fun parseCommand(o: JSONObject) = Command(
        seq = o.optLong("seq"),
        op = o.optString("op"),
        items = parseItems(o.optJSONArray("items")),
        index = o.optInt("index", 0),
        at = o.optInt("at", 0),
        seconds = o.optDouble("seconds", 0.0).let { if (it.isNaN()) 0.0 else it },
        play = o.optBoolean("play", false),
        value = o.optInt("value", 0),
        muted = o.optBoolean("muted", false),
        shuffle = o.optBoolean("shuffle", false),
        loop = o.optString("loop", "disabled")
    )

    fun parseBatch(o: JSONObject): Batch {
        val a = o.optJSONArray("commands") ?: JSONArray()
        return Batch(o.optLong("seq"), (0 until a.length()).map { parseCommand(a.getJSONObject(it)) })
    }
}

/** The phone-player calls, on a signed-in [ServerClient]. */
fun ServerClient.phoneHello(name: String): Phone.Hello {
    val j = post("/api/phone/hello", JSONObject().put("name", name))
    return Phone.Hello(
        j.getString("zone_id"), j.optLong("seq"), j.optBoolean("away", false),
        j.optString("away_address", "").takeIf { it.isNotEmpty() && it != "null" }
    )
}

/** Held open by the server for up to [waitMs] until there is something to do. */
fun ServerClient.phoneCommands(after: Long, waitMs: Int): Phone.Batch =
    Phone.parseBatch(getJson("/api/phone/commands?after=$after&wait=$waitMs", waitMs + 10_000))

fun ServerClient.phoneReport(report: Phone.Report) {
    post("/api/phone/state", report.toJson())
}
