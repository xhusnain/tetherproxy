# TetherProxy — Turn Your Android Phone Into a Self-Hosted Residential Proxy

> **Run your own residential proxy on a phone you already own.** TetherProxy turns any
> Android device into a private HTTP/HTTPS proxy egress point, so your cloud code (GCP,
> Vercel, Netlify, AWS, etc.) makes requests from your **home internet IP** instead of a
> flagged datacenter IP — with **zero code changes**, just one `HTTPS_PROXY` environment
> variable.

<p align="center">
  <a href="#-quick-start"><b>Quick Start</b></a> •
  <a href="#-how-it-works">How It Works</a> •
  <a href="#-install-the-relay-server">Install Relay</a> •
  <a href="#-install-the-android-app">Install App</a> •
  <a href="#-faq">FAQ</a>
</p>

<p align="center">
  <img alt="Node.js" src="https://img.shields.io/badge/relay-Node.js%20%2B%20TypeScript-3178c6">
  <img alt="Android" src="https://img.shields.io/badge/app-Android%208.0%2B%20(Kotlin)-3ddc84">
  <img alt="Docker" src="https://img.shields.io/badge/deploy-Docker%20Compose-2496ed">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="Tests" src="https://img.shields.io/badge/tests-73%20passing-success">
</p>

---

## What is TetherProxy?

**TetherProxy is a free, open-source, self-hosted residential proxy** built from two
parts you control end to end:

1. A lightweight **Node.js relay server** with a public IP (runs in Docker on any cheap
   cloud VM — Alibaba Cloud ECS, AWS EC2, DigitalOcean, Hetzner, etc.).
2. An **Android app** that turns your phone into the actual internet exit node over your
   home WiFi or mobile data.

The target API sees **your phone's residential IP**, not the cloud provider's datacenter
IP. This is the same outcome people pay expensive **rotating residential proxy** services
for — except here it's *your own phone, your own home internet, your own APIs*. No
monthly per-GB bills, no shared/abused IP pools, full control.

### Why people use a phone as a proxy

- **Avoid datacenter-IP blocks** — many APIs and sites silently rate-limit or block known
  cloud IP ranges (GCP, AWS, Azure). A residential mobile IP is treated as a real user.
- **Geo-accurate requests** — egress from your actual home/region instead of a random
  cloud region.
- **Zero-code integration** — works with `curl`, Python `requests`, Node `fetch`, Puppeteer,
  Playwright, scrapers, and any runtime that honors `HTTP_PROXY` / `HTTPS_PROXY`.
- **Cheap** — one ~$5/month VM + a spare Android phone replaces a paid residential proxy
  subscription.

> ⚖️ **Use it legitimately.** TetherProxy is designed for accessing **your own APIs and
> services from your own IP**. Respect target sites' Terms of Service and the law in your
> jurisdiction. Don't use it for abuse, fraud, or evading legitimate security controls.

---

## ✨ Features

| | |
|---|---|
| 🏠 **Residential / mobile IP egress** | Traffic exits from your phone's real ISP/carrier IP. |
| 🔌 **Zero code changes** | Standard `HTTPS_PROXY` / `HTTP_PROXY` env vars — nothing else. |
| 🔐 **Authenticated proxy** | Per-client username + password (bcrypt-hashed on the relay). |
| 🔒 **Encrypted tunnel** | Phone ⇄ relay over **WSS** with a pinned TLS certificate (TOFU). |
| 🔁 **Always-on & self-healing** | Foreground service, auto-reconnect on WiFi ↔ mobile switch, restart-on-boot. |
| 🧱 **NAT-proof** | Phone only dials **out** — works behind carrier-grade NAT, no port forwarding. |
| 🚦 **Abuse protection** | Per-IP rate limits, connection caps, and optional CIDR allowlist. |
| 🐳 **One-command deploy** | `docker compose up -d` — SQLite store + TLS cert persist on volumes. |
| 🧪 **Battle-tested** | 73 automated tests across the relay and Android tunnel codec. |

---

## 🧠 How It Works

A phone can't accept inbound connections (it's behind carrier/router NAT and its IP
changes constantly). So the phone **dials out** and holds a persistent encrypted tunnel
open to an always-on **relay** that *does* have a public IP. Cloud clients connect to the
relay; the relay multiplexes each request over the tunnel to the phone, which opens the
real socket to the target.

```
  Your cloud code  (GCP / Vercel / Netlify / scraper / curl)
        │   HTTPS_PROXY = http://USER:PASS@<relay-ip>:8080
        ▼
 ┌──────────────────────────────────────────────┐
 │  RELAY  (Node.js + Docker, public IP)          │
 │  • :8080  authenticated HTTP/HTTPS proxy        │
 │  • :8443  persistent WSS tunnel to the phone    │
 │  • stream multiplexer over one WebSocket        │
 └──────────────────────────────────────────────┘
        ▲  persistent wss://  (phone dialed OUT → NAT is a non-issue)
        ▼
 ┌──────────────────────────────────────────────┐
 │  ANDROID APP  (Kotlin foreground service)      │
 │  • holds the tunnel open 24/7, auto-reconnect   │
 │  • opens a raw TCP socket per request           │
 └──────────────────────────────────────────────┘
        │   outbound over SIM or home WiFi
        ▼
   Target API  →  sees your PHONE's residential IP
```

