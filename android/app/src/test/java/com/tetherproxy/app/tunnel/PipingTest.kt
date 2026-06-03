package com.tetherproxy.app.tunnel

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream

class PipingTest {

    @Test
    fun pump_forwardsAllBytesInChunks_thenSignalsClose() {
        val input = ByteArrayInputStream(ByteArray(10) { it.toByte() })
        val collected = ByteArrayOutputStream()
        var closedCount = 0

        Piping.pump(
            source = input,
            bufferSize = 4,
            onChunk = { buf, len -> collected.write(buf, 0, len) },
            onClosed = { closedCount++ }
        )

        assertArrayEquals(ByteArray(10) { it.toByte() }, collected.toByteArray())
        assertEquals(1, closedCount)
    }

    @Test
    fun pump_emptySource_signalsCloseImmediately() {
        val input = ByteArrayInputStream(ByteArray(0))
        var closedCount = 0
        var chunkCount = 0
        Piping.pump(
            source = input,
            bufferSize = 8,
            onChunk = { _, _ -> chunkCount++ },
            onClosed = { closedCount++ }
        )
        assertEquals(0, chunkCount)
        assertEquals(1, closedCount)
    }

    @Test
    fun pump_chunkBoundariesMatchBufferSize() {
        val input = ByteArrayInputStream(ByteArray(9) { it.toByte() })
        val chunkLens = ArrayList<Int>()
        Piping.pump(
            source = input,
            bufferSize = 4,
            onChunk = { _, len -> chunkLens.add(len) },
            onClosed = { }
        )
        // 4 + 4 + 1
        assertEquals(listOf(4, 4, 1), chunkLens)
    }

    @Test
    fun pump_ioExceptionMidStream_stillSignalsCloseOnce() {
        val failing = object : InputStream() {
            private var n = 0
            override fun read(): Int = throw IOException("single-byte read not used")
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                n++
                if (n == 1) {
                    b[off] = 1
                    return 1
                }
                throw IOException("boom")
            }
        }
        var closedCount = 0
        var chunkCount = 0
        Piping.pump(
            source = failing,
            bufferSize = 4,
            onChunk = { _, _ -> chunkCount++ },
            onClosed = { closedCount++ }
        )
        assertEquals(1, chunkCount)
        assertEquals(1, closedCount)
    }

    @Test
    fun pump_onChunkThrows_propagatesButStillCloses() {
        val input = ByteArrayInputStream(ByteArray(4) { it.toByte() })
        var closedCount = 0
        var thrown = false
        try {
            Piping.pump(
                source = input,
                bufferSize = 4,
                onChunk = { _, _ -> throw IllegalStateException("ws closed") },
                onClosed = { closedCount++ }
            )
        } catch (e: IllegalStateException) {
            thrown = true
        }
        assertTrue(thrown)
        assertEquals(1, closedCount)
    }
}
