import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { Store } from "./store.js";
import { loadConfig, type Config } from "./config.js";
import { ensureCert } from "./tls.js";
import { TunnelServer } from "./tunnelServer.js";
import { ProxyServer, handleProxyConnection } from "./proxyServer.js";
import { ConnectionLimiter } from "./rateLimiter.js";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

export interface RelayInfo {
  proxyPort: number;
  proxyTlsPort?: number;
  tunnelPort: number;
  fingerprint: string;
}

export interface Relay {
  start(): Promise<RelayInfo>;
  stop(): Promise<void>;
}

/** Build (but do not start) the relay from a Config. */
export function createRelay(config: Config): Relay {
  const store = new Store(`${config.dataDir}/relay.db`);
  const tls = ensureCert(config.tlsCertPath, config.tlsKeyPath);

  // HTTPS server backing the WSS tunnel.
  const httpsServer: HttpsServer = createHttpsServer({
    cert: tls.cert,
    key: tls.key,
  });
  const tunnelServer = new TunnelServer({
    server: httpsServer,
    store,
    pairingToken: config.pairingToken,
    heartbeatMs: 25000,
  });

  // One shared connection limiter for both the plain and TLS proxy listeners.
  const limiter = new ConnectionLimiter(config.rateLimit);

  const proxyServer = new ProxyServer({
    getLiveTunnel: () => tunnelServer.getLiveTunnel(),
    store,
    allowedClientCidrs: config.allowedClientCidrs,
    limiter,
  });

  // Optional TLS proxy listener (HTTPS_PROXY=https://...). Reuses the relay's
  // self-signed cert and the exact same per-connection handler + deps as the
  // plain listener, so credentials are encrypted on the client->relay hop.
  let proxyTlsServer: TlsServer | null = null;
  if (config.proxyTlsPort !== undefined) {
    proxyTlsServer = createTlsServer(
      { cert: tls.cert, key: tls.key },
      (socket) => handleProxyConnection(socket, proxyServer.deps),
    );
  }

  let started = false;

  return {
    async start(): Promise<RelayInfo> {
      started = true;
      const proxyPort = await proxyServer.listen(config.proxyPort);
      httpsServer.listen(config.tunnelPort);
      await once(httpsServer, "listening");
      const tunnelPort = (httpsServer.address() as AddressInfo).port;

      let proxyTlsPort: number | undefined;
      if (proxyTlsServer) {
        proxyTlsServer.listen(config.proxyTlsPort);
        await once(proxyTlsServer, "listening");
        proxyTlsPort = (proxyTlsServer.address() as AddressInfo).port;
      }

      console.log(`[relay] proxy listening on :${proxyPort}`);
      if (proxyTlsPort !== undefined) {
        console.log(`[relay] TLS proxy listening on :${proxyTlsPort}`);
      }
      console.log(`[relay] tunnel (wss) listening on :${tunnelPort}`);
      console.log(`[relay] TLS SHA-256 fingerprint (pin in phone):`);
      console.log(`[relay]   ${tls.fingerprint}`);

      return {
        proxyPort,
        proxyTlsPort,
        tunnelPort,
        fingerprint: tls.fingerprint,
      };
    },
    async stop(): Promise<void> {
      if (!started) {
        store.close();
        return;
      }
      proxyServer.close();
      if (proxyTlsServer) {
        proxyTlsServer.close();
        if (proxyTlsServer.listening) {
          await once(proxyTlsServer, "close").catch(() => {});
        }
      }
      tunnelServer.close();
      httpsServer.close();
      if (httpsServer.listening) await once(httpsServer, "close").catch(() => {});
      store.close();
    },
  };
}

/** Entrypoint: boot from process.env, wire signal handlers, never resolve. */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const relay = createRelay(config);
  await relay.start();

  const shutdown = async (sig: string) => {
    console.log(`[relay] received ${sig}, shutting down`);
    await relay.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Boot as the entrypoint. Skipped only under the vitest test runner (which sets
// VITEST and imports createRelay directly). A plain argv[1] check is unreliable
// here because process managers like PM2 wrap the ESM entry in their own loader,
// which would leave the relay "online" but never started.
if (process.env.VITEST === undefined) {
  main().catch((err) => {
    console.error("[relay] fatal:", err);
    process.exit(1);
  });
}