**Result:** from the cloud side it's literally **one environment variable**, and the
target sees your phone's home IP. [Full design spec →](docs/superpowers/specs/2026-06-02-tetherproxy-design.md)

---

## 🚀 Quick Start

Three steps: deploy the relay → install the app → point your client at the proxy.

```bash
# 1. On a cloud VM with a public IP (Docker installed):
git clone https://github.com/xhusnain/tetherproxy.git
cd tetherproxy/relay
cp .env.example .env
sed -i "s|^PAIRING_TOKEN=.*|PAIRING_TOKEN=$(head -c 32 /dev/urandom | base64)|" .env
docker compose up -d --build

# 2. Build & install the Android app (see below), then pair it with the relay.

# 3. From any cloud runtime or your laptop — should print your PHONE's IP:
curl -x http://USER:PASS@<relay-ip>:8080 https://api.ipify.org
```

---

## 📦 Install the Relay Server

The relay is a Node.js + TypeScript service shipped as a Docker image. It runs on any
small Linux VM with a public IP. The example below uses **Alibaba Cloud ECS**, but **AWS
EC2, DigitalOcean, Hetzner, Linode, or any VPS** work identically.

> 💡 **Region tip:** prefer a **non-mainland-China** region (e.g. Singapore, Hong Kong)
> to avoid Great-Firewall cross-border throttling of the tunnel.

### Prerequisites

- A Linux VM with an **assigned public IP** (or attached Elastic IP).
- **Docker + Docker Compose** on the VM.

### 1. Open the firewall / Security Group

Add **inbound** rules:

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| `8443` | TCP | `0.0.0.0/0` | WSS tunnel — the phone dials in from changing IPs |
| `8080` | TCP | your cloud egress CIDRs (preferred) or `0.0.0.0/0` | proxy listener |
| `8081` | TCP | *(optional)* same as `8080` | optional TLS proxy listener |

