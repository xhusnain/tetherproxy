package com.tetherproxy.app.tunnel

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Drives (re)connection. Calls [connect] immediately, and whenever the owner
 * reports a drop via [scheduleReconnect] waits Backoff(attempt) then reconnects.
 * A ConnectivityManager.NetworkCallback cancels the pending wait and reconnects
 * immediately on any network change (WiFi <-> SIM).
 */
class Reconnector(
    private val context: Context,
    private val scope: CoroutineScope,
    private val connect: () -> Unit,
    private val backoff: Backoff = Backoff(baseMs = 1000, capMs = 30000, jitterFraction = 0.3)
) {
    private val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private var pendingJob: Job? = null
    private var registered = false

    /**
     * The network we are currently bound to. Updated only when the active network
     * IDENTITY changes (WiFi <-> SIM), never on benign capability changes, so a
     * healthy tunnel is not torn down repeatedly.
     */
    @Volatile
    private var activeNetwork: Network? = null

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            // Only force an immediate reconnect when the network identity actually
            // changed (or we were disconnected). A repeat onAvailable for the same
            // Network must not tear down a healthy tunnel.
            val previous = activeNetwork
            activeNetwork = network
            if (previous == null || previous != network) {
                forceReconnectNow()
            }
        }

        override fun onCapabilitiesChanged(
            network: Network,
            networkCapabilities: NetworkCapabilities
        ) {
            // Capability changes (e.g. VALIDATED toggling) fire repeatedly for a
            // healthy network; do NOT force a reconnect here. The backoff-driven
            // reconnect on a real drop (onClosed) still handles genuine failures.
        }

        override fun onLost(network: Network) {
            // The active network went away. Clearing it ensures the next
            // onAvailable (for any network) is treated as a real identity change
            // and forces a reconnect.
            if (activeNetwork == network) {
                activeNetwork = null
            }
        }
    }

    fun start() {
        if (!registered) {
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            cm.registerNetworkCallback(request, networkCallback)
            registered = true
        }
        backoff.reset()
        connect()
    }

    /** Owner calls this after a WS drop. Schedules a backoff-delayed reconnect. */
    fun scheduleReconnect() {
        pendingJob?.cancel()
        val delayMs = backoff.nextDelayMs()
        pendingJob = scope.launch {
            delay(delayMs)
            if (isActive) connect()
        }
    }

    /** Owner calls this after a successful AUTH_OK to clear the backoff. */
    fun onConnected() {
        backoff.reset()
    }

    private fun forceReconnectNow() {
        pendingJob?.cancel()
        backoff.reset()
        pendingJob = scope.launch {
            if (isActive) connect()
        }
    }

    fun stop() {
        pendingJob?.cancel()
        pendingJob = null
        activeNetwork = null
        if (registered) {
            runCatching { cm.unregisterNetworkCallback(networkCallback) }
            registered = false
        }
    }
}
