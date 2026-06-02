# TetherProxy Android App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a native Kotlin (Jetpack Compose) Android app that runs an always-on foreground service holding one WSS tunnel to the relay, and for each forwarded `OPEN` frame opens a raw TCP socket to the target over the phone's current network (SIM or WiFi) and pipes bytes both ways.

**Architecture:** A foreground `TunnelService` (START_STICKY, partial wakelock, persistent notification) owns the lifecycle of `WsClient` (OkHttp WebSocket with TLS fingerprint pinning), `Dialer` (per-stream raw `java.net.Socket` piping), and `Reconnector` (exponential backoff + `ConnectivityManager.NetworkCallback`). Pure logic — binary frame codec (`Frames`), stream multiplexer (`Mux`), backoff math (`Reconnector`), and socket piping (`Dialer`) — is decomposed so it runs on the plain JVM and is driven test-first with JUnit. Compose UI (`SetupScreen`, `StatusScreen`) talks to the service through a `StateFlow` of status and `EncryptedSharedPreferences`-backed `Store`.

**Tech Stack:** Kotlin, Jetpack Compose (Material 3), OkHttp (WebSocket + CertificatePinner), kotlinx-coroutines, androidx.security:security-crypto (EncryptedSharedPreferences), AndroidX Lifecycle/Activity-Compose, JUnit4 for JVM unit tests.

---

## File Structure

Every file this plan creates or modifies (single responsibility each):

| Path | Responsibility |
|------|----------------|
| `android/settings.gradle.kts` | Gradle settings: project name, plugin & dependency repositories. |
| `android/build.gradle.kts` | Root build file: declare Android/Kotlin/Compose plugins (apply false). |
| `android/gradle.properties` | Gradle/Kotlin/AndroidX flags (jvmargs, AndroidX, Compose). |
| `android/gradle/libs.versions.toml` | Version catalog: all dependency coordinates + versions. |
| `android/app/build.gradle.kts` | App module build: SDK levels, Compose, dependencies, test config. |
| `android/app/proguard-rules.pro` | (empty placeholder so release config is valid). |
| `android/app/src/main/AndroidManifest.xml` | Permissions, foreground service (dataSync), boot receiver, activity. |
| `android/app/src/main/res/values/strings.xml` | App name + notification channel strings. |
| `android/app/src/main/res/xml/network_security_config.xml` | Allow cleartext off; user CA not needed (we pin manually). |
| `android/app/src/main/java/com/tetherproxy/app/tunnel/Frames.kt` | Pure binary frame encode/decode + `FrameType` enum. |
| `android/app/src/main/java/com/tetherproxy/app/tunnel/Mux.kt` | `streamId -> java.net.Socket` thread-safe map. |
| `android/app/src/main/java/com/tetherproxy/app/tunnel/Backoff.kt` | Pure exponential-backoff-with-jitter math. |
| `android/app/src/main/java/com/tetherproxy/app/tunnel/Piping.kt` | Pure stream-to-stream pump logic (testable on in-memory streams). |
| `android/app/src/main/java/com/tetherproxy/app/util/PasswordGen.kt` | Pure URL-safe strong-random-password generator (Spec §4.2/§8). |
| `android/app/src/main/java/com/tetherproxy/app/data/Store.kt` | `EncryptedSharedPreferences` wrapper for config + creds + pinned fingerprint. |
| `android/app/src/main/java/com/tetherproxy/app/tunnel/WsClient.kt` | OkHttp WebSocket; fingerprint pinning; AUTH; frame dispatch; `send()`. |
| `android/app/src/main/java/com/tetherproxy/app/tunnel/Dialer.kt` | On `OPEN` opens a socket, replies OPEN_OK/FAIL, pumps both ways, CLOSE. |
| `android/app/src/main/java/com/tetherproxy/app/tunnel/Reconnector.kt` | Backoff loop + `NetworkCallback` forcing immediate reconnect. |
| `android/app/src/main/java/com/tetherproxy/app/tunnel/TunnelStatus.kt` | Immutable status data class exposed via `StateFlow`. |
| `android/app/src/main/java/com/tetherproxy/app/service/TunnelService.kt` | Foreground service owning WsClient+Dialer+Reconnector; status StateFlow. |
| `android/app/src/main/java/com/tetherproxy/app/service/BootReceiver.kt` | Optional auto-start of the service on boot. |
| `android/app/src/main/java/com/tetherproxy/app/ui/MainActivity.kt` | Compose host + nav between Setup/Status; permission/battery prompts. |
| `android/app/src/main/java/com/tetherproxy/app/ui/SetupScreen.kt` | Compose form: host/ports/token/user/pass → Save & Connect. |
| `android/app/src/main/java/com/tetherproxy/app/ui/StatusScreen.kt` | Compose status: state, egress IP self-test, bytes, streams, Start/Stop. |
| `android/app/src/main/java/com/tetherproxy/app/ui/AppViewModel.kt` | ViewModel: reads Store, starts/stops service, observes status, IP self-test. |
| `android/app/src/main/java/com/tetherproxy/app/ui/Theme.kt` | Minimal Material3 theme. |
| `android/app/src/test/java/com/tetherproxy/app/tunnel/FramesTest.kt` | JVM round-trip tests for every frame type. |
| `android/app/src/test/java/com/tetherproxy/app/tunnel/MuxTest.kt` | JVM tests for add/get/remove/list. |
| `android/app/src/test/java/com/tetherproxy/app/tunnel/BackoffTest.kt` | JVM tests for the backoff sequence + jitter bounds. |
| `android/app/src/test/java/com/tetherproxy/app/tunnel/PipingTest.kt` | JVM tests for the piping pump over in-memory streams. |
| `android/app/src/test/java/com/tetherproxy/app/util/PasswordGenTest.kt` | JVM tests for length, charset, per-class guarantee, and length<4 throwing. |
| `android/README.md` | Build, install, first-run pairing, fingerprint pinning, smoke test. |

Java/Kotlin package root: `com.tetherproxy.app`. Application ID: `com.tetherproxy.app`.

---

### Task 1: Gradle project scaffold

**Files:**
- Create: `android/settings.gradle.kts`
- Create: `android/build.gradle.kts`
- Create: `android/gradle.properties`
- Create: `android/gradle/libs.versions.toml`
- Create: `android/app/build.gradle.kts`
- Create: `android/app/proguard-rules.pro`

- [ ] **Step 1: Create the version catalog with exact coordinates.**
  Write `android/gradle/libs.versions.toml`:
```toml
[versions]
agp = "8.5.2"
kotlin = "1.9.24"
coreKtx = "1.13.1"
lifecycle = "2.8.4"
activityCompose = "1.9.1"
composeBom = "2024.06.00"
okhttp = "4.12.0"
securityCrypto = "1.1.0-alpha06"
coroutines = "1.8.1"
junit = "4.13.2"

[libraries]
androidx-core-ktx = { module = "androidx.core:core-ktx", version.ref = "coreKtx" }
androidx-lifecycle-runtime-ktx = { module = "androidx.lifecycle:lifecycle-runtime-ktx", version.ref = "lifecycle" }
androidx-lifecycle-viewmodel-compose = { module = "androidx.lifecycle:lifecycle-viewmodel-compose", version.ref = "lifecycle" }
androidx-activity-compose = { module = "androidx.activity:activity-compose", version.ref = "activityCompose" }
androidx-compose-bom = { module = "androidx.compose:compose-bom", version.ref = "composeBom" }
androidx-compose-ui = { module = "androidx.compose.ui:ui" }
androidx-compose-ui-graphics = { module = "androidx.compose.ui:ui-graphics" }
androidx-compose-ui-tooling-preview = { module = "androidx.compose.ui:ui-tooling-preview" }
androidx-compose-ui-tooling = { module = "androidx.compose.ui:ui-tooling" }
androidx-compose-material3 = { module = "androidx.compose.material3:material3" }
androidx-security-crypto = { module = "androidx.security:security-crypto", version.ref = "securityCrypto" }
okhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }
kotlinx-coroutines-android = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-android", version.ref = "coroutines" }
kotlinx-coroutines-core = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-core", version.ref = "coroutines" }
kotlinx-coroutines-test = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-test", version.ref = "coroutines" }
junit = { module = "junit:junit", version.ref = "junit" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
```

