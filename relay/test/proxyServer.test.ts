import { describe, it, expect, afterEach } from "vitest";
import { connect as netConnect, type Socket } from "node:net";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import { Mux } from "../src/mux.js";
import {
  FrameType,
  decodeFrame,
  encodeFrame,
  encodeJsonFrame,
  type Frame,
} from "../src/frames.js";
import { ProxyServer, type TunnelLike } from "../src/proxyServer.js";
import { ConnectionLimiter } from "../src/rateLimiter.js";
import { hashPassword } from "../src/auth.js";
import { Store } from "../src/store.js";

/**
 * Poll `fn` every `stepMs` until it returns true, or throw after `timeoutMs`.
 * Use this instead of fixed-duration sleeps before asserting on async state
 * (e.g. tunnel.sent frames) so tests are deterministic regardless of how long
 * bcrypt or the event loop takes.
 */
async function waitFor(
  fn: () => boolean,
  timeoutMs = 3000,
  stepMs = 5,
): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs)
      throw new Error("waitFor: condition not met within " + timeoutMs + "ms");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

let proxy: ProxyServer | null = null;
let store: Store | null = null;
const sockets: Socket[] = [];

afterEach(() => {
  for (const s of sockets) s.destroy();
  sockets.length = 0;
  proxy?.close();
  store?.close();
  proxy = null;
  store = null;
});

/**
 * A fake phone tunnel. Records frames the proxy sends to the phone, lets the
 * test drive OPEN_OK/OPEN_FAIL and DATA back, and mirrors the real Tunnel API
 * the ProxyServer relies on.
 */
class FakeTunnel implements TunnelLike {
  readonly mux = new Mux();
  readonly sent: Frame[] = [];
  private openWaiters = new Map<number, (r: { ok: boolean; reason?: string }) => void>();
  autoOpen: "ok" | "fail" | "manual" = "ok";

  send(frame: Buffer): void {
    const f = decodeFrame(frame);
    this.sent.push(f);
    if (f.type === FrameType.OPEN && this.autoOpen !== "manual") {
      queueMicrotask(() => {
        if (this.autoOpen === "ok") this.resolveOpen(f.streamId, { ok: true });
        else this.resolveOpen(f.streamId, { ok: false, reason: "refused" });
      });
    }
  }

  waitOpen(streamId: number): Promise<{ ok: boolean; reason?: string }> {
    return new Promise((resolve) => this.openWaiters.set(streamId, resolve));
  }

  resolveOpen(streamId: number, r: { ok: boolean; reason?: string }): void {
    const w = this.openWaiters.get(streamId);
    if (w) {
      this.openWaiters.delete(streamId);
      w(r);
    }
  }

  /** Simulate the phone sending DATA back to the client for a stream. */
  pushData(streamId: number, payload: Buffer): void {
    this.mux.routeData(streamId, payload);
  }
}

async function startProxy(opts: {
  tunnel: TunnelLike | null;
  store: Store;
  limiter?: ConnectionLimiter;
}): Promise<number> {
  proxy = new ProxyServer({
    getLiveTunnel: () => opts.tunnel,
    store: opts.store,
    allowedClientCidrs: [],
    limiter: opts.limiter,
  });
  const port = await proxy.listen(0);
  return port;
}

function rawConnect(port: number): Socket {
  const s = netConnect(port, "127.0.0.1");
  sockets.push(s);
  return s;
}

function readResponseHead(s: Socket): Promise<string> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx !== -1) {
        s.off("data", onData);
        resolve(buf.subarray(0, idx + 4).toString("utf8"));
      }
    };
    s.on("data", onData);
  });
}

describe("ProxyServer auth", () => {
  it("returns 407 when Proxy-Authorization is missing", async () => {
    store = new Store(":memory:");
    const tunnel = new FakeTunnel();
    const port = await startProxy({ tunnel, store });
    const s = rawConnect(port);
    await once(s, "connect");
    s.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    const head = await readResponseHead(s);
    expect(head).toContain("407 Proxy Authentication Required");
    expect(head).toContain("Proxy-Authenticate: Basic");
  });
});

async function seedUser(s: Store, username: string, password: string) {
  s.upsertDevice({
    deviceId: "dev-x",
    proxyUsername: username,
    bcryptPassword: await hashPassword(password),
  });
}

