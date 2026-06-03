package com.tetherproxy.app.tunnel

import java.io.IOException
import java.io.InputStream

/**
 * Pure, blocking stream pump. Reads [source] into a reusable buffer and emits
 * each chunk to [onChunk]; calls [onClosed] exactly once when reading finishes
 * (EOF or IOException). If [onChunk] throws, [onClosed] still runs before the
 * exception propagates.
 */
object Piping {
    fun pump(
        source: InputStream,
        bufferSize: Int,
        onChunk: (buffer: ByteArray, length: Int) -> Unit,
        onClosed: () -> Unit
    ) {
        val buffer = ByteArray(bufferSize)
        try {
            while (true) {
                val read = try {
                    source.read(buffer, 0, bufferSize)
                } catch (e: IOException) {
                    -1
                }
                if (read <= 0) break
                onChunk(buffer, read)
            }
        } finally {
            onClosed()
        }
    }
}
