# TetherProxy Relay

The relay is an always-on Node.js service with a public IP. It is both:

- an authenticated **HTTP/HTTPS proxy** front end (port `8080`, optional TLS `8081`), and
- a **WSS tunnel endpoint** (port `8443`) that the phone dials out to and holds open.

Each proxy connection is multiplexed as a stream over the single tunnel to the phone,
which opens the real socket to the target host over your home internet. The target sees
the **phone's IP**.

## Architecture

```
cloud client --HTTPS_PROXY--> relay :8080  ==WSS tunnel :8443==>  phone  --> target API
```

## Prerequisites

- An Alibaba Cloud ECS instance (any small Linux VM) with a **public IP or EIP**.
- Docker + Docker Compose on the instance.

## 1. Confirm the public IP / EIP

In the Alibaba Cloud console, open the ECS instance and confirm it has an **assigned public
IP** or an **attached Elastic IP (EIP)**. Note this address as `RELAY_IP`.

```bash
# From the instance, confirm outbound + see the egress IP:
curl -s https://api.ipify.org && echo
```

> Region tip: prefer a **non-mainland-China** region (e.g. Singapore, Hong Kong) to avoid
> Great-Firewall cross-border throttling of the tunnel and proxy traffic.

## 2. Open the Security Group inbound ports

In the ECS Security Group, add **inbound** rules:

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| 8443 | TCP | `0.0.0.0/0` | WSS tunnel (the phone dials in from changing IPs) |
| 8080 | TCP | your cloud egress CIDRs (preferred) or `0.0.0.0/0` | proxy |

Scope `8080` to your cloud provider's egress CIDRs where possible (GCP/Netlify/Vercel
published ranges) so only your cloud functions can use the proxy. `8443` must stay open to
`0.0.0.0/0` because the phone's IP changes constantly (SIM <-> WiFi).

If you enable the optional TLS proxy listener, also open `8081` the same way as `8080`.

## 3. Install Docker (once)

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
# Optional: run docker without sudo
sudo usermod -aG docker "$USER" && newgrp docker
```

## 4. Configure and run

```bash
# From the relay/ directory on the instance:
cp .env.example .env
# Edit .env and set a long random PAIRING_TOKEN:
#   PAIRING_TOKEN=$(head -c 32 /dev/urandom | base64)
docker compose up -d
```

The store (`/data`) and the generated TLS cert (`/certs`) persist on named Docker volumes,
so credentials and the cert survive restarts.

> **Low-RAM VM? Run without Docker (PM2).** On a tiny instance (e.g. 1 GB) the Docker
> daemon's ~300 MB overhead is wasteful for a single Node process. The relay has **no
> native dependencies**, so you can run it directly — see
> [Run without Docker (PM2)](#run-without-docker-pm2) below.

## 5. Read the printed TLS fingerprint (for phone pinning)

On first boot the relay generates a self-signed cert and prints its SHA-256 fingerprint:

```bash
docker compose logs relay | grep -A1 "SHA-256 fingerprint"
# [relay] TLS SHA-256 fingerprint (pin in phone):
# [relay]   AB:CD:EF:...:99
```

Enter this exact fingerprint in the Android app's setup screen so the phone pins the
tunnel's certificate (trust-on-first-use). It also pins against credential theft if the
relay IP is ever discovered.

## 6. Pair the phone

In the Android app's setup screen enter:

- **Relay host/IP**: `RELAY_IP`
- **Tunnel port**: `8443`
- **Pairing token**: the `PAIRING_TOKEN` from `.env`
- **Proxy username / password**: pick your own (these are what cloud clients use)
- **Cert fingerprint**: the SHA-256 from step 5

Tap **Save & Connect**. The relay logs should show the device authenticated and live.

## 7. Client usage (cloud side)

Point any cloud runtime at the proxy with standard env vars — **no code change**:

```bash
export HTTPS_PROXY=http://USER:PASS@RELAY_IP:8080
export HTTP_PROXY=http://USER:PASS@RELAY_IP:8080
```

Set the same variables in GCP Cloud Run/Functions, Netlify, or Vercel.

### Smoke test

```bash
# Should print your PHONE's home IP, not the cloud/relay IP:
curl -x http://USER:PASS@RELAY_IP:8080 https://api.ipify.org && echo
```

If you enabled the TLS proxy listener (`PROXY_TLS_PORT=8081`), clients that support an
HTTPS proxy can instead use `HTTPS_PROXY=https://USER:PASS@RELAY_IP:8081` so the Basic
credentials are encrypted on the client->relay hop.

## Operations

```bash
docker compose logs -f relay     # follow logs
docker compose restart relay     # restart
docker compose down              # stop (volumes persist)
docker compose pull && docker compose up -d --build   # update
```

## Run without Docker (PM2)

Best for small VMs (the relay has **no native dependencies**, so this needs no compiler
and very little RAM). Requires **Node.js 20.6+** (for the built-in `--env-file` flag).

```bash
# Install Node 20+ and PM2 (once)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2

# From the relay/ directory:
cp .env.example .env
# Set a long random pairing token:
sed -i "s|^PAIRING_TOKEN=.*|PAIRING_TOKEN=$(head -c 32 /dev/urandom | base64)|" .env

npm ci            # no build toolchain needed — pure JS deps only
npm run build     # compiles TypeScript -> dist/ (fast, low memory)

pm2 start ecosystem.config.cjs   # starts the relay, reads .env, stores data next to the app
pm2 save                         # remember it across reboots
pm2 startup                      # print the command to enable the boot service (run it)
```

The store (`data/`) and TLS cert (`certs/`) are written next to the app, so credentials
and the pinned cert survive restarts.

```bash
pm2 logs tetherproxy-relay                              # follow logs
pm2 logs tetherproxy-relay | grep -A1 "SHA-256"         # read the cert fingerprint
pm2 restart tetherproxy-relay                           # restart
pm2 stop tetherproxy-relay                              # stop
git pull && npm ci && npm run build && pm2 restart tetherproxy-relay   # update
```

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `PAIRING_TOKEN` | (required) | Shared secret the phone presents in AUTH |
| `PROXY_PORT` | `8080` | Proxy listener |
| `PROXY_TLS_PORT` | (off) | Optional TLS proxy listener |
| `TUNNEL_PORT` | `8443` | WSS tunnel listener |
| `ALLOWED_CLIENT_CIDRS` | (none) | Optional IPv4 CIDR allowlist on the proxy port |
| `DATA_DIR` | `/data` | SQLite store directory (volume) |
| `CERT_DIR` | `/certs` | TLS cert/key directory (volume) |
| `RATE_LIMIT_MAX_TOTAL` | `512` | Max total active proxy connections |
| `RATE_LIMIT_MAX_PER_IP` | `64` | Max active proxy connections per client IP |
| `RATE_LIMIT_MAX_NEW_PER_MIN` | `120` | Max new connections per client IP per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit fixed-window length (ms) |

## Security notes

- Credentials are bcrypt-hashed in the store; the pairing token gates who may pair.
- Prefer the Security-Group CIDR allowlist on `8080`, and/or set `ALLOWED_CLIENT_CIDRS`.
- The relay enforces global + per-IP connection caps and a per-IP new-connection rate
  limit (`RATE_LIMIT_*`) to blunt scanning/abuse; rejected connections get `429`.
- The tunnel uses WSS with a pinned self-signed cert (TOFU). Provide a domain + Let's
  Encrypt later if you want CA-trusted certs.
