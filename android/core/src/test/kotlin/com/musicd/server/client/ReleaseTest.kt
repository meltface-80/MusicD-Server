package com.musicd.server.client

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReleaseTest {
    @Test fun versionsCompareByNumber() {
        assertTrue(Release.compare("0.3.10", "0.3.9") > 0)
        assertTrue(Release.compare("0.4.0", "0.3.99") > 0)
        assertEquals(0, Release.compare("v0.3.4", "0.3.4"))
        assertTrue(Release.compare("0.3.3", "0.3.4") < 0)
        assertEquals(0, Release.compare("0.3", "0.3.0"))
    }

    @Test fun latestJsonAsPublished() {
        val r = Release.parse(JSONObject("""
            {"version": "0.3.4",
             "url": "https://github.com/meltface-80/MusicD-Server/raw/main/dist/musicd-server-android-0.3.4-debug.apk",
             "sha256": "ABCDEF"}
        """))!!
        assertEquals("abcdef", r.sha256)
        assertTrue(r.newerThan("0.3.3"))
        assertFalse(r.newerThan("0.3.4"))
        assertNull(Release.parse(JSONObject("""{"version": "0.3.4", "url": "http://example.com/a.apk"}""")))
        assertNull(Release.parse(JSONObject("{}")))
    }
}
