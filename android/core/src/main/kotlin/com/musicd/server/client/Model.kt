package com.musicd.server.client

import org.json.JSONObject

/** What /api/health says about a server — enough to know it is the right one. */
data class Health(val version: String, val albums: Int, val rooms: Int, val ffmpeg: Boolean) {
    companion object {
        fun parse(j: JSONObject): Health {
            require(j.optBoolean("ok", false)) { "That isn't a MusicD Server" }
            return Health(
                version = j.optString("version", "?"),
                albums = j.optInt("albums", 0),
                rooms = j.optInt("rooms", 0),
                ffmpeg = j.optBoolean("ffmpeg", false)
            )
        }
    }
}

data class ZoneSummary(val id: String, val name: String, val state: String)

data class Zones(val zones: List<ZoneSummary>, val lastZone: String?) {
    companion object {
        fun parse(j: JSONObject): Zones {
            val arr = j.optJSONArray("zones")
            val list = ArrayList<ZoneSummary>()
            if (arr != null) for (i in 0 until arr.length()) {
                val z = arr.optJSONObject(i) ?: continue
                val id = z.optString("zone_id", "")
                if (id.isEmpty()) continue
                list += ZoneSummary(id, z.optString("display_name", ""), z.optString("state", "stopped"))
            }
            val last = j.optString("last_zone", "").takeIf { it.isNotEmpty() && !j.isNull("last_zone") }
            return Zones(list, last)
        }
    }
}

data class NowPlaying(
    val title: String,
    val artist: String,
    val album: String,
    val imageKey: String?,
    val lengthSeconds: Int?,
    val seekSeconds: Int?
)

data class Output(val id: String, val name: String, val volume: Int?, val muted: Boolean)

data class Zone(
    val id: String,
    val name: String,
    val state: String,
    val nowPlaying: NowPlaying?,
    val outputs: List<Output>,
    val nextAllowed: Boolean,
    val previousAllowed: Boolean
) {
    val isPlaying: Boolean get() = state == "playing" || state == "loading"

    /** The room's volume as one number: the mean of its speakers. */
    val volume: Int? get() = outputs.mapNotNull { it.volume }.takeIf { it.isNotEmpty() }?.average()?.toInt()
}

/** One answer from /api/zone-state: the zone, and the revision to wait on next. */
data class ZoneState(val revision: Long, val zone: Zone?) {
    companion object {
        fun parse(j: JSONObject): ZoneState {
            val rev = j.optLong("revision", 0L)
            val z = j.optJSONObject("zone") ?: return ZoneState(rev, null)
            val np = z.optJSONObject("now_playing")
            val outs = ArrayList<Output>()
            val arr = z.optJSONArray("outputs")
            if (arr != null) for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val v = o.optJSONObject("volume")
                outs += Output(
                    id = o.optString("output_id", ""),
                    name = o.optString("display_name", ""),
                    volume = if (v != null && !v.isNull("value")) v.optInt("value") else null,
                    muted = o.optBoolean("is_muted", false)
                )
            }
            return ZoneState(
                rev,
                Zone(
                    id = z.optString("zone_id", ""),
                    name = z.optString("display_name", ""),
                    state = z.optString("state", "stopped"),
                    nowPlaying = np?.let {
                        NowPlaying(
                            title = it.optString("line1", ""),
                            artist = it.optString("line2", ""),
                            album = it.optString("line3", ""),
                            imageKey = it.optString("image_key", "").takeIf { k -> k.isNotEmpty() && !it.isNull("image_key") },
                            lengthSeconds = if (it.isNull("length")) null else it.optInt("length"),
                            seekSeconds = if (it.isNull("seek_position")) null else it.optInt("seek_position")
                        )
                    },
                    outputs = outs,
                    nextAllowed = z.optBoolean("is_next_allowed", true),
                    previousAllowed = z.optBoolean("is_previous_allowed", true)
                )
            )
        }
    }
}
