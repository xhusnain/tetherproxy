package com.tetherproxy.app.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.UUID

/**
 * Encrypted persistence for relay config, proxy credentials, pairing token and
 * the pinned relay TLS cert SHA-256 fingerprint. Backed by EncryptedSharedPreferences.
 */
class Store(context: Context) {

    private val prefs: SharedPreferences = run {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    var relayHost: String
        get() = prefs.getString(KEY_HOST, "") ?: ""
        set(value) = prefs.edit().putString(KEY_HOST, value).apply()

    /** WSS tunnel port. Default 8443 per the frozen spec. */
    var tunnelPort: Int
        get() = prefs.getInt(KEY_TUNNEL_PORT, 8443)
        set(value) = prefs.edit().putInt(KEY_TUNNEL_PORT, value).apply()

    /** Proxy port advertised in the UI for the smoke test (relay-side listener). */
    var proxyPort: Int
        get() = prefs.getInt(KEY_PROXY_PORT, 8080)
        set(value) = prefs.edit().putInt(KEY_PROXY_PORT, value).apply()

    /** Optional TLS proxy port. */
    var proxyTlsPort: Int
        get() = prefs.getInt(KEY_PROXY_TLS_PORT, 8081)
        set(value) = prefs.edit().putInt(KEY_PROXY_TLS_PORT, value).apply()

    var pairingToken: String
        get() = prefs.getString(KEY_PAIRING_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_PAIRING_TOKEN, value).apply()

    var proxyUsername: String
        get() = prefs.getString(KEY_PROXY_USERNAME, "") ?: ""
        set(value) = prefs.edit().putString(KEY_PROXY_USERNAME, value).apply()

    var proxyPassword: String
        get() = prefs.getString(KEY_PROXY_PASSWORD, "") ?: ""
        set(value) = prefs.edit().putString(KEY_PROXY_PASSWORD, value).apply()

    /**
     * Pinned relay cert SHA-256 fingerprint: SHA-256 of the relay's DER cert,
     * uppercase colon-separated hex (e.g. AA:BB:...); or "" for TOFU.
     * Compared normalized so any case/colon format the user pastes also matches.
     */
    var pinnedFingerprint: String
        get() = prefs.getString(KEY_PINNED_FP, "") ?: ""
        set(value) = prefs.edit().putString(KEY_PINNED_FP, value).apply()

    /** Stable device id, generated once and persisted. */
    val deviceId: String
        get() {
            val existing = prefs.getString(KEY_DEVICE_ID, null)
            if (existing != null) return existing
            val generated = UUID.randomUUID().toString()
            prefs.edit().putString(KEY_DEVICE_ID, generated).apply()
            return generated
        }

    /** Whether the user opted to auto-start the service on boot. */
    var autoStartOnBoot: Boolean
        get() = prefs.getBoolean(KEY_AUTOSTART, false)
        set(value) = prefs.edit().putBoolean(KEY_AUTOSTART, value).apply()

    fun isConfigured(): Boolean =
        relayHost.isNotBlank() &&
            pairingToken.isNotBlank() &&
            proxyUsername.isNotBlank() &&
            proxyPassword.isNotBlank()

    companion object {
        private const val FILE_NAME = "tetherproxy_secure_prefs"
        private const val KEY_HOST = "relay_host"
        private const val KEY_TUNNEL_PORT = "tunnel_port"
        private const val KEY_PROXY_PORT = "proxy_port"
        private const val KEY_PROXY_TLS_PORT = "proxy_tls_port"
        private const val KEY_PAIRING_TOKEN = "pairing_token"
        private const val KEY_PROXY_USERNAME = "proxy_username"
        private const val KEY_PROXY_PASSWORD = "proxy_password"
        private const val KEY_PINNED_FP = "pinned_fingerprint"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_AUTOSTART = "autostart_on_boot"
    }
}