- [ ] **Step 2: Create `android/settings.gradle.kts`.**
```kotlin
pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "TetherProxy"
include(":app")
```

- [ ] **Step 3: Create root `android/build.gradle.kts`.**
```kotlin
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
}
```

- [ ] **Step 4: Create `android/gradle.properties`.**
```properties
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
org.gradle.caching=true
android.useAndroidX=true
android.nonTransitiveRClass=true
kotlin.code.style=official
```

- [ ] **Step 5: Create `android/app/proguard-rules.pro` (empty but present).**
```pro
# No release minification configured for v1. Keep file present so the
# release buildType's proguardFiles reference resolves.
```

- [ ] **Step 6: Create `android/app/build.gradle.kts`.**
```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.tetherproxy.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.tetherproxy.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.security.crypto)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.core)

    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp)
}
```

- [ ] **Step 7: Generate the Gradle wrapper and confirm the project configures.**
  Run (Android SDK + a JDK 17 must be installed; `ANDROID_HOME`/`local.properties` set):
```bash
cd /home/hubextech/tetherproxy/android && gradle wrapper --gradle-version 8.7
./gradlew help
```
  Expected: `BUILD SUCCESSFUL`. If `gradle` is not on PATH, install Gradle 8.7+ or copy a wrapper from another project. Create `android/local.properties` containing `sdk.dir=/path/to/Android/Sdk` if the build complains about the SDK location.

- [ ] **Step 8: Commit the scaffold.**
```bash
cd /home/hubextech/tetherproxy && git init -q 2>/dev/null; git add android/settings.gradle.kts android/build.gradle.kts android/gradle.properties android/gradle/libs.versions.toml android/app/build.gradle.kts android/app/proguard-rules.pro android/gradlew android/gradlew.bat android/gradle/wrapper
git commit -m "android: gradle scaffold (compose, okhttp, security-crypto, coroutines)"
```

---

### Task 2: AndroidManifest, strings, network security config

**Files:**
- Create: `android/app/src/main/AndroidManifest.xml`
- Create: `android/app/src/main/res/values/strings.xml`
- Create: `android/app/src/main/res/xml/network_security_config.xml`

- [ ] **Step 1: Create `android/app/src/main/res/values/strings.xml`.**
```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">TetherProxy</string>
    <string name="channel_name">Tunnel</string>
    <string name="channel_description">Keeps the proxy tunnel connected.</string>
    <string name="notification_title">TetherProxy running</string>
</resources>
```

- [ ] **Step 2: Create `android/app/src/main/res/xml/network_security_config.xml`.**
  We pin the relay cert ourselves in `WsClient` (OkHttp `CertificatePinner`/TOFU), so platform config only disables cleartext globally.
```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
</network-security-config>
```

- [ ] **Step 3: Create `android/app/src/main/AndroidManifest.xml`.**
```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />

    <application
        android:allowBackup="false"
        android:label="@string/app_name"
        android:networkSecurityConfig="@xml/network_security_config"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.Material.Light.NoActionBar">

        <activity
            android:name=".ui.MainActivity"
            android:exported="true"
            android:label="@string/app_name">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <service
            android:name=".service.TunnelService"
            android:exported="false"
            android:foregroundServiceType="dataSync" />

        <receiver
            android:name=".service.BootReceiver"
            android:enabled="true"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
            </intent-filter>
        </receiver>
    </application>
</manifest>
```

