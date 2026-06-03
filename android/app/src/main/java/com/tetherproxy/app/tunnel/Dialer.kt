package com.tetherproxy.app.tunnel

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket

/** What a Dialer needs from its owner to talk back over the tunnel + count bytes. */
interface DialerSink {
    /** Send a frame back to the relay. */
    fun send(type: FrameType, streamId: Int, payload: ByteArray): Boolean
    /** Report bytes read from the target socket (tunnel "in" from target's perspective). */
    fun addBytesIn(n: Long)
    /** Report bytes written to the target socket. */
    fun addBytesOut(n: Long)
    /** Active stream count changed. */
    fun onActiveStreamsChanged(count: Int)
}

/**
 * For each OPEN(host, port) opens a raw TCP socket over the phone's current network,
 * replies OPEN_OK or OPEN_FAIL, then pumps target->WS as DATA frames in a coroutine.
 * DATA from the relay is written to the target via [onData]; CLOSE tears the stream down.
 */
class Dialer(
    private val scope: CoroutineScope,
    private val mux: Mux,
    private val sink: DialerSink,
    private val connectTimeoutMs: Int = 15000,
    private val bufferSize: Int = 16 * 1024
) {
    /** Handle an OPEN frame: connect, reply, and start the target->WS pump. */
    fun onOpen(streamId: Int, host: String, port: Int) {
        scope.launch(Dispatchers.IO) {
            val socket = Socket()
            try {
                socket.connect(InetSocketAddress(host, port), connectTimeoutMs)
            } catch (e: Exception) {
                runCatching { socket.close() }
                sink.send(
                    FrameType.OPEN_FAIL,
                    streamId,
                    openFailJson(e.message ?: "connect failed")
                )
                return@launch
            }
            mux.put(streamId, socket)
            sink.onActiveStreamsChanged(mux.size())
            sink.send(FrameType.OPEN_OK, streamId, ByteArray(0))

            // Pump target -> WS until EOF/error, then CLOSE + cleanup.
            try {
                Piping.pump(
                    source = socket.getInputStream(),
                    bufferSize = bufferSize,
                    onChunk = { buf, len ->
                        val slice = buf.copyOf(len)
                        sink.send(FrameType.DATA, streamId, slice)
                        sink.addBytesIn(len.toLong())
                    },
                    onClosed = { }
                )
            } finally {
                teardown(streamId, sendClose = true)
            }
        }
    }

    /** Handle a DATA frame from the relay: write the bytes to the target socket. */
    fun onData(streamId: Int, payload: ByteArray) {
        val socket = mux.get(streamId) ?: return
        scope.launch(Dispatchers.IO) {
            try {
                val out: OutputStream = socket.getOutputStream()
                out.write(payload)
                out.flush()
                sink.addBytesOut(payload.size.toLong())
            } catch (e: Exception) {
                teardown(streamId, sendClose = true)
            }
        }
    }

    /** Handle a CLOSE frame from the relay: drop the stream without echoing CLOSE. */
    fun onClose(streamId: Int) {
        teardown(streamId, sendClose = false)
    }

    /** Drop every active stream (used on tunnel loss / shutdown). */
    fun closeAll() {
        for (socket in mux.removeAll()) {
            runCatching { socket.close() }
        }
        sink.onActiveStreamsChanged(0)
    }

    private fun teardown(streamId: Int, sendClose: Boolean) {
        val socket = mux.remove(streamId) ?: return
        runCatching { socket.close() }
        if (sendClose) {
            sink.send(FrameType.CLOSE, streamId, ByteArray(0))
        }
        sink.onActiveStreamsChanged(mux.size())
    }

    private fun openFailJson(reason: String): ByteArray =
        Frames.utf8("""{"reason":${quote(reason)}}""")

    private fun quote(s: String): String {
        val sb = StringBuilder("\"")
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> sb.append(c)
            }
        }
        sb.append("\"")
        return sb.toString()
    }
}
