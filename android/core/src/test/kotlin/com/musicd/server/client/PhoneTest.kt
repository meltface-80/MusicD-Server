package com.musicd.server.client

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhoneTest {
    @Test fun `commands are read from the server's shape`() {
        val b = Phone.parseBatch(JSONObject("""
            {"seq": 7, "commands": [
              {"seq": 5, "op": "load", "index": 1, "seconds": 12.5, "play": true, "items": [
                {"url": "http://s/stream/t1.flac?s=x", "track_id": 1, "title": "Song 1", "artist": "A", "album": "Al", "art_url": "http://s/api/image/al-1-x?s=y", "duration": 180.2},
                {"url": "http://s/stream/t2.flac?s=x", "track_id": null, "title": "Song 2", "artist": "A", "album": "Al", "art_url": "", "duration": 200}]},
              {"seq": 6, "op": "volume", "value": 30},
              {"seq": 7, "op": "mode", "shuffle": true, "loop": "loop_one"}]}
        """))
        assertEquals(7L, b.seq)
        val load = b.commands[0]
        assertEquals("load", load.op)
        assertEquals(1, load.index)
        assertEquals(12.5, load.seconds, 0.0)
        assertEquals(2, load.items.size)
        assertEquals(1L, load.items[0].trackId)
        assertNull(load.items[1].trackId)
        assertNull(load.items[1].artUrl)
        assertEquals(30, b.commands[1].value)
        assertEquals("loop_one", b.commands[2].loop)
    }

    @Test fun `a report goes out in the server's shape`() {
        val j = Phone.Report(2, 31.5, 180.0, "playing", false, "disabled", 40, false).toJson()
        assertEquals(2, j.getInt("index"))
        assertEquals("playing", j.getString("state"))
        assertEquals(40, j.getInt("volume"))
    }
}