- [ ] **Step 4: Confirm the manifest merges.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:processDebugManifest
```
  Expected: `BUILD SUCCESSFUL`. (References to `.ui.MainActivity`, `.service.TunnelService`, `.service.BootReceiver` will only fully resolve once those classes exist in later tasks; manifest processing itself succeeds because they are string class names.)

- [ ] **Step 5: Commit.**
```bash
cd /home/hubextech/tetherproxy && git add android/app/src/main/AndroidManifest.xml android/app/src/main/res/values/strings.xml android/app/src/main/res/xml/network_security_config.xml
git commit -m "android: manifest, permissions, foreground service (dataSync), boot receiver"
```

---

### Task 3: Frames.kt — frozen binary frame codec (TDD)

**Files:**
- Create: `android/app/src/test/java/com/tetherproxy/app/tunnel/FramesTest.kt`
- Create: `android/app/src/main/java/com/tetherproxy/app/tunnel/Frames.kt`

Wire format (FROZEN): `[1 byte type][4 bytes streamId big-endian][payload]`. streamId 0 = control.

- [ ] **Step 1: Write the failing test.**
  Create `android/app/src/test/java/com/tetherproxy/app/tunnel/FramesTest.kt`:
```kotlin
package com.tetherproxy.app.tunnel

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FramesTest {

    @Test
    fun typeCodes_matchFrozenProtocol() {
        assertEquals(0x01, FrameType.AUTH.code)
        assertEquals(0x02, FrameType.AUTH_OK.code)
        assertEquals(0x03, FrameType.AUTH_FAIL.code)
        assertEquals(0x10, FrameType.OPEN.code)
        assertEquals(0x11, FrameType.OPEN_OK.code)
        assertEquals(0x12, FrameType.OPEN_FAIL.code)
        assertEquals(0x20, FrameType.DATA.code)
        assertEquals(0x21, FrameType.CLOSE.code)
        assertEquals(0x30, FrameType.PING.code)
        assertEquals(0x31, FrameType.PONG.code)
    }

    @Test
    fun fromCode_resolvesEveryType() {
        for (t in FrameType.values()) {
            assertEquals(t, FrameType.fromCode(t.code))
        }
        assertNull(FrameType.fromCode(0x99))
    }

    @Test
    fun encode_layoutIsTypeThenBigEndianStreamIdThenPayload() {
        val bytes = Frames.encode(FrameType.DATA, 0x01020304, byteArrayOf(0xAA.toByte(), 0xBB.toByte()))
        assertArrayEquals(
            byteArrayOf(0x20, 0x01, 0x02, 0x03, 0x04, 0xAA.toByte(), 0xBB.toByte()),
            bytes
        )
    }

    @Test
    fun encode_streamIdZeroForControlFrames() {
        val bytes = Frames.encode(FrameType.PING, 0, ByteArray(0))
        assertArrayEquals(byteArrayOf(0x30, 0x00, 0x00, 0x00, 0x00), bytes)
    }

    @Test
    fun encode_handlesHighBitStreamId() {
        val bytes = Frames.encode(FrameType.CLOSE, 0xFFFFFFFF.toInt(), ByteArray(0))
        assertArrayEquals(
            byteArrayOf(0x21, 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte()),
            bytes
        )
    }

    @Test
    fun decode_roundTripsEveryFrameType() {
        val payloads = mapOf(
            FrameType.AUTH to """{"pairingToken":"t"}""".toByteArray(),
            FrameType.AUTH_OK to ByteArray(0),
            FrameType.AUTH_FAIL to """{"reason":"bad"}""".toByteArray(),
            FrameType.OPEN to """{"host":"api.example.com","port":443}""".toByteArray(),
            FrameType.OPEN_OK to ByteArray(0),
            FrameType.OPEN_FAIL to """{"reason":"refused"}""".toByteArray(),
            FrameType.DATA to byteArrayOf(1, 2, 3, 4, 5),
            FrameType.CLOSE to ByteArray(0),
            FrameType.PING to ByteArray(0),
            FrameType.PONG to ByteArray(0)
        )
        var streamId = 7
        for ((type, payload) in payloads) {
            val encoded = Frames.encode(type, streamId, payload)
            val decoded = Frames.decode(encoded)
            assertEquals(type, decoded.type)
            assertEquals(streamId, decoded.streamId)
            assertArrayEquals(payload, decoded.payload)
            streamId++
        }
    }

    @Test
    fun decode_unknownTypeThrows() {
        try {
            Frames.decode(byteArrayOf(0x99.toByte(), 0, 0, 0, 1))
            throw AssertionError("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }

    @Test
    fun decode_tooShortThrows() {
        try {
            Frames.decode(byteArrayOf(0x20, 0, 0))
            throw AssertionError("expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }

    @Test
    fun jsonHelpers_buildAndParseControlPayloads() {
        val auth = Frames.authJson(
            pairingToken = "tok",
            deviceId = "dev-1",
            proxyUsername = "user",
            proxyPassword = "pass"
        )
        val parsed = Frames.parseJson(auth)
        assertEquals("tok", parsed["pairingToken"])
        assertEquals("dev-1", parsed["deviceId"])
        assertEquals("user", parsed["proxyUsername"])
        assertEquals("pass", parsed["proxyPassword"])

        val open = """{"host":"h.example.com","port":8443}"""
        val openParsed = Frames.parseJson(open)
        assertEquals("h.example.com", openParsed["host"])
        assertEquals("8443", openParsed["port"])
    }
}
```

- [ ] **Step 2: Run the test and watch it FAIL (no `Frames`/`FrameType` yet).**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:testDebugUnitTest --tests "com.tetherproxy.app.tunnel.FramesTest"
```
  Expected FAIL: compilation error `Unresolved reference: FrameType` / `Unresolved reference: Frames`.

- [ ] **Step 3: Implement `Frames.kt` (minimal to pass).**
  Create `android/app/src/main/java/com/tetherproxy/app/tunnel/Frames.kt`:
```kotlin
package com.tetherproxy.app.tunnel

import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import org.json.JSONObject

/** Frozen tunnel frame types: [1B type][4B streamId BE][payload]. */
enum class FrameType(val code: Int) {
    AUTH(0x01),
    AUTH_OK(0x02),
    AUTH_FAIL(0x03),
    OPEN(0x10),
    OPEN_OK(0x11),
    OPEN_FAIL(0x12),
    DATA(0x20),
    CLOSE(0x21),
    PING(0x30),
    PONG(0x31);

    companion object {
        private val byCode = values().associateBy { it.code }
        fun fromCode(code: Int): FrameType? = byCode[code]
    }
}

/** A decoded frame. */
data class Frame(val type: FrameType, val streamId: Int, val payload: ByteArray) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Frame) return false
        return type == other.type &&
            streamId == other.streamId &&
            payload.contentEquals(other.payload)
    }

    override fun hashCode(): Int {
        var result = type.hashCode()
        result = 31 * result + streamId
        result = 31 * result + payload.contentHashCode()
        return result
    }
}

object Frames {
    const val HEADER_SIZE = 5

    /** Encode to the frozen wire layout. streamId is written big-endian. */
    fun encode(type: FrameType, streamId: Int, payload: ByteArray): ByteArray {
        val buf = ByteBuffer.allocate(HEADER_SIZE + payload.size)
        buf.put(type.code.toByte())
        buf.putInt(streamId) // ByteBuffer is big-endian by default
        buf.put(payload)
        return buf.array()
    }

    /** Decode the frozen wire layout. Throws IllegalArgumentException on malformed input. */
    fun decode(bytes: ByteArray): Frame {
        require(bytes.size >= HEADER_SIZE) {
            "frame too short: ${bytes.size} bytes (need >= $HEADER_SIZE)"
        }
        val buf = ByteBuffer.wrap(bytes)
        val typeCode = buf.get().toInt() and 0xFF
        val type = FrameType.fromCode(typeCode)
            ?: throw IllegalArgumentException("unknown frame type: 0x${typeCode.toString(16)}")
        val streamId = buf.getInt()
        val payload = ByteArray(bytes.size - HEADER_SIZE)
        buf.get(payload)
        return Frame(type, streamId, payload)
    }

    /** Build the AUTH JSON payload using the frozen field names. */
    fun authJson(
        pairingToken: String,
        deviceId: String,
        proxyUsername: String,
        proxyPassword: String
    ): String = JSONObject()
        .put("pairingToken", pairingToken)
        .put("deviceId", deviceId)
        .put("proxyUsername", proxyUsername)
        .put("proxyPassword", proxyPassword)
        .toString()

    /** Parse a flat JSON object into a string->string map (values stringified). */
    fun parseJson(json: String): Map<String, String> {
        val obj = JSONObject(json)
        val out = HashMap<String, String>()
        val it = obj.keys()
        while (it.hasNext()) {
            val key = it.next()
            out[key] = obj.get(key).toString()
        }
        return out
    }

    fun utf8(s: String): ByteArray = s.toByteArray(StandardCharsets.UTF_8)
}
```
  Note: `org.json` is part of the Android SDK; in JVM unit tests it is provided because Android's `org.json` is stubbed and `testOptions.unitTests.isReturnDefaultValues = true` is set, but to make the codec testable on the plain JVM we add the real `org.json` test dependency in the next step.

- [ ] **Step 4: Add the `org.json` test dependency so JSON helpers run on the JVM.**
  In `android/gradle/libs.versions.toml` under `[versions]` add `json = "20240303"`, under `[libraries]` add:
```toml
org-json = { module = "org.json:json", version.ref = "json" }
```
  In `android/app/build.gradle.kts` under `dependencies` add:
```kotlin
    testImplementation(libs.org.json)
```

- [ ] **Step 5: Run the test and watch it PASS.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:testDebugUnitTest --tests "com.tetherproxy.app.tunnel.FramesTest"
```
  Expected: `BUILD SUCCESSFUL`, all 9 test methods pass.

- [ ] **Step 6: Commit.**
```bash
cd /home/hubextech/tetherproxy && git add android/app/src/main/java/com/tetherproxy/app/tunnel/Frames.kt android/app/src/test/java/com/tetherproxy/app/tunnel/FramesTest.kt android/gradle/libs.versions.toml android/app/build.gradle.kts
git commit -m "android: Frames codec (frozen [type][streamId BE][payload]) + JVM round-trip tests"
```

---

### Task 4: Mux.kt — streamId → Socket map (TDD)

**Files:**
- Create: `android/app/src/test/java/com/tetherproxy/app/tunnel/MuxTest.kt`
- Create: `android/app/src/main/java/com/tetherproxy/app/tunnel/Mux.kt`

- [ ] **Step 1: Write the failing test.**
  Create `android/app/src/test/java/com/tetherproxy/app/tunnel/MuxTest.kt`:
```kotlin
package com.tetherproxy.app.tunnel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.Socket

class MuxTest {

    @Test
    fun put_thenGet_returnsSameSocket() {
        val mux = Mux()
        val s = Socket()
        mux.put(42, s)
        assertSame(s, mux.get(42))
    }

    @Test
    fun get_missingStream_returnsNull() {
        val mux = Mux()
        assertNull(mux.get(99))
    }

    @Test
    fun remove_returnsSocketAndDropsIt() {
        val mux = Mux()
        val s = Socket()
        mux.put(1, s)
        assertSame(s, mux.remove(1))
        assertNull(mux.get(1))
    }

    @Test
    fun remove_missingStream_returnsNull() {
        val mux = Mux()
        assertNull(mux.remove(7))
    }

    @Test
    fun contains_reflectsPresence() {
        val mux = Mux()
        assertFalse(mux.contains(5))
        mux.put(5, Socket())
        assertTrue(mux.contains(5))
        mux.remove(5)
        assertFalse(mux.contains(5))
    }

    @Test
    fun size_andStreamIds_trackEntries() {
        val mux = Mux()
        assertEquals(0, mux.size())
        mux.put(1, Socket())
        mux.put(2, Socket())
        assertEquals(2, mux.size())
        assertEquals(setOf(1, 2), mux.streamIds())
    }

    @Test
    fun removeAll_returnsSnapshotAndClears() {
        val mux = Mux()
        val a = Socket()
        val b = Socket()
        mux.put(1, a)
        mux.put(2, b)
        val snapshot = mux.removeAll()
        assertEquals(2, snapshot.size)
        assertTrue(snapshot.contains(a))
        assertTrue(snapshot.contains(b))
        assertEquals(0, mux.size())
    }
}
```

- [ ] **Step 2: Run and watch it FAIL.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:testDebugUnitTest --tests "com.tetherproxy.app.tunnel.MuxTest"
```
  Expected FAIL: `Unresolved reference: Mux`.

- [ ] **Step 3: Implement `Mux.kt`.**
  Create `android/app/src/main/java/com/tetherproxy/app/tunnel/Mux.kt`:
```kotlin
package com.tetherproxy.app.tunnel

import java.net.Socket
import java.util.concurrent.ConcurrentHashMap

/** Thread-safe streamId -> Socket registry mirroring the relay's mux. */
class Mux {
    private val streams = ConcurrentHashMap<Int, Socket>()

    fun put(streamId: Int, socket: Socket) {
        streams[streamId] = socket
    }

    fun get(streamId: Int): Socket? = streams[streamId]

    fun remove(streamId: Int): Socket? = streams.remove(streamId)

    fun contains(streamId: Int): Boolean = streams.containsKey(streamId)

    fun size(): Int = streams.size

    fun streamIds(): Set<Int> = streams.keys.toSet()

    /** Atomically drains every stream, returning the removed sockets. */
    fun removeAll(): List<Socket> {
        val snapshot = ArrayList(streams.values)
        streams.clear()
        return snapshot
    }
}
```

- [ ] **Step 4: Run and watch it PASS.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:testDebugUnitTest --tests "com.tetherproxy.app.tunnel.MuxTest"
```
  Expected: `BUILD SUCCESSFUL`, 7 tests pass.

- [ ] **Step 5: Commit.**
```bash
cd /home/hubextech/tetherproxy && git add android/app/src/main/java/com/tetherproxy/app/tunnel/Mux.kt android/app/src/test/java/com/tetherproxy/app/tunnel/MuxTest.kt
git commit -m "android: Mux streamId->Socket registry + JVM tests"
```

---

### Task 5: Backoff.kt — exponential backoff with jitter (TDD)

**Files:**
- Create: `android/app/src/test/java/com/tetherproxy/app/tunnel/BackoffTest.kt`
- Create: `android/app/src/main/java/com/tetherproxy/app/tunnel/Backoff.kt`

Backoff base sequence: 1s, 2s, 4s, 8s, 16s, capped at 30s. Jitter adds a random fraction (0..jitterFraction) of the base delay. We use a seeded RNG in tests for determinism.

- [ ] **Step 1: Write the failing test.**
  Create `android/app/src/test/java/com/tetherproxy/app/tunnel/BackoffTest.kt`:
```kotlin
package com.tetherproxy.app.tunnel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class BackoffTest {

    @Test
    fun baseDelay_doublesAndCapsAt30s() {
        val b = Backoff(baseMs = 1000, capMs = 30000, jitterFraction = 0.0)
        assertEquals(1000L, b.baseDelayMs(0))
        assertEquals(2000L, b.baseDelayMs(1))
        assertEquals(4000L, b.baseDelayMs(2))
        assertEquals(8000L, b.baseDelayMs(3))
        assertEquals(16000L, b.baseDelayMs(4))
        assertEquals(30000L, b.baseDelayMs(5)) // 32000 -> capped
        assertEquals(30000L, b.baseDelayMs(6))
        assertEquals(30000L, b.baseDelayMs(50))
    }

    @Test
    fun nextDelay_advancesAttemptAndFollowsSequence() {
        val b = Backoff(baseMs = 1000, capMs = 30000, jitterFraction = 0.0, rng = Random(1))
        assertEquals(1000L, b.nextDelayMs())
        assertEquals(2000L, b.nextDelayMs())
        assertEquals(4000L, b.nextDelayMs())
        assertEquals(8000L, b.nextDelayMs())
        assertEquals(16000L, b.nextDelayMs())
        assertEquals(30000L, b.nextDelayMs())
        assertEquals(30000L, b.nextDelayMs())
    }

    @Test
    fun reset_returnsToFirstDelay() {
        val b = Backoff(baseMs = 1000, capMs = 30000, jitterFraction = 0.0)
        b.nextDelayMs()
        b.nextDelayMs()
        b.reset()
        assertEquals(1000L, b.nextDelayMs())
    }

    @Test
    fun jitter_staysWithinBaseAndBasePlusFraction() {
        val b = Backoff(baseMs = 1000, capMs = 30000, jitterFraction = 0.5, rng = Random(123))
        repeat(200) {
            val base = b.baseDelayMs(b.attempt())
            val delay = b.nextDelayMs()
            assertTrue("delay $delay >= base $base", delay >= base)
            assertTrue("delay $delay <= base*1.5", delay <= base + (base * 0.5).toLong())
        }
    }

    @Test
    fun negativeAttempt_treatedAsZero() {
        val b = Backoff(baseMs = 1000, capMs = 30000, jitterFraction = 0.0)
        assertEquals(1000L, b.baseDelayMs(-5))
    }
}
```

- [ ] **Step 2: Run and watch it FAIL.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:testDebugUnitTest --tests "com.tetherproxy.app.tunnel.BackoffTest"
```
  Expected FAIL: `Unresolved reference: Backoff`.

- [ ] **Step 3: Implement `Backoff.kt`.**
  Create `android/app/src/main/java/com/tetherproxy/app/tunnel/Backoff.kt`:
```kotlin
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
```

- [ ] **Step 4: Run and watch it PASS.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:testDebugUnitTest --tests "com.tetherproxy.app.tunnel.BackoffTest"
```
  Expected: `BUILD SUCCESSFUL`, 5 tests pass.

- [ ] **Step 5: Commit.**
```bash
cd /home/hubextech/tetherproxy && git add android/app/src/main/java/com/tetherproxy/app/tunnel/Backoff.kt android/app/src/test/java/com/tetherproxy/app/tunnel/BackoffTest.kt
git commit -m "android: Backoff (1->2->4..->30s + jitter) + JVM tests"
```

---

### Task 6: Piping.kt — pure stream pump (TDD)

**Files:**
- Create: `android/app/src/test/java/com/tetherproxy/app/tunnel/PipingTest.kt`
- Create: `android/app/src/main/java/com/tetherproxy/app/tunnel/Piping.kt`

`Piping.pump` reads from an `InputStream` in fixed-size chunks and hands each chunk to a callback (the WS-send side wraps it in a DATA frame). It returns when EOF is reached and invokes an `onClosed` callback once. This is the testable core of `Dialer`'s socket→WS direction.

- [ ] **Step 1: Write the failing test.**
  Create `android/app/src/test/java/com/tetherproxy/app/tunnel/PipingTest.kt`:
```kotlin
package com.tetherproxy.app.tunnel

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream

class PipingTest {

    @Test
    fun pump_forwardsAllBytesInChunks_thenSignalsClose() {
        val input = ByteArrayInputStream(ByteArray(10) { it.toByte() })
        val collected = ByteArrayOutputStream()
        var closedCount = 0

        Piping.pump(
            source = input,
            bufferSize = 4,
            onChunk = { buf, len -> collected.write(buf, 0, len) },
            onClosed = { closedCount++ }
        )

        assertArrayEquals(ByteArray(10) { it.toByte() }, collected.toByteArray())
        assertEquals(1, closedCount)
    }

    @Test
    fun pump_emptySource_signalsCloseImmediately() {
        val input = ByteArrayInputStream(ByteArray(0))
        var closedCount = 0
        var chunkCount = 0
        Piping.pump(
            source = input,
            bufferSize = 8,
            onChunk = { _, _ -> chunkCount++ },
            onClosed = { closedCount++ }
        )
        assertEquals(0, chunkCount)
        assertEquals(1, closedCount)
    }

    @Test
    fun pump_chunkBoundariesMatchBufferSize() {
        val input = ByteArrayInputStream(ByteArray(9) { it.toByte() })
        val chunkLens = ArrayList<Int>()
        Piping.pump(
            source = input,
            bufferSize = 4,
            onChunk = { _, len -> chunkLens.add(len) },
            onClosed = { }
        )
        // 4 + 4 + 1
        assertEquals(listOf(4, 4, 1), chunkLens)
    }

    @Test
    fun pump_ioExceptionMidStream_stillSignalsCloseOnce() {
        val failing = object : InputStream() {
            private var n = 0
            override fun read(): Int = throw IOException("single-byte read not used")
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                n++
                if (n == 1) {
                    b[off] = 1
                    return 1
                }
                throw IOException("boom")
            }
        }
        var closedCount = 0
        var chunkCount = 0
        Piping.pump(
            source = failing,
            bufferSize = 4,
            onChunk = { _, _ -> chunkCount++ },
            onClosed = { closedCount++ }
        )
        assertEquals(1, chunkCount)
        assertEquals(1, closedCount)
    }

    @Test
    fun pump_onChunkThrows_propagatesButStillCloses() {
        val input = ByteArrayInputStream(ByteArray(4) { it.toByte() })
        var closedCount = 0
        var thrown = false
        try {
            Piping.pump(
                source = input,
                bufferSize = 4,
                onChunk = { _, _ -> throw IllegalStateException("ws closed") },
                onClosed = { closedCount++ }
            )
        } catch (e: IllegalStateException) {
            thrown = true
        }
        assertTrue(thrown)
        assertEquals(1, closedCount)
    }
}
```

- [ ] **Step 2: Run and watch it FAIL.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:testDebugUnitTest --tests "com.tetherproxy.app.tunnel.PipingTest"
```
  Expected FAIL: `Unresolved reference: Piping`.

- [ ] **Step 3: Implement `Piping.kt`.**
  Create `android/app/src/main/java/com/tetherproxy/app/tunnel/Piping.kt`:
```kotlin
package com.tetherproxy.app.tunnel

import java.io.IOException
import java.io.InputStream

/**
 * Pure, blocking stream pump. Reads [source] into a reusable buffer and emits
 * each chunk to [onChunk]; calls [onClosed] exactly once when reading finishes
 * (EOF or IOException). If [onChunk] throws, [onClosed] still runs before the
 * exception propagates.
 */
object Piping {
    fun pump(
        source: InputStream,
        bufferSize: Int,
        onChunk: (buffer: ByteArray, length: Int) -> Unit,
        onClosed: () -> Unit
    ) {
        val buffer = ByteArray(bufferSize)
        try {
            while (true) {
                val read = try {
                    source.read(buffer, 0, bufferSize)
                } catch (e: IOException) {
                    -1
                }
                if (read <= 0) break
                onChunk(buffer, read)
            }
        } finally {
            onClosed()
        }
    }
}
```

- [ ] **Step 4: Run and watch it PASS.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:testDebugUnitTest --tests "com.tetherproxy.app.tunnel.PipingTest"
```
  Expected: `BUILD SUCCESSFUL`, 5 tests pass.

- [ ] **Step 5: Commit.**
```bash
cd /home/hubextech/tetherproxy && git add android/app/src/main/java/com/tetherproxy/app/tunnel/Piping.kt android/app/src/test/java/com/tetherproxy/app/tunnel/PipingTest.kt
git commit -m "android: Piping pump (chunked source->callback, single close) + JVM tests"
```

---

### Task 7: PasswordGen.kt — strong random password generator (TDD)

**Files:**
- Create: `android/app/src/test/java/com/tetherproxy/app/util/PasswordGenTest.kt`
- Create: `android/app/src/main/java/com/tetherproxy/app/util/PasswordGen.kt`

Spec §4.2 / §8 require the Setup UI to "suggest a strong random password." The generator is pure (no Android dependencies) so it is driven test-first on the plain JVM with a seeded `java.util.Random` for determinism. The charset is restricted to characters that are safe in a proxy URL's userinfo without percent-encoding: lowercase `a-z`, uppercase `A-Z`, digits `0-9`, and the unreserved symbols `-._~`. The generator guarantees at least one character from each of those four classes.

- [ ] **Step 1: Write the failing test.**
  Create `android/app/src/test/java/com/tetherproxy/app/util/PasswordGenTest.kt`:
```kotlin
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
```

- [ ] **Step 2: Run the test and watch it FAIL (no `PasswordGen` yet).**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:testDebugUnitTest --tests "com.tetherproxy.app.util.PasswordGenTest"
```
  Expected FAIL: compilation error `Unresolved reference: PasswordGen`.

- [ ] **Step 3: Implement `PasswordGen.kt` (minimal to pass).**
  Create `android/app/src/main/java/com/tetherproxy/app/util/PasswordGen.kt`:
```kotlin
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
```

- [ ] **Step 4: Run the test and watch it PASS.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:testDebugUnitTest --tests "com.tetherproxy.app.util.PasswordGenTest"
```
  Expected: `BUILD SUCCESSFUL`, all 6 test methods pass.

- [ ] **Step 5: Commit.**
```bash
cd /home/hubextech/tetherproxy && git add android/app/src/main/java/com/tetherproxy/app/util/PasswordGen.kt android/app/src/test/java/com/tetherproxy/app/util/PasswordGenTest.kt
git commit -m "android: PasswordGen (URL-safe strong random password, all 4 classes) + JVM tests"
```

---

### Task 8: TunnelStatus.kt — immutable status model

**Files:**
- Create: `android/app/src/main/java/com/tetherproxy/app/tunnel/TunnelStatus.kt`

This is a plain data class with no Android dependencies; no test is needed beyond compilation (it is exercised by the service/UI later).

- [ ] **Step 1: Create `TunnelStatus.kt`.**
  Create `android/app/src/main/java/com/tetherproxy/app/tunnel/TunnelStatus.kt`:
```kotlin
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
```

- [ ] **Step 2: Confirm it compiles.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:compileDebugKotlin
```
  Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit.**
```bash
cd /home/hubextech/tetherproxy && git add android/app/src/main/java/com/tetherproxy/app/tunnel/TunnelStatus.kt
git commit -m "android: TunnelStatus model + ConnState enum"
```

---

### Task 9: Store.kt — EncryptedSharedPreferences wrapper

**Files:**
- Create: `android/app/src/main/java/com/tetherproxy/app/data/Store.kt`

Android-framework-bound (needs `Context` + Android Keystore), so it is verified via the build + manual device steps in Task 17, not a JVM unit test.

- [ ] **Step 1: Create `Store.kt`.**
  Create `android/app/src/main/java/com/tetherproxy/app/data/Store.kt`:
```kotlin
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

    /** Pinned relay cert SHA-256 fingerprint (hex, lowercase, no colons), or "" for TOFU. */
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
```

- [ ] **Step 2: Confirm it compiles.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:compileDebugKotlin
```
  Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit.**
```bash
cd /home/hubextech/tetherproxy && git add android/app/src/main/java/com/tetherproxy/app/data/Store.kt
git commit -m "android: Store (EncryptedSharedPreferences for config, creds, pinned fingerprint)"
```

---

### Task 10: WsClient.kt — OkHttp WebSocket with fingerprint pinning

**Files:**
- Create: `android/app/src/main/java/com/tetherproxy/app/tunnel/WsClient.kt`

Network/TLS-bound, so verified via build + manual pairing in Task 17. The frame dispatch uses the already-tested `Frames` codec.

- [ ] **Step 1: Create `WsClient.kt`.**
  Create `android/app/src/main/java/com/tetherproxy/app/tunnel/WsClient.kt`:
```kotlin
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
            if (!fp.equals(pinnedSha256Hex, ignoreCase = true)) {
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
        val client = buildClient()
        val request = Request.Builder()
            .url("wss://$host:$port/")
            .build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // Send AUTH first thing.
                webSocket.send(Frames.encode(FrameType.AUTH, 0, authPayload).toByteString())
                events.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
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
                events.onClosed("closed: $code $reason")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                events.onClosed("failure: ${t.message}")
            }
        })
    }

    /** Send a pre-encoded frame. Returns false if the socket is gone. */
    fun sendFrame(type: FrameType, streamId: Int, payload: ByteArray): Boolean {
        val ws = webSocket ?: return false
        return ws.send(Frames.encode(type, streamId, payload).toByteString())
    }

    fun lastObservedFingerprint(): String? = observedFingerprint

    fun close() {
        webSocket?.close(1000, "client shutdown")
        webSocket = null
    }

    private fun parseReason(payload: ByteArray): String {
        if (payload.isEmpty()) return "unknown"
        return try {
            Frames.parseJson(String(payload, Charsets.UTF_8))["reason"] ?: "unknown"
        } catch (e: Exception) {
            "unknown"
        }
    }

    companion object {
        /** Lowercase hex SHA-256 of the DER-encoded certificate (no colons). */
        fun sha256Hex(der: ByteArray): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(der)
            val sb = StringBuilder(digest.size * 2)
            for (b in digest) {
                val v = b.toInt() and 0xFF
                sb.append("0123456789abcdef"[v ushr 4])
                sb.append("0123456789abcdef"[v and 0x0F])
            }
            return sb.toString()
        }
    }
}
```

- [ ] **Step 2: Confirm it compiles.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:compileDebugKotlin
```
  Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit.**