Keep `8443` open to `0.0.0.0/0` (the phone's IP changes between SIM and WiFi). Scope
`8080` to your cloud provider's published egress ranges where possible.

### 2. Install Docker (once)

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin git
sudo systemctl enable --now docker
```

### 3. Clone, configure, and run

```bash
git clone https://github.com/xhusnain/tetherproxy.git
cd tetherproxy/relay

cp .env.example .env
# Set a long random pairing token (the shared secret the phone presents):
sed -i "s|^PAIRING_TOKEN=.*|PAIRING_TOKEN=$(head -c 32 /dev/urandom | base64)|" .env

docker compose up -d --build
```

The SQLite store (`/data`) and the generated TLS cert (`/certs`) persist on named Docker
volumes, so credentials and the cert survive restarts.

### 4. Read the TLS fingerprint (for the phone to pin)

On first boot the relay generates a self-signed cert and prints its SHA-256 fingerprint:

```bash
docker compose logs relay | grep -A1 "SHA-256 fingerprint"
# [relay] TLS SHA-256 fingerprint (pin in phone):
# [relay]   AB:CD:EF:...:99
```

You'll enter this fingerprint (and the `PAIRING_TOKEN`) in the Android app.

### Relay operations

```bash
docker compose logs -f relay                       # follow logs
docker compose restart relay                       # restart
docker compose down                                # stop (volumes persist)
git pull && docker compose up -d --build           # update to latest
```

📖 **Full relay docs, env vars, and security hardening:** [`relay/README.md`](relay/README.md)

---

## 📱 Install the Android App

The app is a native Kotlin (Jetpack Compose) build. It runs an always-on foreground
service that holds the tunnel open and opens a TCP socket per forwarded request.

### Requirements

- **JDK 17** (`JAVA_HOME` pointing at a JDK 17 install)
- **Android SDK** with `cmdline-tools` (latest), platform `android-34`, build-tools `34.0.0`
- A phone (or emulator) on **Android 8.0+** (minSdk 26)

### 1. Build the APK

```bash
cd android
# Point Gradle at your SDK (create android/local.properties if absent):
echo "sdk.dir=/path/to/your/Android/Sdk" > local.properties

./gradlew assembleDebug
```

The debug APK is produced at:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

### 2. Install it on the phone

Enable **Developer Options** → **USB debugging**, plug the phone in, then:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

*(No computer? Copy the APK to the phone and tap it to sideload — allow "install from
unknown sources" when prompted.)*

### 3. Pair with the relay (first run)

Open the app → the **Setup** screen appears. Fill in:

| Field | Value |
|-------|-------|
| **Relay host / IP** | your relay VM's public IP |
| **Tunnel port (WSS)** | `8443` |
| **Proxy port** | `8080` |
| **Pairing token** | the `PAIRING_TOKEN` from the relay's `.env` |
| **Proxy username / password** | pick your own — tap **Generate** for a strong password |
| **Pinned cert SHA-256** | leave **blank** for trust-on-first-use, or paste the relay's fingerprint |
| **Auto-start on boot** | toggle on to restart the tunnel after a reboot |

Tap **Save & Connect**, grant the notification permission, and accept the
battery-optimization exemption (so Android keeps the service alive in Doze). The
**Status** screen shows `CONNECTED` once the relay accepts the pairing.

### 4. Verify the egress IP

On the **Status** screen tap **Run egress IP self-test** — it shows your phone's public
IP. That's the IP your cloud clients will egress from.

📖 **Full app docs, pinning, and reliability notes:** [`android/README.md`](android/README.md)

---

## ☁️ Using the Proxy From Your Cloud Code

Point any runtime at the proxy with standard environment variables — **no code change**:

```bash
export HTTPS_PROXY=http://USER:PASS@<relay-ip>:8080
export HTTP_PROXY=http://USER:PASS@<relay-ip>:8080
```

Set the same variables in **GCP Cloud Run/Functions, AWS Lambda, Vercel, Netlify**, or
any container/CI job. Works out of the box with `curl`, Python `requests`/`httpx`, Node
`fetch`/`axios`, Go, Puppeteer, Playwright, and more.

**Smoke test** — this should print your **phone's** home IP, not the cloud/relay IP:

```bash
curl -x http://USER:PASS@<relay-ip>:8080 https://api.ipify.org
```

---

## 🔐 Security

- **Authenticated proxy** — per-client username/password, **bcrypt-hashed** in the store.
- **Pairing token** gates who is allowed to pair a phone with the relay.
- **Encrypted tunnel** — WSS with a pinned self-signed cert (TOFU); optionally bring a
  domain + Let's Encrypt for CA-trusted certs.
- **Rate limiting & caps** — global + per-IP connection caps and a per-IP new-connection
  rate limit blunt scanning and abuse; rejected clients get `429`.
- **IP allowlist** — restrict the proxy port to your cloud egress CIDRs via the Security
  Group and/or `ALLOWED_CLIENT_CIDRS`.
- **On-device secrets** — the app stores all credentials in `EncryptedSharedPreferences`
  (AES-256-GCM).

---

## ❓ FAQ

<details>
<summary><b>What is a residential proxy and why use a phone for it?</b></summary>

A residential proxy routes your traffic through a real consumer ISP/mobile IP instead of
a datacenter IP. Many sites and APIs treat residential/mobile IPs as trusted real users
while throttling or blocking known cloud ranges. Using a phone you own gives you a
genuine residential/mobile IP without renting one from a third-party pool.
</details>

<details>
<summary><b>Is TetherProxy free?</b></summary>

Yes — the software is free and open-source (MIT). Your only costs are a cheap cloud VM
for the relay (~$5/month) and a spare Android phone with an internet plan.
</details>

<details>
<summary><b>Do I need to change my application code?</b></summary>

No. TetherProxy speaks the standard HTTP proxy protocol (`CONNECT` for HTTPS). You set
`HTTPS_PROXY` / `HTTP_PROXY` environment variables and everything else is unchanged.
</details>

<details>
<summary><b>Will it work behind carrier-grade NAT (CGNAT) or a home router?</b></summary>

Yes. The phone never accepts inbound connections — it dials **out** to the relay and
holds the tunnel open. NAT, CGNAT, and changing IPs are non-issues by design.
</details>

<details>
<summary><b>Does it survive WiFi ↔ mobile-data switches and reboots?</b></summary>

Yes. The app runs a foreground service with auto-reconnect (exponential backoff + jitter),
reconnects immediately on a network change, and can auto-start on boot.
</details>

<details>
<summary><b>Can I use a VM other than Alibaba Cloud?</b></summary>

Absolutely. Any Linux VM with a public IP and Docker works — AWS EC2, DigitalOcean,
Hetzner, Linode, Oracle Cloud, etc. The Alibaba steps are just one example.
</details>

<details>
<summary><b>Does it support SOCKS5 or UDP?</b></summary>

v1 supports HTTP/HTTPS proxying (`CONNECT` + plain HTTP) only. SOCKS5/UDP are possible
future additions.
</details>

---

## 🗂️ Repository Structure

```
tetherproxy/
├── relay/      Node.js + TypeScript proxy + WSS tunnel server (Docker)
├── android/    Kotlin / Jetpack Compose always-on tunnel app
├── docs/       Design spec + implementation plans
└── README.md   You are here
```

---

## 🤝 Contributing

Issues and pull requests are welcome. Run the relay test suite with `cd relay && npm test`
and the Android unit tests with `cd android && ./gradlew testDebugUnitTest` before
submitting.

## 📄 License

MIT — see [`LICENSE`](LICENSE).

---

<p align="center">
<i>Keywords: residential proxy, mobile proxy, self-hosted proxy, phone as proxy, Android
proxy server, HTTP/HTTPS proxy, CONNECT proxy, rotating residential proxy alternative,
home IP proxy, bring-your-own-IP, Node.js proxy, Docker proxy, bypass datacenter IP
blocks.</i>
</p>
