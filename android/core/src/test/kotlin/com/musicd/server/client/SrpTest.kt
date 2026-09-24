package com.musicd.server.client

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

class SrpTest {
    // The server's own fixed example (test/srp-vector.json at the repo root):
    // phone and server must produce exactly the same numbers.
    private val v: JSONObject by lazy {
        val f = listOf("../../test/srp-vector.json", "../test/srp-vector.json", "test/srp-vector.json")
            .map { File(it) }.first { it.exists() }
        JSONObject(f.readText())
    }

    @Test fun `matches the server's fixed example to the byte`() {
        val ver = Srp.makeVerifier(v.getString("username"), v.getString("password"), v.getInt("iterations"), v.getString("salt"))
        assertEquals(v.getString("verifier"), ver.verifier)
        val cs = Srp.clientStart(v.getString("a"))
        assertEquals(v.getString("A"), cs.A)
        val ss = Srp.serverStart(v.getString("verifier"), v.getString("b"))
        assertEquals(v.getString("B"), ss.B)
        val p = Srp.clientProof(v.getString("username"), v.getString("password"), v.getString("salt"), v.getInt("iterations"), cs, v.getString("B"))
        assertEquals(v.getString("M1"), p.M1)
        assertEquals(v.getString("K"), p.K)
        assertEquals(v.getString("M2"), Srp.serverVerify(ss, v.getString("A"), v.getString("M1")).M2)
    }

    @Test fun `right password in, wrong password out`() {
        val ver = Srp.makeVerifier("Someone", "right", 1000)
        val cs = Srp.clientStart()
        val ss = Srp.serverStart(ver.verifier)
        val ok = Srp.clientProof(" someone ", "right", ver.salt, 1000, cs, ss.B)
        val r = Srp.serverVerify(ss, cs.A, ok.M1)
        assertTrue(r.ok)
        assertEquals(ok.expectM2, r.M2)
        val bad = Srp.clientProof("someone", "wrong", ver.salt, 1000, cs, ss.B)
        assertFalse(Srp.serverVerify(ss, cs.A, bad.M1).ok)
    }

    @Test fun `PBKDF2 matches the JVM's own`() {
        val salt = Srp.unhex("00112233445566778899aabbccddeeff")
        val mine = Srp.pbkdf2("plain ascii".toByteArray(), salt, 1500)
        val theirs = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
            .generateSecret(PBEKeySpec("plain ascii".toCharArray(), salt, 1500, 256)).encoded
        assertEquals(Srp.hex(theirs), Srp.hex(mine))
    }
}