```bash
cd /home/hubextech/tetherproxy && git add android/app/src/main/java/com/tetherproxy/app/tunnel/WsClient.kt
git commit -m "android: WsClient (OkHttp WSS, SHA-256 fingerprint pin/TOFU, AUTH + frame dispatch + PONG)"
```

---

### Task 11: Dialer.kt — OPEN handling + bidirectional pipe

**Files:**
- Create: `android/app/src/main/java/com/tetherproxy/app/tunnel/Dialer.kt`

The byte-pumping core (`Piping`) is already JVM-tested (Task 6). `Dialer` wires real sockets + coroutines around it; verified via build + the manual end-to-end smoke test (Task 17).

- [ ] **Step 1: Create `Dialer.kt`.**
  Create `android/app/src/main/java/com/tetherproxy/app/tunnel/Dialer.kt`:
```kotlin
package com.tetherproxy.app.tunnel

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket

/** What a Dialer needs from its owner to talk back over the tunnel + count bytes. */
interface DialerSink {
    /** Send a frame back to the relay. */
    fun send(type: FrameType, streamId: Int, payload: ByteArray): Boolean
    /** Report bytes read from the target socket (tunnel "in" from target's perspective). */
    fun addBytesIn(n: Long)
    /** Report bytes written to the target socket. */
    fun addBytesOut(n: Long)
    /** Active stream count changed. */
    fun onActiveStreamsChanged(count: Int)
}

/**
 * For each OPEN(host, port) opens a raw TCP socket over the phone's current network,
 * replies OPEN_OK or OPEN_FAIL, then pumps target->WS as DATA frames in a coroutine.
 * DATA from the relay is written to the target via [onData]; CLOSE tears the stream down.
 */
class Dialer(
    private val scope: CoroutineScope,
    private val mux: Mux,
    private val sink: DialerSink,
    private val connectTimeoutMs: Int = 15000,
    private val bufferSize: Int = 16 * 1024
) {
    /** Handle an OPEN frame: connect, reply, and start the target->WS pump. */
    fun onOpen(streamId: Int, host: String, port: Int) {
        scope.launch(Dispatchers.IO) {
            val socket = Socket()
            try {
                socket.connect(InetSocketAddress(host, port), connectTimeoutMs)
            } catch (e: Exception) {
                runCatching { socket.close() }
                sink.send(
                    FrameType.OPEN_FAIL,
                    streamId,
                    openFailJson(e.message ?: "connect failed")
                )
                return@launch
            }
            mux.put(streamId, socket)
            sink.onActiveStreamsChanged(mux.size())
            sink.send(FrameType.OPEN_OK, streamId, ByteArray(0))

            // Pump target -> WS until EOF/error, then CLOSE + cleanup.
            try {
                Piping.pump(
                    source = socket.getInputStream(),
                    bufferSize = bufferSize,
                    onChunk = { buf, len ->
                        val slice = buf.copyOf(len)
                        sink.send(FrameType.DATA, streamId, slice)
                        sink.addBytesIn(len.toLong())
                    },
                    onClosed = { }
                )
            } finally {
                teardown(streamId, sendClose = true)
            }
        }
    }

    /** Handle a DATA frame from the relay: write the bytes to the target socket. */
    fun onData(streamId: Int, payload: ByteArray) {
        val socket = mux.get(streamId) ?: return
        scope.launch(Dispatchers.IO) {
            try {
                val out: OutputStream = socket.getOutputStream()
                out.write(payload)
                out.flush()
                sink.addBytesOut(payload.size.toLong())
            } catch (e: Exception) {
                teardown(streamId, sendClose = true)
            }
        }
    }

    /** Handle a CLOSE frame from the relay: drop the stream without echoing CLOSE. */
    fun onClose(streamId: Int) {
        teardown(streamId, sendClose = false)
    }

    /** Drop every active stream (used on tunnel loss / shutdown). */
    fun closeAll() {
        for (socket in mux.removeAll()) {
            runCatching { socket.close() }
        }
        sink.onActiveStreamsChanged(0)
    }

    private fun teardown(streamId: Int, sendClose: Boolean) {
        val socket = mux.remove(streamId) ?: return
        runCatching { socket.close() }
        if (sendClose) {
            sink.send(FrameType.CLOSE, streamId, ByteArray(0))
        }
        sink.onActiveStreamsChanged(mux.size())
    }

    private fun openFailJson(reason: String): ByteArray =
        Frames.utf8("""{"reason":${quote(reason)}}""")

    private fun quote(s: String): String {
        val sb = StringBuilder("\"")
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> sb.append(c)
            }
        }
        sb.append("\"")
        return sb.toString()
    }
}
```

