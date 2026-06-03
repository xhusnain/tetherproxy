import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { WebSocketServer, WebSocket } from "ws";
import { Mux } from "./mux.js";
import { Store } from "./store.js";
import { hashPassword } from "./auth.js";
import {
  FrameType,
  decodeFrame,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
  type Frame,
} from "./frames.js";

export interface TunnelServerOptions {
  server: HttpServer | HttpsServer;
  store: Store;
  pairingToken: string;
  heartbeatMs?: number;
}

interface AuthPayload {
  pairingToken: string;
  deviceId: string;
  proxyUsername: string;
  proxyPassword: string;
}

export interface OpenResult {
  ok: boolean;
  reason?: string;
}

/**
 * A single authenticated phone connection: its socket, its stream multiplexer,
 * and pending OPEN result waiters keyed by streamId.
 */
export class Tunnel {
  readonly mux = new Mux();
  private readonly openWaiters = new Map<
    number,
    (r: OpenResult) => void
  >();

  constructor(
    readonly ws: WebSocket,
    readonly deviceId: string,
    readonly proxyUsername: string,
  ) {}

  /** Send a pre-encoded frame to the phone. */
  send(frame: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  /** Await the phone's OPEN_OK/OPEN_FAIL for a streamId. */
  waitOpen(streamId: number): Promise<OpenResult> {
    return new Promise<OpenResult>((resolve) => {
      this.openWaiters.set(streamId, resolve);
    });
  }

  /** Resolve a pending OPEN waiter (called by the server on OPEN_OK/FAIL). */
  resolveOpen(streamId: number, result: OpenResult): void {
    const waiter = this.openWaiters.get(streamId);
    if (waiter) {
      this.openWaiters.delete(streamId);
      waiter(result);
    }
  }
}

/**
 * WSS tunnel endpoint. Accepts one WebSocket per phone, performs the AUTH
 * handshake, persists credentials, tracks the live tunnel, and runs an
 * app-level PING/PONG heartbeat.
 */
export class TunnelServer {
  private readonly wss: WebSocketServer;
  private readonly store: Store;
  private readonly pairingToken: string;
  private readonly heartbeatMs: number;
  private liveTunnel: Tunnel | null = null;
  private readonly timers = new WeakMap<WebSocket, NodeJS.Timeout>();
  /**
   * Consecutive unanswered PINGs per authenticated socket. A PONG resets it to
   * 0; each heartbeat tick increments it before sending a fresh PING. Reaching
   * MAX_MISSED_PONGS means the link is dead and we terminate. The grace of two
   * extra ticks tolerates a round-trip's worth of latency / a single dropped
   * PONG without a false disconnect.
   */
  private readonly missedPongs = new WeakMap<WebSocket, number>();
  private static readonly MAX_MISSED_PONGS = 3;

