package com.musicd.server.client

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelTest {
    @Test fun `zone state is read from the server's shape`() {
        val j = JSONObject(
            """
            {"revision": 42, "zone": {"zone_id": "RINCON_A", "display_name": "Kitchen + Study", "state": "playing",
              "is_next_allowed": true, "is_previous_allowed": false,
              "outputs": [
                {"output_id": "RINCON_A", "display_name": "Kitchen", "is_muted": false, "volume": {"value": 30}},
                {"output_id": "RINCON_B", "display_name": "Study", "is_muted": true, "volume": {"value": 50}}],
              "now_playing": {"line1": "Song", "line2": "Artist", "line3": "Album", "image_key": "al-3-abc",
                "length": 245, "seek_position": 12}}}
            """
        )
        val s = ZoneState.parse(j)
        assertEquals(42L, s.revision)
        val z = s.zone!!
        assertEquals("Kitchen + Study", z.name)
        assertTrue(z.isPlaying)
        assertEquals(40, z.volume)
        assertEquals("al-3-abc", z.nowPlaying!!.imageKey)
        assertEquals(245, z.nowPlaying!!.lengthSeconds)
    }

    @Test fun `no zone is a normal answer`() {
        assertNull(ZoneState.parse(JSONObject("""{"zone": null, "revision": 3}""")).zone)
    }

    @Test fun `zones carry the last room`() {
        val z = Zones.parse(JSONObject("""{"zones":[{"zone_id":"A","display_name":"Kitchen","state":"paused"}],"last_zone":"A"}"""))
        assertEquals("A", z.lastZone)
        assertEquals("Kitchen", z.zones[0].name)
    }

    @Test fun `health must come from a MusicD Server`() {
        assertEquals(12, Health.parse(JSONObject("""{"ok":true,"version":"0.1.0","albums":12,"rooms":2,"ffmpeg":true}""")).albums)
        try {
            Health.parse(JSONObject("""{"status":"fine"}"""))
            throw AssertionError("should have refused")
        } catch (e: IllegalArgumentException) { /* expected */ }
    }
}