- [ ] **Step 2: Confirm it compiles.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:compileDebugKotlin
```
  Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit.**
```bash
cd /home/hubextech/tetherproxy && git add android/app/src/main/java/com/tetherproxy/app/tunnel/Dialer.kt
git commit -m "android: Dialer (OPEN->socket, OPEN_OK/FAIL, DATA<->socket pump, CLOSE teardown)"
```

---

### Task 12: Reconnector.kt — backoff loop + NetworkCallback

**Files:**
- Create: `android/app/src/main/java/com/tetherproxy/app/tunnel/Reconnector.kt`

The backoff math is already JVM-tested in `Backoff` (Task 5). `Reconnector` wires `Backoff` to a coroutine delay loop + the Android `ConnectivityManager.NetworkCallback`; the Android-bound part is verified manually (Task 17) by toggling WiFi/airplane mode.

- [ ] **Step 1: Create `Reconnector.kt`.**
  Create `android/app/src/main/java/com/tetherproxy/app/tunnel/Reconnector.kt`:
```kotlin
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

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            // New usable network: reconnect now instead of waiting out the backoff.
            forceReconnectNow()
        }

        override fun onCapabilitiesChanged(
            network: Network,
            networkCapabilities: NetworkCapabilities
        ) {
            if (networkCapabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                forceReconnectNow()
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
        if (registered) {
            runCatching { cm.unregisterNetworkCallback(networkCallback) }
            registered = false
        }
    }
}
```

- [ ] **Step 2: Confirm it compiles.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:compileDebugKotlin
```
  Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit.**
