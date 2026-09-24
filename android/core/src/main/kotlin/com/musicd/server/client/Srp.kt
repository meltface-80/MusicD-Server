package com.musicd.server.client

import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Signing in without the password crossing the network — the Kotlin twin of
 * the server's public/srp.js, and it must agree with it to the byte
 * (SrpTest checks the same fixed example the server's tests use).
 *
 * SRP-6a, RFC 5054's 2048-bit group, SHA-256; the password is stretched with
 * PBKDF2-HMAC-SHA256 first:
 *
 *   x = H(salt | H(username | ":" | PBKDF2(password, salt, iterations, 32)))
 *   v = g^x      A = g^a      B = k·v + g^b      k = H(N | PAD(g))
 *   u = H(PAD(A) | PAD(B))    S = (B − k·g^x)^(a + u·x)
 *   K = H(PAD(S))   M1 = H(PAD(A) | PAD(B) | K)   M2 = H(PAD(A) | M1 | K)
 *
 * PBKDF2 is written out rather than taken from the platform, because Android's
 * providers have differed in how they turn a password's characters into bytes.
 */
object Srp {
    const val ITERATIONS = 100_000

    private val N = BigInteger(
        "AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310D" +
        "CD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF74" +
        "7359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D" +
        "5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB6" +
        "94B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73", 16
    )
    private val g = BigInteger.valueOf(2)
    private const val NLEN = 256
    private val random = SecureRandom()
    private val k: BigInteger by lazy { big(h(pad(N), pad(g))) }

    class Start(val a: BigInteger, val A: String)
    class Proof(val M1: String, val expectM2: String, val K: String)
    class ServerStart(val b: BigInteger, val v: BigInteger, val B: String)
    class ServerResult(val ok: Boolean, val M2: String? = null)
    class Verifier(val salt: String, val verifier: String)

    fun normUser(username: String) = username.trim().lowercase()

    /** Account creation, on the phone: salt and verifier (hex) for the server. */
    fun makeVerifier(username: String, password: String, iterations: Int = ITERATIONS, saltHex: String? = null): Verifier {
        val salt = saltHex ?: hex(ByteArray(16).also { random.nextBytes(it) })
        val x = privateKey(username, password, salt, iterations)
        return Verifier(salt, hex(pad(g.modPow(x, N))))
    }

    fun clientStart(aHex: String? = null): Start {
        val a = if (aHex != null) BigInteger(aHex, 16) else big(ByteArray(32).also { random.nextBytes(it) })
        return Start(a, hex(pad(g.modPow(a, N))))
    }

    fun clientProof(username: String, password: String, saltHex: String, iterations: Int, start: Start, BHex: String): Proof {
        val B = BigInteger(BHex, 16)
        require(B.mod(N).signum() != 0) { "bad server value" }
        val A = BigInteger(start.A, 16)
        val u = big(h(pad(A), pad(B)))
        require(u.signum() != 0) { "bad server value" }
        val x = privateKey(username, password, saltHex, iterations)
        val base = B.subtract(k.multiply(g.modPow(x, N)).mod(N)).mod(N)
        val S = base.modPow(start.a.add(u.multiply(x)), N)
        val K = h(pad(S))
        val M1 = h(pad(A), pad(B), K)
        val M2 = h(pad(A), M1, K)
        return Proof(hex(M1), hex(M2), hex(K))
    }

    // The server's half — used by the tests to check the two sides meet.
    fun serverStart(verifierHex: String, bHex: String? = null): ServerStart {
        val v = BigInteger(verifierHex, 16)
        val b = if (bHex != null) BigInteger(bHex, 16) else big(ByteArray(32).also { random.nextBytes(it) })
        val B = k.multiply(v).add(g.modPow(b, N)).mod(N)
        return ServerStart(b, v, hex(pad(B)))
    }

    fun serverVerify(start: ServerStart, AHex: String, M1Hex: String): ServerResult {
        val A = BigInteger(AHex, 16)
        if (A.mod(N).signum() == 0) return ServerResult(false)
        val B = BigInteger(start.B, 16)
        val u = big(h(pad(A), pad(B)))
        if (u.signum() == 0) return ServerResult(false)
        val S = A.multiply(start.v.modPow(u, N)).mod(N).modPow(start.b, N)
        val K = h(pad(S))
        val M1 = h(pad(A), pad(B), K)
        if (!MessageDigest.isEqual(hex(M1).toByteArray(), M1Hex.lowercase().toByteArray())) return ServerResult(false)
        return ServerResult(true, hex(h(pad(A), M1, K)))
    }

    // ------------------------------------------------------------ helpers

    private fun privateKey(username: String, password: String, saltHex: String, iterations: Int): BigInteger {
        val salt = unhex(saltHex)
        val stretched = pbkdf2(password.toByteArray(Charsets.UTF_8), salt, iterations)
        return big(h(salt, h(normUser(username).toByteArray(Charsets.UTF_8), ":".toByteArray(), stretched)))
    }

    fun pbkdf2(password: ByteArray, salt: ByteArray, iterations: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        // HMAC pads a short key with zeros, so an empty password is the same
        // as 64 zero bytes (which SecretKeySpec, unlike an empty key, accepts).
        mac.init(SecretKeySpec(if (password.isEmpty()) ByteArray(64) else password, "HmacSHA256"))
        mac.update(salt)
        mac.update(byteArrayOf(0, 0, 0, 1))
        var u = mac.doFinal()
        val out = u.copyOf()
        for (i in 1 until iterations) {
            u = mac.doFinal(u)
            for (j in out.indices) out[j] = (out[j].toInt() xor u[j].toInt()).toByte()
        }
        return out
    }

    fun h(vararg parts: ByteArray): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        for (p in parts) md.update(p)
        return md.digest()
    }

    private fun pad(n: BigInteger): ByteArray {
        val b = n.toByteArray().let { if (it.size > 1 && it[0] == 0.toByte()) it.copyOfRange(1, it.size) else it }
        if (b.size >= NLEN) return b
        return ByteArray(NLEN - b.size) + b
    }

    private fun big(b: ByteArray) = BigInteger(1, b)

    fun hex(b: ByteArray): String {
        val sb = StringBuilder(b.size * 2)
        for (x in b) sb.append(String.format("%02x", x.toInt() and 0xff))
        return sb.toString()
    }

    fun unhex(s: String): ByteArray {
        require(s.length % 2 == 0) { "bad hex" }
        return ByteArray(s.length / 2) { i -> s.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }
}
