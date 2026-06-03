package com.tetherproxy.app.tunnel

import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import org.json.JSONObject

/** Frozen tunnel frame types: [1B type][4B streamId BE][payload]. */
enum class FrameType(val code: Int) {
    AUTH(0x01),
    AUTH_OK(0x02),
    AUTH_FAIL(0x03),
    OPEN(0x10),
    OPEN_OK(0x11),
    OPEN_FAIL(0x12),
    DATA(0x20),
    CLOSE(0x21),
    PING(0x30),
    PONG(0x31);

    companion object {
        private val byCode = values().associateBy { it.code }
        fun fromCode(code: Int): FrameType? = byCode[code]
    }
}

/** A decoded frame. */
data class Frame(val type: FrameType, val streamId: Int, val payload: ByteArray) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Frame) return false
        return type == other.type &&
            streamId == other.streamId &&
            payload.contentEquals(other.payload)
    }

    override fun hashCode(): Int {
        var result = type.hashCode()
        result = 31 * result + streamId
        result = 31 * result + payload.contentHashCode()
        return result
    }
}

object Frames {
    const val HEADER_SIZE = 5

    /** Encode to the frozen wire layout. streamId is written big-endian. */
    fun encode(type: FrameType, streamId: Int, payload: ByteArray): ByteArray {
        val buf = ByteBuffer.allocate(HEADER_SIZE + payload.size)
        buf.put(type.code.toByte())
        buf.putInt(streamId) // ByteBuffer is big-endian by default
        buf.put(payload)
        return buf.array()
    }

    /** Decode the frozen wire layout. Throws IllegalArgumentException on malformed input. */
    fun decode(bytes: ByteArray): Frame {
        require(bytes.size >= HEADER_SIZE) {
            "frame too short: ${bytes.size} bytes (need >= $HEADER_SIZE)"
        }
        val buf = ByteBuffer.wrap(bytes)
        val typeCode = buf.get().toInt() and 0xFF
        val type = FrameType.fromCode(typeCode)
            ?: throw IllegalArgumentException("unknown frame type: 0x${typeCode.toString(16)}")
        val streamId = buf.getInt()
        val payload = ByteArray(bytes.size - HEADER_SIZE)
        buf.get(payload)
        return Frame(type, streamId, payload)
    }

    /** Build the AUTH JSON payload using the frozen field names. */
    fun authJson(
        pairingToken: String,
        deviceId: String,
        proxyUsername: String,
        proxyPassword: String
    ): String = JSONObject()
        .put("pairingToken", pairingToken)
        .put("deviceId", deviceId)
        .put("proxyUsername", proxyUsername)
        .put("proxyPassword", proxyPassword)
        .toString()

    /** Parse a flat JSON object into a string->string map (values stringified). */
    fun parseJson(json: String): Map<String, String> {
        val obj = JSONObject(json)
        val out = HashMap<String, String>()
        val it = obj.keys()
        while (it.hasNext()) {
            val key = it.next()
            out[key] = obj.get(key).toString()
        }
        return out
    }

    fun utf8(s: String): ByteArray = s.toByteArray(StandardCharsets.UTF_8)
}