```bash
cd /home/hubextech/tetherproxy && git add android/app/src/main/java/com/tetherproxy/app/tunnel/Reconnector.kt
git commit -m "android: Reconnector (Backoff loop + ConnectivityManager NetworkCallback)"
```

---

### Task 13: TunnelService.kt — foreground service tying it together

**Files:**
- Create: `android/app/src/main/java/com/tetherproxy/app/service/TunnelService.kt`

Foreground-service-bound; verified via build + manual steps (Task 17). It owns `WsClient` + `Dialer` + `Reconnector`, publishes a global `StateFlow<TunnelStatus>` and implements `WsEvents` + `DialerSink`.

- [ ] **Step 1: Create `TunnelService.kt`.**
  Create `android/app/src/main/java/com/tetherproxy/app/service/TunnelService.kt`:
```kotlin
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
```

- [ ] **Step 2: Confirm it compiles** (depends on `MainActivity` + `R`; if `MainActivity` is not yet created the Kotlin compile will fail on its import — so create a minimal stub now and replace it fully in Task 15).
  Create the stub `android/app/src/main/java/com/tetherproxy/app/ui/MainActivity.kt`:
```kotlin
package com.tetherproxy.app.ui

import android.app.Activity

/** Stub replaced in full by Task 15. */
class MainActivity : Activity()
```
  Then:
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:compileDebugKotlin
```
  Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit.**
```bash
cd /home/hubextech/tetherproxy && git add android/app/src/main/java/com/tetherproxy/app/service/TunnelService.kt android/app/src/main/java/com/tetherproxy/app/ui/MainActivity.kt
git commit -m "android: TunnelService (foreground dataSync, wakelock, owns WsClient/Dialer/Reconnector, status StateFlow)"
```

---

### Task 14: BootReceiver.kt — optional auto-start

**Files:**
- Create: `android/app/src/main/java/com/tetherproxy/app/service/BootReceiver.kt`

- [ ] **Step 1: Create `BootReceiver.kt`.**
  Create `android/app/src/main/java/com/tetherproxy/app/service/BootReceiver.kt`:
```kotlin
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
```

- [ ] **Step 2: Confirm it compiles.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:compileDebugKotlin
```
  Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit.**
