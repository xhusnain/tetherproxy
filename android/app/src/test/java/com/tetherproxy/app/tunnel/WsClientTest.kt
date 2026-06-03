package com.tetherproxy.app.tunnel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest

/**
 * Verifies WsClient.sha256Hex produces the exact format the relay prints and pins
 * against: colon-separated UPPERCASE hex pairs, identical to
 * `openssl x509 -fingerprint -sha256`. The relay test asserts the same regex.
 */
class WsClientTest {

    @Test
    fun `sha256Hex matches relay colon-separated uppercase format`() {
        val der = "tetherproxy".toByteArray(Charsets.UTF_8)
        val fp = WsClient.sha256Hex(der)
        // 32 bytes => 31 colon-separated uppercase hex pairs + 1 (relay's exact regex).
        assertTrue(
            "got: $fp",
            Regex("^([0-9A-F]{2}:){31}[0-9A-F]{2}$").matches(fp)
        )
    }

    @Test
    fun `normFp strips colons and spaces and lowercases`() {
        // All three forms should normalize to the same string.
        val colonForm  = "AA:BB:CC:DD"
        val plainLower = "aabbccdd"
        val spacedUpper = "AA BB CC DD"
        assertEquals(WsClient.normFp(colonForm), WsClient.normFp(plainLower))
        assertEquals(WsClient.normFp(colonForm), WsClient.normFp(spacedUpper))
        assertEquals("aabbccdd", WsClient.normFp(colonForm))
    }

    @Test
    fun `close marks the client superseded so its onClosed is ignored`() {
        // A no-op events sink; close() must not require a live socket or Android.
        val events = object : WsEvents {
            override fun onOpen() {}
            override fun onFrame(frame: Frame) {}
            override fun onAuthOk() {}
            override fun onAuthFail(reason: String) {}
            override fun onClosed(reason: String) {}
        }
        val client = WsClient(
            host = "example.test",
            port = 443,
            pinnedSha256Hex = "",
            authPayload = ByteArray(0),
            events = events,
            onPinObserved = {}
        )
        // Fresh client is not superseded; close() must flip the flag so a stale
        // socket's onClosed callback cannot re-enter the reconnect loop.
        assertFalse(client.isSuperseded())
        client.close()
        assertTrue(client.isSuperseded())
    }

    @Test
    fun `sha256Hex equals openssl-style fingerprint of the digest`() {
        val der = byteArrayOf(0x01, 0x02, 0x03, 0x7C, 0xF1.toByte(), 0x20, 0xF7.toByte())
        val expected = MessageDigest.getInstance("SHA-256")
            .digest(der)
            .joinToString(":") { String.format("%02X", it.toInt() and 0xFF) }
        assertEquals(expected, WsClient.sha256Hex(der))
    }
}
