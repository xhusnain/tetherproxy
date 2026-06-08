package com.tetherproxy.app.ui

import android.app.Application
import android.util.Base64
import org.json.JSONObject
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.tetherproxy.app.data.Store
import com.tetherproxy.app.service.TunnelService
import com.tetherproxy.app.tunnel.TunnelStatus
import com.tetherproxy.app.util.PasswordGen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/** Editable copy of the setup form. */
data class SetupForm(
    val relayHost: String = "",
    val tunnelPort: String = "8443",
    val proxyPort: String = "8080",
    val proxyTlsPort: String = "8081",
    val pairingToken: String = "",
    val proxyUsername: String = "",
    val proxyPassword: String = "",
    val pinnedFingerprint: String = "",
    val autoStartOnBoot: Boolean = false
)

class AppViewModel(app: Application) : AndroidViewModel(app) {

    private val store = Store(app.applicationContext)

    private val _form = MutableStateFlow(loadForm())
    val form: StateFlow<SetupForm> = _form.asStateFlow()

    private val _egressIp = MutableStateFlow<String?>(null)
    val egressIp: StateFlow<String?> = _egressIp.asStateFlow()

    val status: StateFlow<TunnelStatus> = TunnelService.statusFlow

    private fun loadForm(): SetupForm = SetupForm(
        relayHost = store.relayHost,
        tunnelPort = store.tunnelPort.toString(),
        proxyPort = store.proxyPort.toString(),
        proxyTlsPort = store.proxyTlsPort.toString(),
        pairingToken = store.pairingToken,
        proxyUsername = store.proxyUsername,
        proxyPassword = store.proxyPassword,
        pinnedFingerprint = store.pinnedFingerprint,
        autoStartOnBoot = store.autoStartOnBoot
    )

    fun update(transform: (SetupForm) -> SetupForm) {
        _form.value = transform(_form.value)
    }

    /**
     * One-tap setup: fill the relay fields from a single pairing string instead of
     * typing each one. Accepts the relay's base64-encoded JSON (optionally prefixed
     * with "tetherproxy:") or raw JSON with keys host/tunnelPort/proxyPort/
     * proxyTlsPort/token/fingerprint/username. The proxy password stays
     * user-chosen (tap Generate). Returns true if a valid config was parsed.
     */
    fun importConfig(raw: String): Boolean {
        val trimmed = raw.trim().removePrefix("tetherproxy:").trim()
        val jsonText = try {
            if (trimmed.startsWith("{")) trimmed
            else String(Base64.decode(trimmed, Base64.DEFAULT), Charsets.UTF_8)
        } catch (e: Exception) {
            return false
        }
        val j = try {
            JSONObject(jsonText)
        } catch (e: Exception) {
            return false
        }
        val cur = _form.value
        _form.value = cur.copy(
            relayHost = j.optString("host", cur.relayHost),
            tunnelPort = j.optInt("tunnelPort", cur.tunnelPort.toIntOrNull() ?: 8443).toString(),
            proxyPort = j.optInt("proxyPort", cur.proxyPort.toIntOrNull() ?: 8080).toString(),
            proxyTlsPort = j.optInt("proxyTlsPort", cur.proxyTlsPort.toIntOrNull() ?: 8081).toString(),
            pairingToken = j.optString("token", cur.pairingToken),
            pinnedFingerprint = j.optString("fingerprint", cur.pinnedFingerprint),
            proxyUsername = j.optString("username", cur.proxyUsername)
        )
        return true
    }

    /**
     * Spec §4.2/§8: suggest a strong random password. Fills the same form field
     * the password OutlinedTextField is bound to (proxyPassword) with a fresh
     * 20-char URL-safe password.
     */
    fun generatePassword() {
        _form.value = _form.value.copy(proxyPassword = PasswordGen.generate())
    }

    /** Persist the form to encrypted storage and start the service. */
    fun saveAndConnect() {
        val f = _form.value
        store.relayHost = f.relayHost.trim()
        store.tunnelPort = f.tunnelPort.trim().toIntOrNull() ?: 8443
        store.proxyPort = f.proxyPort.trim().toIntOrNull() ?: 8080
        store.proxyTlsPort = f.proxyTlsPort.trim().toIntOrNull() ?: 8081
        store.pairingToken = f.pairingToken.trim()
        store.proxyUsername = f.proxyUsername.trim()
        store.proxyPassword = f.proxyPassword
        store.pinnedFingerprint = f.pinnedFingerprint.trim().lowercase().replace(":", "")
        store.autoStartOnBoot = f.autoStartOnBoot
        TunnelService.start(getApplication())
    }

    fun start() = TunnelService.start(getApplication())
    fun stop() = TunnelService.stop(getApplication())

    fun isConfigured(): Boolean = store.isConfigured()

    /** Fetch the phone's public IP directly (NOT via the proxy) to prove egress. */
    fun runEgressSelfTest() {
        viewModelScope.launch {
            val ip = withContext(Dispatchers.IO) {
                try {
                    val conn = URL("https://api.ipify.org").openConnection() as HttpURLConnection
                    conn.connectTimeout = 8000
                    conn.readTimeout = 8000
                    conn.requestMethod = "GET"
                    conn.inputStream.bufferedReader().use { it.readText().trim() }
                } catch (e: Exception) {
                    "error: ${e.message}"
                }
            }
            _egressIp.value = ip
        }
    }
}