```bash
cd /home/hubextech/tetherproxy && git add android/app/src/main/java/com/tetherproxy/app/service/BootReceiver.kt
git commit -m "android: BootReceiver (auto-start when opted-in and configured)"
```

---

### Task 15: Compose UI — Theme, ViewModel, Setup, Status, MainActivity

**Files:**
- Create: `android/app/src/main/java/com/tetherproxy/app/ui/Theme.kt`
- Create: `android/app/src/main/java/com/tetherproxy/app/ui/AppViewModel.kt`
- Create: `android/app/src/main/java/com/tetherproxy/app/ui/SetupScreen.kt`
- Create: `android/app/src/main/java/com/tetherproxy/app/ui/StatusScreen.kt`
- Modify: `android/app/src/main/java/com/tetherproxy/app/ui/MainActivity.kt` (replace the Task 13 stub)

Compose is framework-bound; verified by build + manual run (Task 17).

- [ ] **Step 1: Create `Theme.kt`.**
  Create `android/app/src/main/java/com/tetherproxy/app/ui/Theme.kt`:
```kotlin
package com.tetherproxy.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

@Composable
fun TetherTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = darkColorScheme(), content = content)
}
```

- [ ] **Step 2: Create `AppViewModel.kt`.**
  Create `android/app/src/main/java/com/tetherproxy/app/ui/AppViewModel.kt`:
```kotlin
package com.tetherproxy.app.ui

import android.app.Application
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
```

- [ ] **Step 3: Create `SetupScreen.kt`.**
  Create `android/app/src/main/java/com/tetherproxy/app/ui/SetupScreen.kt`:
```kotlin
package com.tetherproxy.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions

@Composable
fun SetupScreen(viewModel: AppViewModel, onGoToStatus: () -> Unit) {
    val form by viewModel.form.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("Relay setup")

        OutlinedTextField(
            value = form.relayHost,
            onValueChange = { v -> viewModel.update { it.copy(relayHost = v) } },
            label = { Text("Relay host / IP") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = form.tunnelPort,
            onValueChange = { v -> viewModel.update { it.copy(tunnelPort = v) } },
            label = { Text("Tunnel port (WSS)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = form.proxyPort,
            onValueChange = { v -> viewModel.update { it.copy(proxyPort = v) } },
            label = { Text("Proxy port") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = form.proxyTlsPort,
            onValueChange = { v -> viewModel.update { it.copy(proxyTlsPort = v) } },
            label = { Text("Proxy TLS port (optional)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = form.pairingToken,
            onValueChange = { v -> viewModel.update { it.copy(pairingToken = v) } },
            label = { Text("Pairing token") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = form.proxyUsername,
            onValueChange = { v -> viewModel.update { it.copy(proxyUsername = v) } },
            label = { Text("Proxy username") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = form.proxyPassword,
            onValueChange = { v -> viewModel.update { it.copy(proxyPassword = v) } },
            label = { Text("Proxy password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            trailingIcon = {
                // Spec §4.2/§8: suggest a strong random password.
                TextButton(onClick = { viewModel.generatePassword() }) {
                    Text("Generate")
                }
            },
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = form.pinnedFingerprint,
            onValueChange = { v -> viewModel.update { it.copy(pinnedFingerprint = v) } },
            label = { Text("Pinned cert SHA-256 (blank = trust on first use)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Switch(
                checked = form.autoStartOnBoot,
                onCheckedChange = { v -> viewModel.update { it.copy(autoStartOnBoot = v) } }
            )
            Text("  Auto-start on boot")
        }

        Button(
            onClick = {
                viewModel.saveAndConnect()
                onGoToStatus()
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Save & Connect")
        }
        TextButton(onClick = onGoToStatus, modifier = Modifier.fillMaxWidth()) {
            Text("Go to status")
        }
    }
}
```
  **Manual verification (Spec §4.2/§8 — suggest a strong random password):** on the
  Setup screen tap **Generate** in the Proxy password field. Expected: the field
  fills with a fresh 20-character password drawn only from `a-z A-Z 0-9 -._~`,
  containing at least one of each class; tapping it again yields a different value.
  This is re-verified on-device in Task 17, Step 2.

- [ ] **Step 4: Create `StatusScreen.kt`.**
  Create `android/app/src/main/java/com/tetherproxy/app/ui/StatusScreen.kt`:
```kotlin
package com.tetherproxy.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Divider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun StatusScreen(viewModel: AppViewModel, onGoToSetup: () -> Unit) {
    val status by viewModel.status.collectAsState()
    val egressIp by viewModel.egressIp.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("Status")
        Divider()
        Text("Connection: ${status.state}")
        Text("Relay: ${status.relayHost ?: "-"}")
        Text("Bytes in:  ${status.bytesIn}")
        Text("Bytes out: ${status.bytesOut}")
        Text("Active streams: ${status.activeStreams}")
        Text("Last error: ${status.lastError ?: "none"}")
        Divider()
        Text("Egress self-test (phone's public IP): ${egressIp ?: "not run"}")
        OutlinedButton(
            onClick = { viewModel.runEgressSelfTest() },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Run egress IP self-test")
        }
        Divider()
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Button(
                onClick = { viewModel.start() },
                modifier = Modifier.weight(1f)
            ) { Text("Start") }
            Button(
                onClick = { viewModel.stop() },
                modifier = Modifier.weight(1f)
            ) { Text("Stop") }
        }
        TextButton(onClick = onGoToSetup, modifier = Modifier.fillMaxWidth()) {
            Text("Go to setup")
        }
    }
}
```

- [ ] **Step 5: Replace the stub `MainActivity.kt` with the full Compose host + permission/battery prompts.**
  Overwrite `android/app/src/main/java/com/tetherproxy/app/ui/MainActivity.kt`:
```kotlin
package com.tetherproxy.app.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel

class MainActivity : ComponentActivity() {

    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* result ignored */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        maybeRequestNotificationPermission()
        maybePromptBatteryExemption()

        setContent {
            TetherTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    val vm: AppViewModel = viewModel()
                    var showStatus by remember { mutableStateOf(vm.isConfigured()) }
                    Scaffold { padding ->
                        if (showStatus) {
                            StatusScreen(
                                viewModel = vm,
                                onGoToSetup = { showStatus = false }
                            )
                        } else {
                            SetupScreen(
                                viewModel = vm,
                                onGoToStatus = { showStatus = true }
                            )
                        }
                    }
                }
            }
        }
    }

    private fun maybeRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                this, Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    private fun maybePromptBatteryExemption() {
        val pm = getSystemService(PowerManager::class.java)
        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            runCatching { startActivity(intent) }
        }
    }
}
```

