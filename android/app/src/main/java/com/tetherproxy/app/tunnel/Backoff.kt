package com.tetherproxy.app.tunnel

import kotlin.random.Random

/**
 * Pure exponential-backoff-with-jitter generator.
 * base sequence = baseMs * 2^attempt, capped at capMs.
 * jitter adds rng-chosen [0, jitterFraction*base) extra ms.
 */
class Backoff(
    private val baseMs: Long = 1000,
    private val capMs: Long = 30000,
    private val jitterFraction: Double = 0.3,
    private val rng: Random = Random.Default
) {
    private var attempt = 0

    fun attempt(): Int = attempt

    /** The capped base delay for a given attempt (no jitter). */
    fun baseDelayMs(attempt: Int): Long {
        val a = if (attempt < 0) 0 else attempt
        // Avoid overflow for large attempts by capping the shift.
        if (a >= 32) return capMs
        val raw = baseMs shl a
        return if (raw > capMs || raw < 0) capMs else raw
    }

    /** Returns the next delay (with jitter) and advances the attempt counter. */
    fun nextDelayMs(): Long {
        val base = baseDelayMs(attempt)
        val jitterMax = (base * jitterFraction).toLong()
        val jitter = if (jitterMax > 0) rng.nextLong(jitterMax + 1) else 0L
        attempt++
        return base + jitter
    }

    /** Reset the attempt counter after a successful connection. */
    fun reset() {
        attempt = 0
    }
}
