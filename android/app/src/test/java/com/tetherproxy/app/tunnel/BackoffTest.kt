package com.tetherproxy.app.tunnel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class BackoffTest {

    @Test
    fun baseDelay_doublesAndCapsAt30s() {
        val b = Backoff(baseMs = 1000, capMs = 30000, jitterFraction = 0.0)
        assertEquals(1000L, b.baseDelayMs(0))
        assertEquals(2000L, b.baseDelayMs(1))
        assertEquals(4000L, b.baseDelayMs(2))
        assertEquals(8000L, b.baseDelayMs(3))
        assertEquals(16000L, b.baseDelayMs(4))
        assertEquals(30000L, b.baseDelayMs(5)) // 32000 -> capped
        assertEquals(30000L, b.baseDelayMs(6))
        assertEquals(30000L, b.baseDelayMs(50))
    }

    @Test
    fun nextDelay_advancesAttemptAndFollowsSequence() {
        val b = Backoff(baseMs = 1000, capMs = 30000, jitterFraction = 0.0, rng = Random(1))
        assertEquals(1000L, b.nextDelayMs())
        assertEquals(2000L, b.nextDelayMs())
        assertEquals(4000L, b.nextDelayMs())
        assertEquals(8000L, b.nextDelayMs())
        assertEquals(16000L, b.nextDelayMs())
        assertEquals(30000L, b.nextDelayMs())
        assertEquals(30000L, b.nextDelayMs())
    }

    @Test
    fun reset_returnsToFirstDelay() {
        val b = Backoff(baseMs = 1000, capMs = 30000, jitterFraction = 0.0)
        b.nextDelayMs()
        b.nextDelayMs()
        b.reset()
        assertEquals(1000L, b.nextDelayMs())
    }

    @Test
    fun jitter_staysWithinBaseAndBasePlusFraction() {
        val b = Backoff(baseMs = 1000, capMs = 30000, jitterFraction = 0.5, rng = Random(123))
        repeat(200) {
            val base = b.baseDelayMs(b.attempt())
            val delay = b.nextDelayMs()
            assertTrue("delay $delay >= base $base", delay >= base)
            assertTrue("delay $delay <= base*1.5", delay <= base + (base * 0.5).toLong())
        }
    }

    @Test
    fun negativeAttempt_treatedAsZero() {
        val b = Backoff(baseMs = 1000, capMs = 30000, jitterFraction = 0.0)
        assertEquals(1000L, b.baseDelayMs(-5))
    }
}
