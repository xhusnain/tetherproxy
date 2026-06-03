import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  createServer as createHttp,
  request as httpRequest,
  type Server as HttpServer,
} from "node:http";
import {
  createServer as createHttps,
  type Server as HttpsServer,
} from "node:https";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect, type Socket, type AddressInfo } from "node:net";
import WebSocket from "ws";
import selfsigned from "selfsigned";
import { createRelay, type Relay } from "../src/index.js";
import { loadConfig } from "../src/config.js";
import {
  FrameType,
  decodeFrame,
  encodeFrame,
  encodeJsonFrame,
  decodeJsonPayload,
  type Frame,
} from "../src/frames.js";

let relay: Relay | null = null;
let dir: string | null = null;
let originHttp: HttpServer | null = null;
let originHttps: HttpsServer | null = null;
let phone: WebSocket | null = null;
const phoneSockets = new Map<number, Socket>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tp-int-"));
});

afterEach(async () => {
  phone?.terminate();
  phone = null;
  for (const s of phoneSockets.values()) s.destroy();
  phoneSockets.clear();
  await relay?.stop();
  relay = null;
  originHttp?.close();
  originHttps?.close();
  originHttp = null;
  originHttps = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/**
 * Connect a fake phone: authenticate, then for each OPEN dial the requested
 * host:port with a real TCP/TLS-passthrough socket and pipe bytes back as DATA.
 * `egress` records every host:port the phone dialed (proves egress path).
 */
async function connectPhone(
  tunnelPort: number,
  egress: string[],
): Promise<void> {
  phone = new WebSocket(`wss://127.0.0.1:${tunnelPort}`, {
    rejectUnauthorized: false,
  });
  await once(phone, "open");
  phone.send(
    encodeJsonFrame(FrameType.AUTH, 0, {
      pairingToken: "tok",
      deviceId: "phone-int",
      proxyUsername: "alice",
      proxyPassword: "pw",
    }),
  );
  await new Promise<void>((resolve) => {
    phone!.once("message", (data) => {
      const f = decodeFrame(data as Buffer);
      expect(f.type).toBe(FrameType.AUTH_OK);
      resolve();
    });
  });

  phone.on("message", (data) => {
    const f: Frame = decodeFrame(data as Buffer);
    switch (f.type) {
      case FrameType.OPEN: {
        const { host, port } = decodeJsonPayload<{ host: string; port: number }>(
          f.payload,
        );
        egress.push(`${host}:${port}`);
        const sock = netConnect(port, host);
        phoneSockets.set(f.streamId, sock);
        sock.on("connect", () => {
          phone!.send(encodeFrame(FrameType.OPEN_OK, f.streamId));
        });
        sock.on("data", (chunk: Buffer) => {
          phone!.send(encodeFrame(FrameType.DATA, f.streamId, chunk));
        });
        sock.on("error", () => {
          phone!.send(
            encodeJsonFrame(FrameType.OPEN_FAIL, f.streamId, {
              reason: "dial failed",
            }),
          );
        });
        sock.on("close", () => {
          phone!.send(encodeFrame(FrameType.CLOSE, f.streamId));
          phoneSockets.delete(f.streamId);
        });
        break;
      }
      case FrameType.DATA: {
        const sock = phoneSockets.get(f.streamId);
        if (sock && !sock.destroyed) sock.write(f.payload);
        break;
      }
      case FrameType.CLOSE: {
        const sock = phoneSockets.get(f.streamId);
        if (sock) sock.destroy();
        phoneSockets.delete(f.streamId);
        break;
      }
      case FrameType.PING:
        phone!.send(encodeFrame(FrameType.PONG, 0));
        break;
      default:
        break;
    }
  });
}

async function startRelay(): Promise<{
  proxyPort: number;
  proxyTlsPort: number;
  tunnelPort: number;
}> {
  const cfg = loadConfig({
    PAIRING_TOKEN: "tok",
    PROXY_PORT: "0",
    PROXY_TLS_PORT: "0",
    TUNNEL_PORT: "0",
    DATA_DIR: join(dir!, "data"),
    CERT_DIR: join(dir!, "certs"),
  });
  relay = createRelay(cfg);
  const info = await relay.start();
  return {
    proxyPort: info.proxyPort,
    proxyTlsPort: info.proxyTlsPort!,
    tunnelPort: info.tunnelPort,
  };
}

describe("relay end-to-end through a fake phone", () => {
  it("proxies a plain HTTP GET (absolute-URI) and egresses via the phone", async () => {
    // Local origin HTTP server the phone will dial.
    originHttp = createHttp((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ORIGIN-HTTP-OK");
    });
    originHttp.listen(0, "127.0.0.1");
    await once(originHttp, "listening");
    const originPort = (originHttp.address() as AddressInfo).port;

    const { proxyPort, tunnelPort } = await startRelay();
    const egress: string[] = [];
    await connectPhone(tunnelPort, egress);

    // Issue a proxied plain-HTTP request via Node's http with absolute path.
    const body: string = await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: proxyPort,
          method: "GET",
          path: `http://127.0.0.1:${originPort}/hello`,
          headers: {
            Host: `127.0.0.1:${originPort}`,
            "Proxy-Authorization":
              "Basic " + Buffer.from("alice:pw").toString("base64"),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(data));
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(body).toBe("ORIGIN-HTTP-OK");
    // Egress went through the phone to the origin host:port.
    expect(egress).toContain(`127.0.0.1:${originPort}`);
  });

  it("proxies HTTPS via CONNECT and egresses via the phone", async () => {
    // Local origin HTTPS server with its own self-signed cert.
    const pems = selfsigned.generate(
      [{ name: "commonName", value: "127.0.0.1" }],
      { keySize: 2048, days: 1, algorithm: "sha256" },
    );
    originHttps = createHttps(
      { cert: pems.cert, key: pems.private },
      (req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ORIGIN-HTTPS-OK");
      },
    );
    originHttps.listen(0, "127.0.0.1");
    await once(originHttps, "listening");
    const originPort = (originHttps.address() as AddressInfo).port;

    const { proxyPort, tunnelPort } = await startRelay();
    const egress: string[] = [];
    await connectPhone(tunnelPort, egress);

    // 1. Open a raw socket to the proxy and send CONNECT.
    const clientSock = netConnect(proxyPort, "127.0.0.1");
    await once(clientSock, "connect");
    clientSock.write(
      `CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${originPort}\r\n` +
        `Proxy-Authorization: Basic ${Buffer.from("alice:pw").toString(
          "base64",
        )}\r\n\r\n`,
    );

    // 2. Read the 200 Connection Established line.
    const established: string = await new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx !== -1) {
          clientSock.off("data", onData);
          resolve(buf.subarray(0, idx + 4).toString());
        }
      };
      clientSock.on("data", onData);
    });
    expect(established).toContain("200 Connection Established");

    // 3. Run TLS over the established tunnel and make an HTTPS GET.
    const tlsSock = tlsConnect({
      socket: clientSock,
      servername: "127.0.0.1",
      rejectUnauthorized: false,
    });
    await once(tlsSock, "secureConnect");
    tlsSock.write(
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`,
    );
    const httpsBody: string = await new Promise((resolve) => {
      let buf = "";
      tlsSock.on("data", (d) => (buf += d.toString()));
      tlsSock.on("end", () => resolve(buf));
      tlsSock.on("close", () => resolve(buf));
    });

    expect(httpsBody).toContain("ORIGIN-HTTPS-OK");
    expect(egress).toContain(`127.0.0.1:${originPort}`);
    clientSock.destroy();
  });

  it("performs a CONNECT over the TLS proxy listener (:proxyTlsPort)", async () => {
    // Local origin HTTPS server with its own self-signed cert.
    const pems = selfsigned.generate(
      [{ name: "commonName", value: "127.0.0.1" }],
      { keySize: 2048, days: 1, algorithm: "sha256" },
    );
    originHttps = createHttps(
      { cert: pems.cert, key: pems.private },
      (req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ORIGIN-VIA-TLS-PROXY");
      },
    );
    originHttps.listen(0, "127.0.0.1");
    await once(originHttps, "listening");
    const originPort = (originHttps.address() as AddressInfo).port;

    const { proxyTlsPort, tunnelPort } = await startRelay();
    const egress: string[] = [];
    await connectPhone(tunnelPort, egress);

    // 1. TLS-connect to the relay's TLS proxy listener (self-signed cert).
    const proxyTls = tlsConnect({
      host: "127.0.0.1",
      port: proxyTlsPort,
      rejectUnauthorized: false,
    });
    await once(proxyTls, "secureConnect");

    // 2. Send CONNECT over the encrypted client->relay hop.
    proxyTls.write(
      `CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${originPort}\r\n` +
        `Proxy-Authorization: Basic ${Buffer.from("alice:pw").toString(
          "base64",
        )}\r\n\r\n`,
    );
    const established: string = await new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx !== -1) {
          proxyTls.off("data", onData);
          resolve(buf.subarray(0, idx + 4).toString());
        }
      };
      proxyTls.on("data", onData);
    });
    expect(established).toContain("200 Connection Established");

    // 3. Inner TLS to the origin, tunneled through the established CONNECT.
    const innerTls = tlsConnect({
      socket: proxyTls,
      servername: "127.0.0.1",
      rejectUnauthorized: false,
    });
    await once(innerTls, "secureConnect");
    innerTls.write(
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`,
    );
    const httpsBody: string = await new Promise((resolve) => {
      let buf = "";
      innerTls.on("data", (d) => (buf += d.toString()));
      innerTls.on("end", () => resolve(buf));
      innerTls.on("close", () => resolve(buf));
    });

    expect(httpsBody).toContain("ORIGIN-VIA-TLS-PROXY");
    expect(egress).toContain(`127.0.0.1:${originPort}`);
    proxyTls.destroy();
  });
});
