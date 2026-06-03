package com.tetherproxy.app.tunnel

/** Connection states surfaced to the UI. */
enum class ConnState { STOPPED, CONNECTING, AUTHENTICATING, CONNECTED, RECONNECTING, FAILED }

/** Immutable snapshot of tunnel health, published via a StateFlow. */
data class TunnelStatus(
    val state: ConnState = ConnState.STOPPED,
    val bytesIn: Long = 0,
    val bytesOut: Long = 0,
    val activeStreams: Int = 0,
    val lastError: String? = null,
    val relayHost: String? = null
)
