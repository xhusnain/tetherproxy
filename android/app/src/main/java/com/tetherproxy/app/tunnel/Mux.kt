package com.tetherproxy.app.tunnel

import java.net.Socket
import java.util.concurrent.ConcurrentHashMap

/** Thread-safe streamId -> Socket registry mirroring the relay's mux. */
class Mux {
    private val streams = ConcurrentHashMap<Int, Socket>()

    fun put(streamId: Int, socket: Socket) {
        streams[streamId] = socket
    }

    fun get(streamId: Int): Socket? = streams[streamId]

    fun remove(streamId: Int): Socket? = streams.remove(streamId)

    fun contains(streamId: Int): Boolean = streams.containsKey(streamId)

    fun size(): Int = streams.size

    fun streamIds(): Set<Int> = streams.keys.toSet()

    /** Atomically drains every stream, returning the removed sockets. */
    fun removeAll(): List<Socket> {
        val snapshot = ArrayList(streams.values)
        streams.clear()
        return snapshot
    }
}
