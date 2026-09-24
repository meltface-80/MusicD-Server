package com.musicd.server.client

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue

class RouteTest {
    private val home = "http://192.168.1.10:3500"
    private val away = "http://100.101.102.103:3500"

    @Test fun awayOffWifiWhateverAnswers() {
        assertTrue(Route.away(onWifi = false, homeAnswers = true))
        assertTrue(Route.away(onWifi = false, homeAnswers = false))
        assertTrue(Route.away(onWifi = true, homeAnswers = false))
        assertFalse(Route.away(onWifi = true, homeAnswers = true))
    }

    @Test fun streamsGoAwayAsOpus() {
        val u = "$home/stream/t12.flac?s=abcdefghijklmnopqrstuv"
        assertEquals("$away/stream/t12.flac?s=abcdefghijklmnopqrstuv&q=opus", Route.rewrite(u, home, away, true))
        assertEquals(u, Route.rewrite(u, home, away, false))
        // Back home: lossless again.
        assertEquals(u, Route.rewrite("$away/stream/t12.flac?s=abcdefghijklmnopqrstuv&q=opus", home, away, false))
        // Already away: not asked twice.
        val a = "$away/stream/t12.flac?s=abcdefghijklmnopqrstuv&q=opus"
        assertEquals(a, Route.rewrite(a, home, away, true))
    }

    @Test fun artMovesButStaysArt() {
        val u = "$home/api/image/al-3-0?size=600&s=abcdefghijklmnopqrstuv"
        assertEquals("$away/api/image/al-3-0?size=600&s=abcdefghijklmnopqrstuv", Route.rewrite(u, home, away, true))
    }

    @Test fun otherAddressesAndNoAwayAreLeftAlone() {
        val other = "https://is1-ssl.mzstatic.com/image/x.jpg"
        assertEquals(other, Route.rewrite(other, home, away, true))
        val u = "$home/stream/t1.flac?s=x"
        assertEquals(u, Route.rewrite(u, home, null, true))
    }

    @Test fun addressesFromTheServer() {
        assertEquals(ServerAddress("100.101.102.103", 3500), ServerAddress.fromUrl("http://100.101.102.103:3500"))
        val ts = ServerAddress.fromUrl("https://musicd.tail1234.ts.net")!!
        assertEquals(443, ts.port)
        assertEquals("https://musicd.tail1234.ts.net:443", ts.baseUrl)
        assertEquals(80, ServerAddress.fromUrl("http://musicd")!!.port)
        assertNull(ServerAddress.fromUrl("musicd:3500"))
        assertNull(ServerAddress.fromUrl(""))
    }
}
