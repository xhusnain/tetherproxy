package com.tetherproxy.app.util

import java.security.SecureRandom
import java.util.Random

/**
 * Pure, JVM-testable strong-password generator. Produces passwords whose every
 * character is URL-userinfo-safe without percent-encoding, drawing from four
 * character classes and guaranteeing at least one character from each:
 *   - lowercase a-z
 *   - uppercase A-Z
 *   - digits 0-9
 *   - unreserved symbols -._~  (RFC 3986 "unreserved", safe in a proxy URL)
 *
 * The [random] source is injectable so tests can seed a [java.util.Random] for
 * deterministic assertions; production callers use a [SecureRandom].
 */
object PasswordGen {
    private const val LOWER = "abcdefghijklmnopqrstuvwxyz"
    private const val UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    private const val DIGITS = "0123456789"
    private const val SYMBOLS = "-._~"
    private val CLASSES = listOf(LOWER, UPPER, DIGITS, SYMBOLS)
    private val ALL = (LOWER + UPPER + DIGITS + SYMBOLS)

    /**
     * Generate a password of [length] characters (default 20) using [random].
     * Guarantees at least one character from each of the four classes, then
     * fills the remainder from the union and shuffles with [random].
     * @throws IllegalArgumentException if [length] < 4 (cannot satisfy all classes).
     */
    fun generate(length: Int = 20, random: Random = SecureRandom()): String {
        require(length >= 4) { "length must be >= 4 to include every class, got $length" }
        val chars = ArrayList<Char>(length)
        // One guaranteed character from each class.
        for (cls in CLASSES) {
            chars.add(cls[random.nextInt(cls.length)])
        }
        // Fill the rest from the union of all classes.
        repeat(length - CLASSES.size) {
            chars.add(ALL[random.nextInt(ALL.length)])
        }
        // Fisher-Yates shuffle using the injected random so class members are
        // not pinned to the first four positions.
        for (i in chars.size - 1 downTo 1) {
            val j = random.nextInt(i + 1)
            val tmp = chars[i]
            chars[i] = chars[j]
            chars[j] = tmp
        }
        return String(chars.toCharArray())
    }
}
