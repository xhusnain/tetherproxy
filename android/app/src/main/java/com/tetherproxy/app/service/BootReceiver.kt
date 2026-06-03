package com.tetherproxy.app.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.tetherproxy.app.data.Store

/** Auto-starts the tunnel after boot, only if the user opted in and is configured. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val store = Store(context.applicationContext)
        if (store.autoStartOnBoot && store.isConfigured()) {
            TunnelService.start(context.applicationContext)
        }
    }
}
