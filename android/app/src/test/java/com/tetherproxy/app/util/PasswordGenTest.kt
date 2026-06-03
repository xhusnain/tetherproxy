package com.tetherproxy.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

class PasswordGenTest {

    private val lower = "abcdefghijklmnopqrstuvwxyz".toSet()
    private val upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".toSet()
    private val digits = "0123456789".toSet()
    private val symbols = "-._~".toSet()
    private val allowed = lower + upper + digits + symbols

    @Test
    fun generate_defaultLengthIs20() {
        val pw = PasswordGen.generate(random = Random(1))
        assertEquals(20, pw.length)
    }

    @Test
    fun generate_returnsRequestedLength() {
        val pw = PasswordGen.generate(length = 32, random = Random(7))
        assertEquals(32, pw.length)
    }

    @Test
    fun generate_everyCharIsInAllowedCharset() {
        val pw = PasswordGen.generate(length = 40, random = Random(42))
        for (c in pw) {
            assertTrue("char '$c' not in allowed charset", allowed.contains(c))
        }
    }

    @Test
    fun generate_containsAtLeastOneOfEachClass() {
        // Run across many seeds to be confident the guarantee always holds.
        for (seed in 0L until 200L) {
            val pw = PasswordGen.generate(length = 4, random = Random(seed))
            assertTrue("seed $seed missing lowercase: $pw", pw.any { lower.contains(it) })
            assertTrue("seed $seed missing uppercase: $pw", pw.any { upper.contains(it) })
            assertTrue("seed $seed missing digit: $pw", pw.any { digits.contains(it) })
            assertTrue("seed $seed missing symbol: $pw", pw.any { symbols.contains(it) })
        }
    }

    @Test
    fun generate_isDeterministicForAFixedSeed() {
        val a = PasswordGen.generate(length = 24, random = Random(99))
        val b = PasswordGen.generate(length = 24, random = Random(99))
        assertEquals(a, b)
    }

    @Test
    fun generate_lengthBelow4Throws() {
        for (bad in intArrayOf(3, 2, 1, 0, -1)) {
            try {
                PasswordGen.generate(length = bad, random = Random(1))
                throw AssertionError("expected IllegalArgumentException for length=$bad")
            } catch (e: IllegalArgumentException) {
                // expected
            }
        }
    }
}
