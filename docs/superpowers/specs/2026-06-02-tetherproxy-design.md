# TetherProxy — Design Spec

- **Date:** 2026-06-02
- **Status:** Approved (design), pending implementation plan
- **Author:** Husnain + Claude
- **Working name:** TetherProxy (rename freely)

## 1. Problem & Goal

Husnain needs to call certain APIs from cloud code (GCP, Netlify, Vercel, etc.) such
that the requests **egress from his home internet connection** (his phone's IP), not
from the cloud provider's IP. The solution is a personal residential proxy:

- An **Android app** turns the phone into an HTTP/HTTPS proxy egress point.
- The user **sets a username and password** in the app; cloud code authenticates with
  those.
- The proxy is reachable from the public internet so any cloud provider can use it via
  the standard `HTTPS_PROXY` / `HTTP_PROXY` environment variables — **no code changes**.

This is for the user's **own phone, own home internet, own APIs** — a legitimate
personal "bring-your-own-IP" setup, not a third-party or abusive proxy.

## 2. Hard Constraints (these dictate the architecture)

1. **The phone cannot accept inbound connections.** On mobile data it sits behind
   carrier-grade NAT; on home WiFi behind a router NAT. Nothing on the public internet
   can dial into it directly.
2. **The phone's network changes constantly** (SIM ↔ home WiFi). No fixed IP, no
   port-forwarding possible.
3. **Traffic is HTTPS** → the proxy must support the HTTP `CONNECT` method (TLS
   tunneling). Plain HTTP is also supported for completeness.
4. **Always-on, 24/7** → the phone must hold its connection open continuously and
   survive network switches, screen-off, and Doze.

Consequence: the phone can only ever **dial out** and hold a line open. Something
**always-on with a public IP** must be on the other end to (a) keep that line open and
(b) accept proxy connections from cloud clients. That "something" is the **relay**.
Serverless platforms (Cloudflare Workers, Netlify, Vercel) **cannot** be the relay:
they are ephemeral, stateless, and cannot bind a raw TCP port / accept `CONNECT`
(confirmed: Cloudflare docs — inbound TCP/CONNECT unsupported; Vercel KB — functions
terminate after responding, no persistent socket). The relay must be a persistent
process on a real machine.

## 3. Architecture

```
  Cloud code (GCP / Netlify / Vercel / anywhere) = proxy CLIENT
    │   HTTPS_PROXY = http://USER:PASS@<relay-ip>:8080
    ▼
 ┌────────────────────────────────────────────┐
 │ RELAY  (Node.js, Docker, on Alibaba Cloud ECS, public IP)   = proxy SERVER
 │  • TCP proxy listener :8080  → Basic-auth (USER:PASS), CONNECT + plain HTTP
 │  • WSS tunnel endpoint :8443 → one persistent WebSocket per phone
 │  • stream multiplexer        → many proxy conns over the one tunnel
 │  • device + credential store → who is paired, which phone is live
 └────────────────────────────────────────────┘
    ▲  │   persistent wss:// (phone dialed OUT → NAT is a non-issue)
    │  ▼
 ┌────────────────────────────────────────────┐
 │ ANDROID APP (Kotlin)  = remote dialer + always-on agent
 │  • foreground service holds the wss tunnel open 24/7, auto-reconnect
 │  • per request: open a raw TCP socket to the target host, pipe bytes
 │  • 2-screen UI: setup (relay + username/password) / live status
 └────────────────────────────────────────────┘
    │   outbound TCP over SIM or home WiFi  ← the "home internet" egress
    ▼
  Target API  (sees the phone's current IP)
```

### Why this shape
- The phone makes **only outbound** connections (to the relay, and to target hosts), so
  it works identically on SIM or WiFi and recovers from every network switch by simply
  reconnecting.
- All proxy-protocol + auth complexity lives on the **relay** (Node.js — easy to write,
  test, run), keeping the phone's job tiny (open socket, pipe bytes) — which is the part
  hardest to make bulletproof on mobile.
- From the cloud side it is literally **one environment variable**.

## 4. Components

### 4.1 Relay (`relay/`, Node.js + TypeScript, Docker)

Modules:
- **`proxyServer`** — raw TCP server on `:8080`. Parses the first request line + headers.
  - `CONNECT host:port` → validate `Proxy-Authorization: Basic` → allocate a stream →
    send `OPEN` to the phone → on `OPEN_OK` reply `200 Connection Established` and pipe →
    on `OPEN_FAIL` reply `502`.
  - Absolute-URI HTTP (`GET http://host/path`) → same, forwarding the raw request bytes.
  - Missing/invalid auth → `407 Proxy Authentication Required` + `Proxy-Authenticate`.
  - No live phone → `503 Service Unavailable`.
  - Optional: also accept a TLS proxy listener on `:8081` (`HTTPS_PROXY=https://…`) so
    credentials are encrypted on the client→relay hop. Distinct from the tunnel port.
- **`tunnelServer`** — WSS endpoint on `:8443` accepting one WebSocket per phone. Handles
  the AUTH/pairing handshake and owns the live device registry.
- **`mux`** — multiplexes many proxy connections over a phone's single WebSocket using
  the framing in §6. Maps `streamId → client socket`.
- **`auth`** — bcrypt hash/verify of proxy passwords; pairing-token check.
- **`store`** — persists devices + credentials (small SQLite or JSON file on a Docker
  volume): `{ deviceId, proxyUsername, bcryptPassword, createdAt }`.
- **`config`** — env: `PAIRING_TOKEN`, `PROXY_PORT=8080`, `PROXY_TLS_PORT=8081`
  (optional), `TUNNEL_PORT=8443`, `ALLOWED_CLIENT_CIDRS` (optional IP allowlist),
  TLS cert paths.
- **TLS**: self-signed cert generated on first boot (fingerprint printed for pinning), or
  Let's Encrypt via Caddy if a domain is provided.

### 4.2 Android app (`android/`, Kotlin, Jetpack Compose)

- **`TunnelService`** — foreground service (persistent notification) holding the OkHttp
  `WebSocket` open. START_STICKY; partial wakelock; battery-optimization-exemption
  prompt; optional restart-on-boot.
- **`WsClient`** — OkHttp WebSocket with a custom `SSLSocketFactory`/pinning
  (`CertificatePinner` or TOFU fingerprint). Sends AUTH; handles frames.
- **`Dialer`** — per `OPEN`, opens a `java.net.Socket` to `host:port` on an IO
  dispatcher; pipes socket ⇄ WebSocket via `DATA`/`CLOSE` frames.
- **`Mux`** — `streamId → socket` map; mirrors the relay's framing.
- **`Reconnector`** — exponential backoff (1→2→4…→30s) + jitter on WS failure;
  `ConnectivityManager.NetworkCallback` forces an immediate reconnect on network change.
- **`Store`** — `EncryptedSharedPreferences`: relay host/ports, pairing token, username,
  password, pinned cert fingerprint.
- **UI (Compose), 2 screens:**
  - **Setup** — relay host/IP, ports, pairing token, username, password → Save & Connect.
  - **Status** — connection state, current egress IP (self-test), bytes in/out, active
    streams, last error, Start/Stop.
- **Permissions:** INTERNET, ACCESS_NETWORK_STATE, FOREGROUND_SERVICE,
  FOREGROUND_SERVICE_DATA_SYNC, POST_NOTIFICATIONS, WAKE_LOCK,
  REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, RECEIVE_BOOT_COMPLETED (optional).
- **Build:** Gradle → debug APK for sideloading. minSdk 26, target latest stable.

## 5. End-to-end Data Flow (HTTPS / CONNECT)

1. Cloud code calls `https://api.example.com` with `HTTPS_PROXY=http://USER:PASS@<ip>:8080`.
2. Relay reads `CONNECT api.example.com:443`, validates `USER:PASS` (bcrypt), finds the
   live phone.
3. Relay allocates `streamId`, sends `OPEN(streamId, "api.example.com", 443)` over the WSS.
4. Phone opens a raw TCP socket to `api.example.com:443` **over its home internet**, replies
   `OPEN_OK`.
5. Relay sends `200 Connection Established` to the client. Bytes now pipe both ways as
   `DATA(streamId, …)` frames, multiplexed with other streams.
6. The API sees the **phone's IP**. (Plain HTTP is the same minus the CONNECT step.)

## 6. Tunnel Protocol (relay ⇄ phone, binary frames over one WSS)

Frame layout: `[1B type][4B streamId BE][payload]` (streamId 0 = control).

| Type | Name | Dir | Payload |
|------|------|-----|---------|
| 0x01 | AUTH | phone→relay | JSON `{pairingToken, deviceId, proxyUsername, proxyPassword}` |
| 0x02 | AUTH_OK | relay→phone | — |
| 0x03 | AUTH_FAIL | relay→phone | JSON `{reason}` |
| 0x10 | OPEN | relay→phone | JSON `{host, port}` |
| 0x11 | OPEN_OK | phone→relay | — |
| 0x12 | OPEN_FAIL | phone→relay | JSON `{reason}` |
| 0x20 | DATA | both | raw bytes for streamId |
| 0x21 | CLOSE | both | — (tear down stream both ways) |
| 0x30 | PING | both | — (app-level heartbeat, ~25s) |
| 0x31 | PONG | both | — |

- **Pairing/auth:** relay is deployed with a `PAIRING_TOKEN`. App's first AUTH includes it
  + desired username/password (sent over the TLS tunnel, then bcrypt-stored). Changing
  creds = re-AUTH. Registry keyed by `deviceId` → multi-device is an additive extension
  (proxy can later select device by username).
- **Flow control (v1):** rely on WebSocket/TCP backpressure (pause reads when the peer is
  slow). Explicit per-stream windows are a documented future refinement.

## 7. Reliability (the always-on part)

- Foreground service + persistent notification so the OS keeps it alive; START_STICKY.
- Partial wakelock while running; prompt to exempt from battery optimization (Doze).
- App-level PING/PONG (~25s) to detect dead links fast; OkHttp ping interval as backup.
- `ConnectivityManager.NetworkCallback` → immediate reconnect on WiFi↔SIM switch.
- Exponential backoff + jitter on reconnect; resume by re-AUTH (existing streams are
  dropped and re-established by clients — acceptable for v1).
- Recommendation in docs: keep the phone plugged in.

## 8. Security & Abuse Prevention

- **Strong credentials:** app suggests a strong random password; bcrypt-stored on relay.
- **IP allowlist:** `ALLOWED_CLIENT_CIDRS` on the relay **and**/or the Alibaba Security
  Group restricts the proxy port to the user's GCP/Netlify/Vercel egress ranges.
- **Credential confidentiality:** on a plain `http://` proxy the Basic auth is base64 on
  the client→relay hop. Mitigations: (a) support `HTTPS_PROXY=https://…` (TLS to the
  proxy listener) for clients that allow it; (b) recommend the IP allowlist regardless.
- **Tunnel:** wss with pinned self-signed cert (TOFU) or Let's Encrypt if a domain exists.
- **Rate limiting / connection caps** on the relay to blunt scanning/abuse.
- **Threat model note:** this is the user's own infra for the user's own APIs; controls
  above exist so no third party can ride the connection if the endpoint is discovered.

## 9. Deployment (Alibaba Cloud ECS)

1. **Public IP** — confirm the ECS instance has one (assigned public IP or attached EIP).
2. **Security Group** — add inbound rules for `8080` (proxy) and `8443` (tunnel); scope
   the proxy rule to the user's cloud egress CIDRs where possible. Region: prefer a
   **non-mainland-China** region to avoid GFW cross-border throttling.
3. **Docker** — install once; `docker compose up -d` runs the relay. `PAIRING_TOKEN` and
   ports set via env/`.env`. Persist the credential store on a named volume.
4. **TLS** — default self-signed cert generated on boot (fingerprint printed → pin in app).
   Optional: point a subdomain at the IP → Caddy auto-Let's-Encrypt.

## 10. Cloud Client Usage

```bash
export HTTPS_PROXY=http://USER:PASS@<relay-ip>:8080
export HTTP_PROXY=http://USER:PASS@<relay-ip>:8080
# Smoke test (should print the phone's home IP):
curl -x http://USER:PASS@<relay-ip>:8080 https://api.ipify.org
```
Set the same env vars in GCP Cloud Run/Functions, Netlify, or Vercel — no code change.

## 11. Repository Structure

```
tetherproxy/
  docs/superpowers/specs/2026-06-02-tetherproxy-design.md
  relay/
    src/{index,config,proxyServer,tunnelServer,mux,auth,store,frames}.ts
    test/...
    Dockerfile  docker-compose.yml  package.json  tsconfig.json  README.md
  android/
    app/src/main/java/.../{TunnelService,WsClient,Dialer,Mux,Reconnector,Store,ui/*}.kt
    app/src/test/...  build.gradle.kts  settings.gradle.kts  README.md
  README.md           # what it is, quickstart, cloud usage
```

## 12. Testing Strategy

- **Relay unit:** proxy request/headers parsing; Basic-auth (incl. 407 paths); frame
  encode/decode; mux stream lifecycle; bcrypt verify.
- **Relay integration:** real relay + a fake "phone" WS client dialing a local HTTP/HTTPS
  test server; run a proxied request end-to-end; assert response and that egress went via
  the fake phone.
- **Android unit (JVM):** frame codec; reconnect/backoff logic; mux map.
- **Manual e2e:** `curl -x http://USER:PASS@<ip>:8080 https://api.ipify.org` returns the
  phone's IP; same from a GCP/Netlify function with env vars set.

## 13. Milestones

1. Relay core: frames + mux + tunnel + proxy `CONNECT` + auth (+ tests).
2. Relay packaging: Docker, compose, config, TLS, README (Alibaba deploy).
3. Android core: service + WS client + dialer + mux + reconnect.
4. Android UI: setup + status screens; encrypted storage; battery/permission flows.
5. End-to-end pairing + smoke test; docs; build APK.

## 14. Non-Goals (v1) / Future

- Multiple phones / IP rotation (registry is keyed by device to allow it later).
- Per-stream flow-control windows (rely on backpressure in v1).
- Play Store distribution (sideload APK in v1).
- UDP / SOCKS5 (HTTP/HTTPS proxy only in v1).
- Auto-resume of in-flight streams across reconnects (clients re-establish in v1).

## 15. Open Setup Questions (confirm during deploy)

- Does the Alibaba ECS have a public IP / EIP? (Assumed yes.)
- Domain available for Let's Encrypt, or use pinned self-signed? (Default: self-signed.)
- Which cloud egress CIDRs to allowlist on the proxy port? (Optional hardening.)