function basicHeader(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

describe("ProxyServer no live phone", () => {
  it("returns 503 when there is no tunnel", async () => {
    store = new Store(":memory:");
    await seedUser(store, "alice", "pw");
    const port = await startProxy({ tunnel: null, store });
    const s = rawConnect(port);
    await once(s, "connect");
    s.write(
      `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: ${basicHeader(
        "alice",
        "pw",
      )}\r\n\r\n`,
    );
    const head = await readResponseHead(s);
    expect(head).toContain("503 Service Unavailable");
  });
});

describe("ProxyServer CONNECT happy path", () => {
  it("sends OPEN, returns 200, and pipes DATA both ways", async () => {
    store = new Store(":memory:");
    await seedUser(store, "alice", "pw");
    const tunnel = new FakeTunnel();
    const port = await startProxy({ tunnel, store });
    const s = rawConnect(port);
    await once(s, "connect");
    s.write(
      `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: ${basicHeader(
        "alice",
        "pw",
      )}\r\n\r\n`,
    );
    const head = await readResponseHead(s);
    expect(head).toContain("200 Connection Established");

    // The proxy sent an OPEN frame for the right host:port.
    const openFrame = tunnel.sent.find((f) => f.type === FrameType.OPEN);
    expect(openFrame).toBeDefined();
    const openJson = JSON.parse(openFrame!.payload.toString("utf8"));
    expect(openJson).toEqual({ host: "example.com", port: 443 });
    const streamId = openFrame!.streamId;

    // Client -> phone: bytes written by the client become DATA frames.
    s.write(Buffer.from("hello-target"));
    await waitFor(() =>
      tunnel.sent.some(
        (f) => f.type === FrameType.DATA && f.payload.toString() === "hello-target",
      ),
    );
    const dataFrame = tunnel.sent.find(
      (f) => f.type === FrameType.DATA && f.payload.toString() === "hello-target",
    );
    expect(dataFrame).toBeDefined();

    // Phone -> client: DATA pushed back reaches the client socket.
    const got = new Promise<Buffer>((resolve) => {
      s.once("data", (d) => resolve(d as Buffer));
    });
    tunnel.pushData(streamId, Buffer.from("from-target"));
    expect((await got).toString()).toBe("from-target");
  });
});

describe("ProxyServer OPEN_FAIL", () => {
  it("returns 502 when the phone replies OPEN_FAIL", async () => {
    store = new Store(":memory:");
    await seedUser(store, "alice", "pw");
    const tunnel = new FakeTunnel();
    tunnel.autoOpen = "fail";
    const port = await startProxy({ tunnel, store });
    const s = rawConnect(port);
    await once(s, "connect");
    s.write(
      `CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: ${basicHeader(
        "alice",
        "pw",
      )}\r\n\r\n`,
    );
    const head = await readResponseHead(s);
    expect(head).toContain("502 Bad Gateway");
  });
});

describe("ProxyServer wrong password", () => {
  it("returns 407 on an incorrect password", async () => {
    store = new Store(":memory:");
    await seedUser(store, "alice", "right-pw");
    const tunnel = new FakeTunnel();
    const port = await startProxy({ tunnel, store });
    const s = rawConnect(port);
    await once(s, "connect");
    s.write(
      `CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: ${basicHeader(
        "alice",
        "wrong-pw",
      )}\r\n\r\n`,
    );
    const head = await readResponseHead(s);
    expect(head).toContain("407 Proxy Authentication Required");
  });
});

describe("ProxyServer absolute-URI plain HTTP", () => {
  it("OPENs the host:80 and forwards an origin-form request as DATA", async () => {
    store = new Store(":memory:");
    await seedUser(store, "alice", "pw");
    const tunnel = new FakeTunnel();
    const port = await startProxy({ tunnel, store });
    const s = rawConnect(port);
    await once(s, "connect");
    s.write(
      `GET http://example.com/path?q=1 HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: ${basicHeader(
        "alice",
        "pw",
      )}\r\nUser-Agent: t\r\n\r\n`,
    );
    await waitFor(() => tunnel.sent.some((f) => f.type === FrameType.OPEN));

    const openFrame = tunnel.sent.find((f) => f.type === FrameType.OPEN);
    expect(openFrame).toBeDefined();
    expect(JSON.parse(openFrame!.payload.toString("utf8"))).toEqual({
      host: "example.com",
      port: 80,
    });

    const dataFrame = tunnel.sent.find((f) => f.type === FrameType.DATA);
    expect(dataFrame).toBeDefined();
    const forwarded = dataFrame!.payload.toString("utf8");
    // Origin-form request line, proxy-authorization stripped.
    expect(forwarded.startsWith("GET /path?q=1 HTTP/1.1\r\n")).toBe(true);
    expect(forwarded.toLowerCase()).not.toContain("proxy-authorization");
    expect(forwarded).toContain("Host: example.com\r\n");
    expect(forwarded).toContain("User-Agent: t\r\n");
  });
});

import { ipAllowed } from "../src/proxyServer.js";

describe("ipAllowed CIDR matching", () => {
  it("matches an IP inside the CIDR", () => {
    expect(ipAllowed("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
  });
  it("rejects an IP outside every CIDR", () => {
    expect(ipAllowed("192.168.5.5", ["10.0.0.0/8"])).toBe(false);
  });
  it("handles ::ffff: IPv4-mapped addresses", () => {
    expect(ipAllowed("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(true);
  });
  it("matches /32 exactly", () => {
    expect(ipAllowed("1.2.3.4", ["1.2.3.4/32"])).toBe(true);
    expect(ipAllowed("1.2.3.5", ["1.2.3.4/32"])).toBe(false);
  });
});

describe("ProxyServer connection limiter", () => {
  it("replies 429 once the limiter rejects the connection", async () => {
    store = new Store(":memory:");
    await seedUser(store, "alice", "pw");
    const tunnel = new FakeTunnel();
    // maxPerIp = 1: the first connection is admitted and held open; the second
    // from the same IP (127.0.0.1) is rejected before any request is read.
    const limiter = new ConnectionLimiter({
      maxTotal: 100,
      maxPerIp: 1,
      maxNewPerMin: 100,
      windowMs: 60000,
    });
    const port = await startProxy({ tunnel, store, limiter });

    // First connection: send a CONNECT and hold it open (200 Established).
    const first = rawConnect(port);
    await once(first, "connect");
    first.write(
      `CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: ${basicHeader(
        "alice",
        "pw",
      )}\r\n\r\n`,
    );
    const firstHead = await readResponseHead(first);
    expect(firstHead).toContain("200 Connection Established");

    // Second connection from the same IP is rejected with 429 immediately.
    const second = rawConnect(port);
    await once(second, "connect");
    const head = await readResponseHead(second);
    expect(head).toContain("429 Too Many Requests");

    // After the first closes, the slot is released and a new conn is admitted.
    first.destroy();
    await once(first, "close");
    const third = rawConnect(port);
    await once(third, "connect");
    third.write(
      `CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: ${basicHeader(
        "alice",
        "pw",
      )}\r\n\r\n`,
    );
    const thirdHead = await readResponseHead(third);
    expect(thirdHead).toContain("200 Connection Established");
  });
});
