package com.tetherproxy.app.tunnel

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FramesTest {

    @Test
    fun typeCodes_matchFrozenProtocol() {
        assertEquals(0x01, FrameType.AUTH.code)
        assertEquals(0x02, FrameType.AUTH_OK.code)
        assertEquals(0x03, FrameType.AUTH_FAIL.code)
        assertEquals(0x10, FrameType.OPEN.code)
        assertEquals(0x11, FrameType.OPEN_OK.code)
        assertEquals(0x12, FrameType.OPEN_FAIL.code)
        assertEquals(0x20, FrameType.DATA.code)
        assertEquals(0x21, FrameType.CLOSE.code)
        assertEquals(0x30, FrameType.PING.code)
        assertEquals(0x31, FrameType.PONG.code)
    }

    @Test
    fun fromCode_resolvesEveryType() {
        for (t in FrameType.values()) {
            assertEquals(t, FrameType.fromCode(t.code))
        }
        assertNull(FrameType.fromCode(0x99))
    }

    @Test
    fun encode_layoutIsTypeThenBigEndianStreamIdThenPayload() {
        val bytes = Frames.encode(FrameType.DATA, 0x01020304, byteArrayOf(0xAA.toByte(), 0xBB.toByte()))
        assertArrayEquals(
            byteArrayOf(0x20, 0x01, 0x02, 0x03, 0x04, 0xAA.toByte(), 0xBB.toByte()),
            bytes
        )
    }

    @Test
    fun encode_streamIdZeroForControlFrames() {
        val bytes = Frames.encode(FrameType.PING, 0, ByteArray(0))
        assertArrayEquals(byteArrayOf(0x30, 0x00, 0x00, 0x00, 0x00), bytes)
    }

    @Test
    fun encode_handlesHighBitStreamId() {
        val bytes = Frames.encode(FrameType.CLOSE, 0xFFFFFFFF.toInt(), ByteArray(0))
        assertArrayEquals(
            byteArrayOf(0x21, 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte()),
            bytes
        )
    }

    @Test
    fun decode_roundTripsEveryFrameType() {
        val payloads = mapOf(
            FrameType.AUTH to """{"pairingToken":"t"}""".toByteArray(),
            FrameType.AUTH_OK to ByteArray(0),
            FrameType.AUTH_FAIL to """{"reason":"bad"}""".toByteArray(),
            FrameType.OPEN to """{"host":"api.example.com","port":443}""".toByteArray(),
            FrameType.OPEN_OK to ByteArray(0),
            FrameType.OPEN_FAIL to """{"reason":"refused"}""".toByteArray(),
            FrameType.DATA to byteArrayOf(1, 2, 3, 4, 5),
            FrameType.CLOSE to ByteArray(0),
            FrameType.PING to ByteArray(0),
            FrameType.PONG to ByteArray(0)
        )
        var streamId = 7
        for ((type, payload) in payloads) {
            val encoded = Frames.encode(type, streamId, payload)
            val decoded = Frames.decode(encoded)
            assertEquals(type, decoded.type)
            assertEquals(streamId, decoded.streamId)
            assertArrayEquals(payload, decoded.payload)
            streamId++
        }
    }

    @Test
    fun decode_unknownTypeThrows() {
        try {
            Frames.decode(byteArrayOf(0x99.toByte(), 0, 0, 0, 1))
            throw AssertionError("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }

    @Test
    fun decode_tooShortThrows() {
        try {
            Frames.decode(byteArrayOf(0x20, 0, 0))
            throw AssertionError("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }

    @Test
    fun jsonHelpers_buildAndParseControlPayloads() {
        val auth = Frames.authJson(
            pairingToken = "tok",
            deviceId = "dev-1",
            proxyUsername = "user",
            proxyPassword = "pass"
        )
        val parsed = Frames.parseJson(auth)
        assertEquals("tok", parsed["pairingToken"])
        assertEquals("dev-1", parsed["deviceId"])
        assertEquals("user", parsed["proxyUsername"])
        assertEquals("pass", parsed["proxyPassword"])

        val open = """{"host":"h.example.com","port":8443}"""
        val openParsed = Frames.parseJson(open)
        assertEquals("h.example.com", openParsed["host"])
        assertEquals("8443", openParsed["port"])
    }
}