- [ ] **Step 6: Build the debug variant end-to-end.**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:assembleDebug
```
  Expected: `BUILD SUCCESSFUL`. The APK appears at `android/app/build/outputs/apk/debug/app-debug.apk`.

- [ ] **Step 7: Run the full JVM unit-test suite (regression check across all pure-logic tasks).**
```bash
cd /home/hubextech/tetherproxy/android && ./gradlew :app:testDebugUnitTest
```
  Expected: `BUILD SUCCESSFUL`; FramesTest, MuxTest, BackoffTest, PipingTest, PasswordGenTest all green.

- [ ] **Step 8: Commit.**
```bash
cd /home/hubextech/tetherproxy && git add android/app/src/main/java/com/tetherproxy/app/ui/Theme.kt android/app/src/main/java/com/tetherproxy/app/ui/AppViewModel.kt android/app/src/main/java/com/tetherproxy/app/ui/SetupScreen.kt android/app/src/main/java/com/tetherproxy/app/ui/StatusScreen.kt android/app/src/main/java/com/tetherproxy/app/ui/MainActivity.kt
git commit -m "android: Compose UI (Setup + Status screens, ViewModel, egress self-test, perms/battery prompts)"
```

---

### Task 16: README + build/ship instructions

**Files:**
- Create: `android/README.md`

- [ ] **Step 1: Create `android/README.md`.**
  Create `android/README.md`:
````markdown
# TetherProxy — Android app

Native Kotlin (Jetpack Compose) app. Runs an always-on foreground service that
holds one WSS tunnel to the relay and, for each forwarded request, opens a raw
TCP socket to the target over the phone's current network (SIM or WiFi) and pipes
bytes. All proxy-protocol/auth logic lives on the relay; the phone only opens
sockets and pumps bytes.

## Requirements
- JDK 17
- Android SDK (set `sdk.dir` in `android/local.properties`, e.g. `sdk.dir=/home/you/Android/Sdk`)
- A phone (or emulator) on Android 8.0+ (minSdk 26)

## Build

```bash
cd android
./gradlew assembleDebug
```

The debug APK is produced at:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

Run the JVM unit tests (frame codec, mux, backoff, piping):

```bash
cd android
./gradlew testDebugUnitTest
```

## Install on a phone

Enable Developer Options + USB debugging on the phone, plug it in, then:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## First-run pairing

1. Open the app. The **Setup** screen appears.
2. Enter:
   - **Relay host / IP** — your relay's public IP (Alibaba ECS).
   - **Tunnel port** — `8443` (default).
   - **Proxy port** — `8080` (the relay's proxy listener; used in the smoke test).
   - **Proxy TLS port** — `8081` (optional).
   - **Pairing token** — the `PAIRING_TOKEN` the relay was deployed with.
   - **Proxy username / password** — the credentials cloud clients will use.
   - **Pinned cert SHA-256** — leave **blank** on first run to trust-on-first-use
     (TOFU): the app records the relay cert's fingerprint and pins it for next time.
     To pin explicitly, paste the SHA-256 fingerprint the relay printed on boot.
3. Tap **Save & Connect**. Grant the notification permission and accept the
   battery-optimization exemption prompt (so the OS keeps the tunnel alive in Doze).
4. The **Status** screen shows `CONNECTED` once AUTH_OK is received.

### Pinning the fingerprint
- After a first TOFU connect, return to **Setup**; the **Pinned cert SHA-256**
  field is now populated with the observed fingerprint. Verify it matches the
  fingerprint the relay printed (lowercase hex, no colons), then re-save to lock it in.

## Egress self-test (on the phone)
On the **Status** screen tap **Run egress IP self-test**. The app fetches
`https://api.ipify.org` directly (not via the proxy) and shows the phone's public
IP — this is the IP cloud clients will egress from.

## Cloud smoke test (run from your cloud / laptop)

With the service `CONNECTED`, run from any machine that can reach the relay:

```bash
curl -x http://USER:PASS@<relay-ip>:8080 https://api.ipify.org
```

The printed IP must equal the phone's public IP from the self-test above —
confirming traffic egresses from the phone's home internet. Set the same value as
`HTTPS_PROXY`/`HTTP_PROXY` in GCP/Netlify/Vercel for zero-code-change proxying:

```bash
export HTTPS_PROXY=http://USER:PASS@<relay-ip>:8080
export HTTP_PROXY=http://USER:PASS@<relay-ip>:8080
```

## Reliability notes
- Keep the phone plugged in.
- The service is `START_STICKY`, holds a partial wakelock, and reconnects with
  exponential backoff (1→2→4…→30s + jitter). A network change (WiFi↔SIM) triggers
  an immediate reconnect via `ConnectivityManager.NetworkCallback`.
- Enable **Auto-start on boot** in Setup to restart the tunnel after a reboot.
````

- [ ] **Step 2: Commit.**
```bash
cd /home/hubextech/tetherproxy && git add android/README.md
git commit -m "android: README (build, adb install, pairing, fingerprint pinning, smoke test)"
```

---

### Task 17: Manual end-to-end verification (device)

**Files:** none (verification only; no code).

This task documents the manual checks for the Android-framework-bound pieces (Service, Compose, Reconnector NetworkCallback, Store keystore, WsClient TLS) that cannot run as JVM unit tests. Requires a running relay (separate plan) and a real phone.

- [ ] **Step 1: Install and launch.**
```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.tetherproxy.app/.ui.MainActivity
```
  Expected: Setup screen renders; no crash in `adb logcat | grep -i tetherproxy`.

- [ ] **Step 2: Pair and connect.**
  Fill Setup with the relay IP, port `8443`, the relay's `PAIRING_TOKEN`, and a username. For the password, tap **Generate** (Spec §4.2/§8) — confirm it fills a 20-char strong password (only `a-z A-Z 0-9 -._~`) — then leave fingerprint blank (TOFU) and tap **Save & Connect**. Grant notification + battery prompts.
  Expected: persistent "TetherProxy running" notification appears; Status shows `CONNECTED`; `adb logcat` shows the WSS connect and AUTH_OK. Returning to Setup shows the now-populated **Pinned cert SHA-256** field.

- [ ] **Step 3: Egress self-test.**
  On Status tap **Run egress IP self-test**. Expected: it shows the phone's public IP (matches `https://api.ipify.org` opened in the phone's browser).

- [ ] **Step 4: Cloud smoke test (proves the full pipe + Dialer + Frames wire-compat with the relay).**
```bash
curl -x http://USER:PASS@<relay-ip>:8080 https://api.ipify.org
```
  Expected: prints the **same** IP as Step 3. On Status, **Bytes in/out** increment and **Active streams** briefly shows 1.

- [ ] **Step 5: Reconnect on network switch (verifies Reconnector NetworkCallback).**
  Toggle airplane mode on then off, or switch WiFi↔mobile data, while watching Status.
  Expected: state goes `RECONNECTING` then back to `CONNECTED` within a few seconds (immediate reconnect on the new network, not waiting out the full backoff). Re-run the curl smoke test; it still returns the phone IP.

- [ ] **Step 6: Survives screen-off / Doze (verifies foreground service + wakelock + battery exemption).**
  Turn the screen off, wait a few minutes, re-run the curl smoke test.
  Expected: still works; notification persists; `adb shell dumpsys activity services com.tetherproxy.app` shows `TunnelService` running.

- [ ] **Step 7: Stop.**
  On Status tap **Stop**.
  Expected: notification disappears; state `STOPPED`; the curl smoke test now returns `503 Service Unavailable` from the relay (no live phone).

- [ ] **Step 8: (Optional) Auto-start on boot.**
  Enable **Auto-start on boot** in Setup, reboot the phone (`adb reboot`).
  Expected: after boot the notification reappears and Status reaches `CONNECTED` without opening the app manually.

---

## Done criteria
- `./gradlew :app:testDebugUnitTest` is green (FramesTest, MuxTest, BackoffTest, PipingTest, PasswordGenTest).
- `./gradlew :app:assembleDebug` produces `android/app/build/outputs/apk/debug/app-debug.apk`.
- Manual Task 17 steps pass against a live relay: the cloud `curl` smoke test returns the phone's public IP, bytes/streams update, and the tunnel survives a network switch and screen-off.
