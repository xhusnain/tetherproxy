package com.tetherproxy.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import com.tetherproxy.app.R
import com.tetherproxy.app.data.Store
import com.tetherproxy.app.tunnel.ConnState
import com.tetherproxy.app.tunnel.Dialer
import com.tetherproxy.app.tunnel.DialerSink
import com.tetherproxy.app.tunnel.Frame
import com.tetherproxy.app.tunnel.FrameType
import com.tetherproxy.app.tunnel.Frames
import com.tetherproxy.app.tunnel.Mux
import com.tetherproxy.app.tunnel.Reconnector
import com.tetherproxy.app.tunnel.TunnelStatus
import com.tetherproxy.app.tunnel.WsClient
import com.tetherproxy.app.tunnel.WsEvents
import com.tetherproxy.app.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.atomic.AtomicLong

class TunnelService : Service(), WsEvents, DialerSink {

    private val scope = CoroutineScope(SupervisorJob())
    private lateinit var store: Store
    private lateinit var mux: Mux
    private lateinit var dialer: Dialer
    private var reconnector: Reconnector? = null
    private var wsClient: WsClient? = null
    private var wakeLock: PowerManager.WakeLock? = null

    private val bytesIn = AtomicLong(0)
    private val bytesOut = AtomicLong(0)

    override fun onCreate() {
        super.onCreate()
        store = Store(applicationContext)
        mux = Mux()
        dialer = Dialer(scope, mux, this)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopTunnel()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            else -> startTunnel()
        }
        return START_STICKY
    }

    private fun startTunnel() {
        startForeground(
            NOTIF_ID,
            buildNotification("Connecting…"),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            else 0
        )
        acquireWakeLock()
        publish(ConnState.CONNECTING)

        val rc = Reconnector(
            context = applicationContext,
            scope = scope,
            connect = { openWebSocket() }
        )
        reconnector = rc
        rc.start()
    }

    private fun openWebSocket() {
        if (!store.isConfigured()) {
            publish(ConnState.FAILED, error = "not configured")
            return
        }
        publish(ConnState.AUTHENTICATING)
        // Never leave two sockets open: close the previous client before opening a
        // new one. close() marks it superseded so its onClosed cannot re-trigger a
        // reconnect through onClosed() -> scheduleReconnect().
        wsClient?.close()
        wsClient = null
        val authPayload = Frames.utf8(
            Frames.authJson(
                pairingToken = store.pairingToken,
                deviceId = store.deviceId,
                proxyUsername = store.proxyUsername,
                proxyPassword = store.proxyPassword
            )
        )
        val client = WsClient(
            host = store.relayHost,
            port = store.tunnelPort,
            pinnedSha256Hex = store.pinnedFingerprint,
            authPayload = authPayload,
            events = this,
            onPinObserved = { fp ->
                if (store.pinnedFingerprint.isBlank()) store.pinnedFingerprint = fp
            }
        )
        wsClient = client
        client.connect()
    }

    private fun stopTunnel() {
        reconnector?.stop()
        reconnector = null
        wsClient?.close()
        wsClient = null
        dialer.closeAll()
        releaseWakeLock()
        publish(ConnState.STOPPED)
    }

    // ---- WsEvents ----

    override fun onOpen() {
        // AUTH already sent by WsClient; wait for AUTH_OK.
    }

    override fun onAuthOk() {
        reconnector?.onConnected()
        publish(ConnState.CONNECTED)
        updateNotification("Connected to ${store.relayHost}")
    }

    override fun onAuthFail(reason: String) {
        publish(ConnState.FAILED, error = "auth failed: $reason")
        updateNotification("Auth failed: $reason")
        // Do not auto-retry an auth failure aggressively; still schedule a backoff retry.
        reconnector?.scheduleReconnect()
    }

    override fun onFrame(frame: Frame) {
        when (frame.type) {
            FrameType.OPEN -> {
                val json = Frames.parseJson(String(frame.payload, Charsets.UTF_8))
                val host = json["host"] ?: return
                val port = json["port"]?.toIntOrNull() ?: return
                dialer.onOpen(frame.streamId, host, port)
            }
            FrameType.DATA -> dialer.onData(frame.streamId, frame.payload)
            FrameType.CLOSE -> dialer.onClose(frame.streamId)
            else -> { /* OPEN_OK/OPEN_FAIL/PONG are phone-originated or handled elsewhere */ }
        }
    }

    override fun onClosed(reason: String) {
        dialer.closeAll()
        publish(ConnState.RECONNECTING, error = reason)
        updateNotification("Reconnecting…")
        reconnector?.scheduleReconnect()
    }

    // ---- DialerSink ----

    override fun send(type: FrameType, streamId: Int, payload: ByteArray): Boolean =
        wsClient?.sendFrame(type, streamId, payload) ?: false

    override fun addBytesIn(n: Long) {
        bytesIn.addAndGet(n)
        publishCounters()
    }

    override fun addBytesOut(n: Long) {
        bytesOut.addAndGet(n)
        publishCounters()
    }

    override fun onActiveStreamsChanged(count: Int) {
        publishCounters()
    }

    // ---- status publishing ----

    private fun publish(state: ConnState, error: String? = null) {
        val prev = status.value
        status.value = prev.copy(
            state = state,
            lastError = error ?: if (state == ConnState.CONNECTED) null else prev.lastError,
            relayHost = store.relayHost,
            bytesIn = bytesIn.get(),
            bytesOut = bytesOut.get(),
            activeStreams = mux.size()
        )
    }

    private fun publishCounters() {
        val prev = status.value
        status.value = prev.copy(
            bytesIn = bytesIn.get(),
            bytesOut = bytesOut.get(),
            activeStreams = mux.size()
        )
    }

    // ---- notification + wakelock ----

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = getString(R.string.channel_description) }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pi = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .setContentIntent(pi)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIF_ID, buildNotification(text))
    }

    private fun acquireWakeLock() {
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tetherproxy:tunnel")
        }
        if (wakeLock?.isHeld == false) wakeLock?.acquire()
    }

    private fun releaseWakeLock() {
        if (wakeLock?.isHeld == true) wakeLock?.release()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopTunnel()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val CHANNEL_ID = "tunnel"
        const val NOTIF_ID = 1001
        const val ACTION_STOP = "com.tetherproxy.app.action.STOP"

        private val status = MutableStateFlow(TunnelStatus())
        val statusFlow: StateFlow<TunnelStatus> = status.asStateFlow()

        fun start(context: Context) {
            val intent = Intent(context, TunnelService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, TunnelService::class.java).apply { action = ACTION_STOP }
            context.startService(intent)
        }
    }
}
