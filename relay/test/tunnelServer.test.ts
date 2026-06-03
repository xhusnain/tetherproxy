import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import WebSocket from "ws";
import { Store } from "../src/store.js";
import { TunnelServer } from "../src/tunnelServer.js";
import {
  FrameType,
  encodeJsonFrame,
  decodeFrame,
  encodeFrame,
  decodeJsonPayload,
} from "../src/frames.js";

let http: Server | null = null;
let tunnel: TunnelServer | null = null;
let store: Store | null = null;
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const c of clients) c.terminate();
  clients.length = 0;
  tunnel?.close();
  store?.close();
  if (http) {
    http.close();
    await once(http, "close").catch(() => {});
  }
  http = null;
  tunnel = null;
  store = null;
});

async function startTunnel(opts?: { heartbeatMs?: number }) {
  store = new Store(":memory:");
  http = createServer();
  tunnel = new TunnelServer({
    server: http,
    store,
    pairingToken: "secret-token",
    heartbeatMs: opts?.heartbeatMs ?? 25000,
  });
  http.listen(0);
  await once(http, "listening");
  const port = (http.address() as AddressInfo).port;
  return port;
}

function connect(port: number): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  clients.push(ws);
  return ws;
}

function nextMessage(ws: WebSocket): Promise<Buffer> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(data as Buffer));
  });
}

describe("TunnelServer AUTH", () => {
  it("responds AUTH_OK to a valid pairing token and marks the device live", async () => {
    const port = await startTunnel();
    const ws = connect(port);
    await once(ws, "open");
    ws.send(
      encodeJsonFrame(FrameType.AUTH, 0, {
        pairingToken: "secret-token",
        deviceId: "phone-1",
        proxyUsername: "alice",
        proxyPassword: "pw-123",
      }),
    );
    const reply = decodeFrame(await nextMessage(ws));
    expect(reply.type).toBe(FrameType.AUTH_OK);
    expect(tunnel!.getLiveTunnel()).not.toBeNull();
    // Credentials were persisted.
    expect(store!.findByUsername("alice")).not.toBeNull();
  });
});

describe("TunnelServer AUTH failures", () => {
  it("responds AUTH_FAIL and closes on an invalid token", async () => {
    const port = await startTunnel();
    const ws = connect(port);
    await once(ws, "open");
    ws.send(
      encodeJsonFrame(FrameType.AUTH, 0, {
        pairingToken: "WRONG",
        deviceId: "phone-1",
        proxyUsername: "alice",
        proxyPassword: "pw",
      }),
    );
    const reply = decodeFrame(await nextMessage(ws));
    expect(reply.type).toBe(FrameType.AUTH_FAIL);
    expect(decodeJsonPayloadReason(reply.payload)).toContain("invalid");
    expect(tunnel!.getLiveTunnel()).toBeNull();
  });

  it("rejects a non-AUTH first frame", async () => {
    const port = await startTunnel();
    const ws = connect(port);
    await once(ws, "open");
    ws.send(encodeFrame(FrameType.PING, 0));
    const reply = decodeFrame(await nextMessage(ws));
    expect(reply.type).toBe(FrameType.AUTH_FAIL);
    expect(tunnel!.getLiveTunnel()).toBeNull();
  });
});

function decodeJsonPayloadReason(payload: Buffer): string {
  return JSON.parse(payload.toString("utf8")).reason as string;
}

describe("TunnelServer heartbeat", () => {
  it("sends app-level PING on the heartbeat interval", async () => {
    const port = await startTunnel({ heartbeatMs: 60 });
    const ws = connect(port);
    await once(ws, "open");
    ws.send(
      encodeJsonFrame(FrameType.AUTH, 0, {
        pairingToken: "secret-token",
        deviceId: "phone-1",
        proxyUsername: "alice",
        proxyPassword: "pw",
      }),
    );
    // First message is AUTH_OK.
    const authOk = decodeFrame(await nextMessage(ws));
    expect(authOk.type).toBe(FrameType.AUTH_OK);
    // Next server-initiated frame should be a PING.
    const ping = decodeFrame(await nextMessage(ws));
    expect(ping.type).toBe(FrameType.PING);
    // Reply with PONG to keep the link alive; the connection must stay open.
    ws.send(encodeFrame(FrameType.PONG, 0));
    await new Promise((r) => setTimeout(r, 120));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("terminates the connection when no PONG arrives", async () => {
    const port = await startTunnel({ heartbeatMs: 50 });
    const ws = connect(port);
    await once(ws, "open");
    ws.send(
      encodeJsonFrame(FrameType.AUTH, 0, {
        pairingToken: "secret-token",
        deviceId: "phone-1",
        proxyUsername: "alice",
        proxyPassword: "pw",
      }),
    );
    decodeFrame(await nextMessage(ws)); // AUTH_OK
    // Do NOT reply to PINGs. After two intervals the server terminates us.
    await once(ws, "close");
    expect(tunnel!.getLiveTunnel()).toBeNull();
  });
});

describe("TunnelServer per-stream OPEN result dispatch", () => {
  it("resolves a registered waiter on OPEN_OK", async () => {
    const port = await startTunnel();
    const ws = connect(port);
    await once(ws, "open");
    ws.send(
      encodeJsonFrame(FrameType.AUTH, 0, {
        pairingToken: "secret-token",
        deviceId: "phone-1",
        proxyUsername: "alice",
        proxyPassword: "pw",
      }),
    );
    decodeFrame(await nextMessage(ws)); // AUTH_OK
    const t = tunnel!.getLiveTunnel()!;
    const waiter = t.waitOpen(5);
    // Simulate the phone replying OPEN_OK for stream 5.
    ws.send(encodeFrame(FrameType.OPEN_OK, 5));
    const result = await waiter;
    expect(result.ok).toBe(true);
  });

  it("resolves a registered waiter on OPEN_FAIL with the reason", async () => {
    const port = await startTunnel();
    const ws = connect(port);
    await once(ws, "open");
    ws.send(
      encodeJsonFrame(FrameType.AUTH, 0, {
        pairingToken: "secret-token",
        deviceId: "phone-1",
        proxyUsername: "alice",
        proxyPassword: "pw",
      }),
    );
    decodeFrame(await nextMessage(ws)); // AUTH_OK
    const t = tunnel!.getLiveTunnel()!;
    const waiter = t.waitOpen(6);
    ws.send(encodeJsonFrame(FrameType.OPEN_FAIL, 6, { reason: "refused" }));
    const result = await waiter;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("refused");
  });
});
