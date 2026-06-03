package com.tetherproxy.app.tunnel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.Socket

class MuxTest {

    @Test
    fun put_thenGet_returnsSameSocket() {
        val mux = Mux()
        val s = Socket()
        mux.put(42, s)
        assertSame(s, mux.get(42))
    }

    @Test
    fun get_missingStream_returnsNull() {
        val mux = Mux()
        assertNull(mux.get(99))
    }

    @Test
    fun remove_returnsSocketAndDropsIt() {
        val mux = Mux()
        val s = Socket()
        mux.put(1, s)
        assertSame(s, mux.remove(1))
        assertNull(mux.get(1))
    }

    @Test
    fun remove_missingStream_returnsNull() {
        val mux = Mux()
        assertNull(mux.remove(7))
    }

    @Test
    fun contains_reflectsPresence() {
        val mux = Mux()
        assertFalse(mux.contains(5))
        mux.put(5, Socket())
        assertTrue(mux.contains(5))
        mux.remove(5)
        assertFalse(mux.contains(5))
    }

    @Test
    fun size_andStreamIds_trackEntries() {
        val mux = Mux()
        assertEquals(0, mux.size())
        mux.put(1, Socket())
        mux.put(2, Socket())
        assertEquals(2, mux.size())
        assertEquals(setOf(1, 2), mux.streamIds())
    }

    @Test
    fun removeAll_returnsSnapshotAndClears() {
        val mux = Mux()
        val a = Socket()
        val b = Socket()
        mux.put(1, a)
        mux.put(2, b)
        val snapshot = mux.removeAll()
        assertEquals(2, snapshot.size)
        assertTrue(snapshot.contains(a))
        assertTrue(snapshot.contains(b))
        assertEquals(0, mux.size())
    }
}
