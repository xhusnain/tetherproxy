# TetherProxy — Android app

Native Kotlin (Jetpack Compose) app. Runs an always-on foreground service that
holds one WSS tunnel to the relay and, for each forwarded request, opens a raw
TCP socket to the target over the phone's current network (SIM or WiFi) and pipes
bytes. All proxy-protocol/auth logic lives on the relay; the phone only opens
sockets and pumps bytes.

## Requirements

- **JDK 17** (`JAVA_HOME` pointing at a JDK 17 install)
- **Android SDK** with:
  - `cmdline-tools` (latest)
  - Platform `android-34`
  - Build-tools `34.0.0`
- Set `sdk.dir` in `android/local.properties` (create it if absent):
  ```
  sdk.dir=/path/to/your/Android/Sdk
  ```
  Alternatively export `ANDROID_HOME` before building.
- A phone (or emulator) on **Android 8.0+** (minSdk 26)

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

Enable **Developer Options** and **USB debugging** on the phone, plug it in, then:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## First-run pairing

1. Open the app. The **Setup** screen appears.
2. Fill in all fields:
   - **Relay host / IP** — your relay's public IP (e.g. the Alibaba ECS instance).
   - **Tunnel port (WSS)** — `8443` (default; the relay's WSS listener).
   - **Proxy port** — `8080` (the relay's HTTP-proxy listener; used in the smoke test).
   - **Proxy TLS port (optional)** — `8081` (leave as default unless you changed it on the relay).
   - **Pairing token** — the `PAIRING_TOKEN` value from the relay's `.env`.
   - **Proxy username / password** — credentials cloud clients will use to authenticate.
     Tap **Generate** to get a strong random password.
   - **Pinned cert SHA-256** — leave **blank** on first run for trust-on-first-use (TOFU):
     the app records the relay's TLS certificate fingerprint on the first successful
     connection and pins it for all subsequent connections.
     To pin explicitly from the start, paste the SHA-256 fingerprint the relay
     printed on boot (any format — uppercase colon-separated `AA:BB:…` or lowercase
     hex without colons — is accepted).
   - **Auto-start on boot** — toggle on to restart the tunnel automatically after
     a phone reboot.
3. Tap **Save & Connect**. Grant the notification permission when prompted, and accept
   the battery-optimization exemption prompt so the OS keeps the service alive in Doze.
4. The **Status** screen shows `CONNECTED` once AUTH_OK is received from the relay.

### Verifying the pinned fingerprint

After the first TOFU connect, return to **Setup**; the **Pinned cert SHA-256** field
is now populated with the observed fingerprint (lowercase hex, no colons). Compare it
against the fingerprint the relay printed on boot, then tap **Save & Connect** again
to lock it in. From this point on the app rejects any relay cert that does not match.

To get the relay fingerprint independently:

```bash
openssl s_client -connect <relay-ip>:8443 </dev/null 2>/dev/null \
  | openssl x509 -fingerprint -sha256 -noout
```

## Egress self-test (on the phone)

On the **Status** screen tap **Run egress IP self-test**. The app fetches
`https://api.ipify.org` directly (not via the proxy) and displays the phone's public
IP — this is the IP that cloud clients will egress from when they use the proxy.

## Cloud smoke test (run from your cloud instance / laptop)

With the service `CONNECTED`, run from any machine that can reach the relay:

```bash
curl -x http://USER:PASS@<relay-ip>:8080 https://api.ipify.org
```

The printed IP must equal the phone's public IP from the self-test above —
confirming traffic egresses from the phone's home internet connection.

Set the same value as `HTTPS_PROXY` / `HTTP_PROXY` in GCP, Netlify, Vercel, or any
other cloud environment for zero-code-change proxying:

```bash
export HTTPS_PROXY=http://USER:PASS@<relay-ip>:8080
export HTTP_PROXY=http://USER:PASS@<relay-ip>:8080
```

## Reliability notes

- Keep the phone **plugged in** to avoid the battery being fully discharged.
- The service is `START_STICKY`, holds a partial wakelock, and reconnects automatically
  with exponential backoff (1 s → 2 s → 4 s … → 30 s cap, plus random jitter).
- A network change (WiFi ↔ SIM) triggers an immediate reconnect via
  `ConnectivityManager.NetworkCallback` — no need to wait out the backoff.
- Enable **Auto-start on boot** in Setup so the service restarts after a phone reboot
  without manual intervention.
- All credentials and the pinned fingerprint are stored in `EncryptedSharedPreferences`
  (AES-256-GCM) — they are never written to plain storage.