  constructor(opts: TunnelServerOptions) {
    this.store = opts.store;
    this.pairingToken = opts.pairingToken;
    this.heartbeatMs = opts.heartbeatMs ?? 25000;
    this.wss = new WebSocketServer({ server: opts.server });
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  /** The currently live phone tunnel, or null if none is connected. */
  getLiveTunnel(): Tunnel | null {
    return this.liveTunnel;
  }

  private onConnection(ws: WebSocket): void {
    let authed: Tunnel | null = null;

    ws.on("message", (data) => {
      const buf = toBuffer(data);
      let frame: Frame;
      try {
        frame = decodeFrame(buf);
      } catch {
        ws.close(1002, "bad frame");
        return;
      }

      if (!authed) {
        if (frame.type !== FrameType.AUTH) {
          ws.send(
            encodeJsonFrame(FrameType.AUTH_FAIL, 0, {
              reason: "expected AUTH first",
            }),
          );
          ws.close(1008, "auth required");
          return;
        }
        void this.handleAuth(ws, frame).then((tunnel) => {
          if (tunnel) authed = tunnel;
        });
        return;
      }

      this.handleAuthedFrame(authed, frame);
    });

    ws.on("close", () => {
      const t = this.timers.get(ws);
      if (t) clearInterval(t);
      if (authed) {
        authed.mux.destroyAll();
        if (this.liveTunnel === authed) this.liveTunnel = null;
      }
    });

    ws.on("error", () => {
      ws.terminate();
    });
  }

  private async handleAuth(
    ws: WebSocket,
    frame: Frame,
  ): Promise<Tunnel | null> {
    let payload: AuthPayload;
    try {
      payload = decodeJsonPayload<AuthPayload>(frame.payload);
    } catch {
      ws.send(
        encodeJsonFrame(FrameType.AUTH_FAIL, 0, { reason: "bad AUTH payload" }),
      );
      ws.close(1008, "bad auth");
      return null;
    }

    if (payload.pairingToken !== this.pairingToken) {
      ws.send(
        encodeJsonFrame(FrameType.AUTH_FAIL, 0, {
          reason: "invalid pairing token",
        }),
      );
      ws.close(1008, "auth failed");
      return null;
    }
    if (
      !payload.deviceId ||
      !payload.proxyUsername ||
      !payload.proxyPassword
    ) {
      ws.send(
        encodeJsonFrame(FrameType.AUTH_FAIL, 0, {
          reason: "missing device/username/password",
        }),
      );
      ws.close(1008, "auth failed");
      return null;
    }

    const bcryptPassword = await hashPassword(payload.proxyPassword);
    this.store.upsertDevice({
      deviceId: payload.deviceId,
      proxyUsername: payload.proxyUsername,
      bcryptPassword,
    });

    const tunnel = new Tunnel(ws, payload.deviceId, payload.proxyUsername);
    // Replace any prior live tunnel (single-device v1).
    if (this.liveTunnel && this.liveTunnel.ws !== ws) {
      this.liveTunnel.ws.close(1000, "replaced by new device");
    }
    this.liveTunnel = tunnel;
    ws.send(encodeFrame(FrameType.AUTH_OK, 0));
    this.startHeartbeat(ws);
    return tunnel;
  }

  private handleAuthedFrame(tunnel: Tunnel, frame: Frame): void {
    switch (frame.type) {
      case FrameType.DATA:
        tunnel.mux.routeData(frame.streamId, frame.payload);
        break;
      case FrameType.CLOSE:
        tunnel.mux.routeClose(frame.streamId);
        break;
      case FrameType.PONG:
        this.missedPongs.set(tunnel.ws, 0);
        break;
      case FrameType.PING:
        tunnel.send(encodeFrame(FrameType.PONG, 0));
        break;
      case FrameType.OPEN_OK:
        tunnel.resolveOpen(frame.streamId, { ok: true });
        break;
      case FrameType.OPEN_FAIL: {
        let reason = "open failed";
        try {
          reason = decodeJsonPayload<{ reason: string }>(frame.payload).reason;
        } catch {
          /* keep default reason */
        }
        tunnel.resolveOpen(frame.streamId, { ok: false, reason });
        break;
      }
      default:
        break;
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.missedPongs.set(ws, 0);
    const timer = setInterval(() => {
      const missed = (this.missedPongs.get(ws) ?? 0) + 1;
      if (missed >= TunnelServer.MAX_MISSED_PONGS) {
        // Too many PINGs went unanswered: the link is dead. Drop the live
        // tunnel synchronously so callers see it gone the instant the socket
        // dies, then terminate (the "close" handler is a backstop for the same
        // work).
        if (this.liveTunnel && this.liveTunnel.ws === ws) {
          this.liveTunnel = null;
        }
        ws.terminate();
        clearInterval(timer);
        return;
      }
      this.missedPongs.set(ws, missed);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeFrame(FrameType.PING, 0));
      }
    }, this.heartbeatMs);
    // Don't let the heartbeat alone keep the process alive on shutdown.
    timer.unref?.();
    this.timers.set(ws, timer);
  }

  /** Close the WSS server and all connections. */
  close(): void {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    this.liveTunnel = null;
  }
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  return Buffer.from(data as ArrayBufferView as any);
}
