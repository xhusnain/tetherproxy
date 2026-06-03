package com.tetherproxy.app.tunnel

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/** Callbacks the owner (TunnelService) supplies to react to tunnel events. */
interface WsEvents {
    /** WebSocket connected; AUTH has already been sent by WsClient. */
    fun onOpen()
    /** A non-control or control frame arrived (except PING which WsClient answers itself). */
    fun onFrame(frame: Frame)
    /** AUTH_OK received. */
    fun onAuthOk()
    /** AUTH_FAIL received with the relay's reason. */
    fun onAuthFail(reason: String)
    /** Socket closed or failed; reconnect should be scheduled by the owner. */
    fun onClosed(reason: String)
}

/**
 * Holds one OkHttp WebSocket to wss://host:port. Pins the relay cert by SHA-256
 * fingerprint (TOFU when [pinnedSha256Hex] is blank, capturing the first cert's
 * fingerprint into [onPinObserved]). On open it sends the AUTH frame; it answers
 * PING with PONG itself and forwards all other frames via [WsEvents.onFrame].
 *
 * The pinned fingerprint format MUST match the relay's printed value, which is the
 * SHA-256 of the full DER-encoded leaf cert as colon-separated UPPERCASE hex pairs
 * (identical to `openssl x509 -fingerprint -sha256`). See [sha256Hex].
 */
class WsClient(
    private val host: String,
    private val port: Int,
    private val pinnedSha256Hex: String,
    private val authPayload: ByteArray,
    private val events: WsEvents,
    private val onPinObserved: (sha256Hex: String) -> Unit,
    private val pingIntervalSec: Long = 20
) {
    @Volatile
    private var webSocket: WebSocket? = null

    @Volatile
    private var observedFingerprint: String? = null

    /**
     * Set when an old socket is being intentionally replaced (reconnect) or the
     * client is shut down. While true, callbacks from a stale socket are ignored
     * so the old socket's onClosed/onFailure cannot re-trigger a reconnect.
     */
    @Volatile
    private var superseded: Boolean = false

    private fun buildTrustManager(): X509TrustManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            throw java.security.cert.CertificateException("client auth not supported")
        }

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull()
                ?: throw java.security.cert.CertificateException("empty certificate chain")
            val fp = sha256Hex(leaf.encoded)
            observedFingerprint = fp
            if (pinnedSha256Hex.isBlank()) {
                // Trust-on-first-use: accept and report the fingerprint to pin.
                onPinObserved(fp)
                return
            }
            if (normFp(fp) != normFp(pinnedSha256Hex)) {
                throw java.security.cert.CertificateException(
                    "certificate fingerprint mismatch: got $fp expected $pinnedSha256Hex"
                )
            }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    private fun buildClient(): OkHttpClient {
        val trustManager = buildTrustManager()
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, arrayOf<TrustManager>(trustManager), java.security.SecureRandom())
        val factory: SSLSocketFactory = sslContext.socketFactory
        return OkHttpClient.Builder()
            .sslSocketFactory(factory, trustManager)
            // We validate the cert by fingerprint, not by hostname, so accept the host name.
            .hostnameVerifier { _, _ -> true }
            .pingInterval(pingIntervalSec, TimeUnit.SECONDS)
            .build()
    }

    fun connect() {
        // Idempotent: never leave two sockets open. Close any existing socket first,
        // detaching it so its onClosed/onFailure cannot re-trigger a reconnect. We
        // briefly mark this client superseded while tearing down the old socket, then
        // clear the flag before attaching the new socket below.
        val previous = webSocket
        if (previous != null) {
            superseded = true
            webSocket = null
            runCatching { previous.cancel() }
        }
        superseded = false

        val client = buildClient()
        val request = Request.Builder()
            .url("wss://$host:$port/")
            .build()
        // Holds the socket this listener belongs to, so a stale socket's callbacks
        // (delivered after we've replaced it) can be ignored. Assigned right after
        // newWebSocket returns, before any callback can meaningfully race.
        var thisSocket: WebSocket? = null
        // True only when this listener's events should be delivered to the owner.
        fun isCurrent(ws: WebSocket): Boolean = !superseded && webSocket === ws && thisSocket === ws
        val created = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // Send AUTH first thing.
                webSocket.send(Frames.encode(FrameType.AUTH, 0, authPayload).toByteString())
                if (isCurrent(webSocket)) events.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (!isCurrent(webSocket)) return
                val frame = try {
                    Frames.decode(bytes.toByteArray())
                } catch (e: IllegalArgumentException) {
                    return // ignore malformed frames
                }
                when (frame.type) {
                    FrameType.PING -> {
                        webSocket.send(
                            Frames.encode(FrameType.PONG, frame.streamId, ByteArray(0)).toByteString()
                        )
                    }
                    FrameType.AUTH_OK -> events.onAuthOk()
                    FrameType.AUTH_FAIL -> {
                        val reason = parseReason(frame.payload)
                        events.onAuthFail(reason)
                    }
                    else -> events.onFrame(frame)
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                // Protocol is binary-only; ignore text frames.
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                // Ignore the close of a superseded/replaced socket so it cannot
                // re-enter the reconnect loop.
                if (isCurrent(webSocket)) events.onClosed("closed: $code $reason")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (isCurrent(webSocket)) events.onClosed("failure: ${t.message}")
            }
        })
        thisSocket = created
        webSocket = created
    }

    /** Send a pre-encoded frame. Returns false if the socket is gone. */
    fun sendFrame(type: FrameType, streamId: Int, payload: ByteArray): Boolean {
        val ws = webSocket ?: return false
        return ws.send(Frames.encode(type, streamId, payload).toByteString())
    }

    fun lastObservedFingerprint(): String? = observedFingerprint

    fun close() {
        // Mark superseded first so the resulting onClosed/onFailure callbacks are
        // ignored and cannot trigger a new scheduled reconnect.
        superseded = true
        webSocket?.close(1000, "client shutdown")
        webSocket = null
    }

    /** Visible for tests: whether this client has been superseded/closed. */
    internal fun isSuperseded(): Boolean = superseded

    private fun parseReason(payload: ByteArray): String {
        if (payload.isEmpty()) return "unknown"
        return try {
            Frames.parseJson(String(payload, Charsets.UTF_8))["reason"] ?: "unknown"
        } catch (e: Exception) {
            "unknown"
        }
    }

    companion object {
        /**
         * Normalizes a fingerprint string for comparison by stripping colons and
         * spaces and lowercasing, so that formats like "AA:BB:CC", "aabbcc", and
         * "aa bb cc" all compare equal.
         */
        internal fun normFp(s: String): String = s.replace(":", "").replace(" ", "").lowercase()

        /**
         * SHA-256 of the DER-encoded certificate, formatted as colon-separated
         * UPPERCASE hex pairs (e.g. `7C:F1:20:...:F7`) — identical to the relay's
         * printed fingerprint and to `openssl x509 -fingerprint -sha256`. This is
         * the value pinned/compared against [Store.pinnedFingerprint].
         */
        fun sha256Hex(der: ByteArray): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(der)
            val sb = StringBuilder(digest.size * 3)
            for (b in digest) {
                if (sb.isNotEmpty()) sb.append(':')
                val v = b.toInt() and 0xFF
                sb.append("0123456789ABCDEF"[v ushr 4])
                sb.append("0123456789ABCDEF"[v and 0x0F])
            }
            return sb.toString()
        }
    }
}
