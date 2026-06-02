# TetherProxy Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build the TetherProxy relay — a Dockerized Node.js + TypeScript service running on an Alibaba Cloud ECS VM that is simultaneously an authenticated HTTP/HTTPS proxy front end (port 8080/8081) and a WSS tunnel endpoint (port 8443) that multiplexes every proxy connection over a single persistent WebSocket to the paired phone.

**Architecture:** Cloud clients point `HTTPS_PROXY`/`HTTP_PROXY` at the relay's `:8080` (or the optional TLS proxy listener `:8081`). The relay enforces connection caps and per-IP rate limiting, parses `CONNECT`/absolute-URI requests, validates Basic proxy-auth (bcrypt), then forwards each connection as a multiplexed stream over the one WSS tunnel (`:8443`) that the phone dialed out and holds open. The phone opens raw sockets to the target host over its home internet and pipes bytes back through the tunnel using a frozen binary frame protocol. A small persistent store maps proxy usernames to bcrypt password hashes and tracks which device is live.

**Tech Stack:** Node.js (lts), TypeScript, `ws` (WebSocket server), `bcryptjs` (password hashing), `better-sqlite3` (credential store), `selfsigned` (TLS cert generation), `vitest` (tests), Docker + docker-compose.

## File Structure

| File | Responsibility |
|------|----------------|
| `relay/package.json` | npm metadata, dependencies, build/test/dev scripts |
| `relay/tsconfig.json` | TypeScript compiler config (strict, ESM, outDir `dist`) |
| `relay/vitest.config.ts` | Vitest test runner config (node environment) |
| `relay/.gitignore` | Ignore `node_modules`, `dist`, `data/`, `certs/`, `.env` |
| `relay/src/frames.ts` | `FrameType` enum + encode/decode of the frozen binary tunnel frames |
| `relay/test/frames.test.ts` | Round-trip unit tests for every frame type |
| `relay/src/mux.ts` | Per-connection stream registry: `streamId → client socket`, monotonic allocation, DATA/CLOSE routing, cleanup |
| `relay/test/mux.test.ts` | Stream lifecycle unit tests |
| `relay/src/auth.ts` | bcrypt hash/verify of proxy passwords, parse `Proxy-Authorization: Basic`, build `407` response |
| `relay/test/auth.test.ts` | Auth unit tests incl. missing/invalid headers |
| `relay/src/store.ts` | better-sqlite3 device+credential store: upsert, lookup by username |
| `relay/test/store.test.ts` | Store unit tests (upsert/lookup/re-pair) |
| `relay/src/config.ts` | Env parsing with defaults |
| `relay/test/config.test.ts` | Config parsing unit test |
| `relay/src/rateLimiter.ts` | `ConnectionLimiter`: global + per-IP active connection caps and fixed-window per-IP new-connection rate limit (pure, injectable clock) |
| `relay/test/rateLimiter.test.ts` | Connection limiter unit tests (per-IP cap, global cap, window reset, release) |
| `relay/src/tls.ts` | Self-signed cert generation on first boot + SHA-256 fingerprint logging |
| `relay/test/tls.test.ts` | Cert generation + fingerprint unit test |
| `relay/src/tunnelServer.ts` | WSS server on `:8443`: AUTH handshake, store upsert, live-device registry, PING/PONG heartbeat |
| `relay/test/tunnelServer.test.ts` | Tunnel server tests with a real `ws` client |
| `relay/src/proxyServer.ts` | Raw `net.Server` on `:8080` + reusable `handleProxyConnection` (shared by the plain and TLS listeners): rate-limit/cap check, parse CONNECT/HTTP, Basic auth, allocate stream, OPEN/DATA/CLOSE piping |
| `relay/test/proxyServer.test.ts` | Proxy server tests driven by a fake phone tunnel (incl. rate-limit rejection) |
| `relay/src/index.ts` | Wire config + tls + store + tunnelServer + proxyServer; graceful shutdown |
| `relay/test/integration.test.ts` | Real relay + fake phone WS client + real HTTP/HTTPS test servers, end-to-end |
| `relay/Dockerfile` | Multi-stage build on `node:lts-alpine` |
| `relay/docker-compose.yml` | Service def, named volume for store, env via `.env` |
| `relay/.env.example` | Example environment variables |
| `relay/README.md` | Alibaba Cloud ECS deploy + client usage docs |

---

### Task 1: Project initialization

**Files:**
- Create: `relay/package.json`
- Create: `relay/tsconfig.json`
- Create: `relay/vitest.config.ts`
- Create: `relay/.gitignore`
- Create: `relay/test/smoke.test.ts`

- [ ] **Step 1: Create the project directory and initialize git.**

```bash
mkdir -p /home/hubextech/tetherproxy/relay/src /home/hubextech/tetherproxy/relay/test
cd /home/hubextech/tetherproxy/relay && git init
```

- [ ] **Step 2: Write `relay/package.json`.**

Create `relay/package.json`:

```json
{
  "name": "tetherproxy-relay",
  "version": "1.0.0",
  "description": "TetherProxy relay: authenticated HTTP/HTTPS proxy front end + WSS tunnel endpoint",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^11.3.0",
    "selfsigned": "^2.4.1",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.5.0",
    "@types/ws": "^8.5.12",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Write `relay/tsconfig.json`.**

Create `relay/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 4: Write `relay/vitest.config.ts`.**

Create `relay/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
```

- [ ] **Step 5: Write `relay/.gitignore`.**

Create `relay/.gitignore`:

```
node_modules/
dist/
data/
certs/
.env
*.log
```

- [ ] **Step 6: Install dependencies.**

```bash
cd /home/hubextech/tetherproxy/relay && npm install
```

Expected: `node_modules` populated, `package-lock.json` created, no errors.

- [ ] **Step 7: Write a failing smoke test.**

Create `relay/test/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("toolchain smoke", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 8: Run the smoke test (expect PASS — verifies the toolchain).**

```bash
cd /home/hubextech/tetherproxy/relay && npm test
```

Expected output contains: `Test Files  1 passed (1)` and `Tests  1 passed (1)`.

- [ ] **Step 9: Commit.**

```bash
cd /home/hubextech/tetherproxy/relay
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore test/smoke.test.ts
git commit -m "chore(relay): project init with TypeScript + vitest toolchain

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Frame codec (`src/frames.ts`)

**Files:**
- Create: `relay/src/frames.ts`
- Test: `relay/test/frames.test.ts`

The frame layout is FROZEN: `[1 byte type][4 bytes streamId big-endian][payload]`. streamId 0 = control frames.

- [ ] **Step 1: Write the failing test for `FrameType` enum and basic encode/decode of an empty-payload frame.**

Create `relay/test/frames.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FrameType, encodeFrame, decodeFrame } from "../src/frames.js";

describe("FrameType enum", () => {
  it("has the frozen type codes", () => {
    expect(FrameType.AUTH).toBe(0x01);
    expect(FrameType.AUTH_OK).toBe(0x02);
    expect(FrameType.AUTH_FAIL).toBe(0x03);
    expect(FrameType.OPEN).toBe(0x10);
    expect(FrameType.OPEN_OK).toBe(0x11);
    expect(FrameType.OPEN_FAIL).toBe(0x12);
    expect(FrameType.DATA).toBe(0x20);
    expect(FrameType.CLOSE).toBe(0x21);
    expect(FrameType.PING).toBe(0x30);
    expect(FrameType.PONG).toBe(0x31);
  });
});

describe("encodeFrame / decodeFrame", () => {
  it("round-trips an empty-payload control frame", () => {
    const buf = encodeFrame(FrameType.AUTH_OK, 0, Buffer.alloc(0));
    expect(buf.length).toBe(5);
    expect(buf[0]).toBe(0x02);
    const f = decodeFrame(buf);
    expect(f.type).toBe(FrameType.AUTH_OK);
    expect(f.streamId).toBe(0);
    expect(f.payload.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL — module does not exist).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/frames.test.ts
```

Expected FAIL message: `Failed to resolve import "../src/frames.js"` (Cannot find module).

- [ ] **Step 3: Write the minimal `src/frames.ts`.**

Create `relay/src/frames.ts`:

```ts
/**
 * Frozen tunnel frame protocol (relay <-> phone).
 * Layout: [1 byte type][4 bytes streamId big-endian][payload].
 * streamId 0 = control frames.
 */

export enum FrameType {
  AUTH = 0x01,
  AUTH_OK = 0x02,
  AUTH_FAIL = 0x03,
  OPEN = 0x10,
  OPEN_OK = 0x11,
  OPEN_FAIL = 0x12,
  DATA = 0x20,
  CLOSE = 0x21,
  PING = 0x30,
  PONG = 0x31,
}

export interface Frame {
  type: FrameType;
  streamId: number;
  payload: Buffer;
}

export const HEADER_LEN = 5;

/** Encode a frame to a Buffer: [type][streamId BE][payload]. */
export function encodeFrame(
  type: FrameType,
  streamId: number,
  payload: Buffer = Buffer.alloc(0),
): Buffer {
  const buf = Buffer.allocUnsafe(HEADER_LEN + payload.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(streamId >>> 0, 1);
  payload.copy(buf, HEADER_LEN);
  return buf;
}

/** Decode a Buffer into a Frame. Throws if shorter than the 5-byte header. */
export function decodeFrame(buf: Buffer): Frame {
  if (buf.length < HEADER_LEN) {
    throw new Error(`frame too short: ${buf.length} bytes`);
  }
  const type = buf.readUInt8(0) as FrameType;
  const streamId = buf.readUInt32BE(1);
  const payload = buf.subarray(HEADER_LEN);
  return { type, streamId, payload };
}
```

- [ ] **Step 4: Run the test (expect PASS).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/frames.test.ts
```

Expected: `Tests  2 passed (2)`.

- [ ] **Step 5: Add a failing round-trip test for every frame type incl. JSON helpers.**

Append to `relay/test/frames.test.ts`:

```ts
import { encodeJsonFrame, decodeJsonPayload } from "../src/frames.js";

describe("encodeFrame round-trips every frame type", () => {
  const cases: Array<[FrameType, number, Buffer]> = [
    [FrameType.AUTH, 0, Buffer.from('{"pairingToken":"t"}', "utf8")],
    [FrameType.AUTH_OK, 0, Buffer.alloc(0)],
    [FrameType.AUTH_FAIL, 0, Buffer.from('{"reason":"bad"}', "utf8")],
    [FrameType.OPEN, 7, Buffer.from('{"host":"a","port":443}', "utf8")],
    [FrameType.OPEN_OK, 7, Buffer.alloc(0)],
    [FrameType.OPEN_FAIL, 7, Buffer.from('{"reason":"refused"}', "utf8")],
    [FrameType.DATA, 9, Buffer.from([1, 2, 3, 4, 5])],
    [FrameType.CLOSE, 9, Buffer.alloc(0)],
    [FrameType.PING, 0, Buffer.alloc(0)],
    [FrameType.PONG, 0, Buffer.alloc(0)],
  ];

  for (const [type, streamId, payload] of cases) {
    it(`round-trips type 0x${type.toString(16)} stream ${streamId}`, () => {
      const enc = encodeFrame(type, streamId, payload);
      const dec = decodeFrame(enc);
      expect(dec.type).toBe(type);
      expect(dec.streamId).toBe(streamId);
      expect(Buffer.compare(dec.payload, payload)).toBe(0);
    });
  }

  it("preserves a large 32-bit streamId via big-endian", () => {
    const enc = encodeFrame(FrameType.DATA, 0xdeadbeef, Buffer.from([0xff]));
    expect(enc[1]).toBe(0xde);
    expect(enc[2]).toBe(0xad);
    expect(enc[3]).toBe(0xbe);
    expect(enc[4]).toBe(0xef);
    expect(decodeFrame(enc).streamId).toBe(0xdeadbeef);
  });

  it("throws on a buffer shorter than the header", () => {
    expect(() => decodeFrame(Buffer.from([0x20, 0x00]))).toThrow();
  });
});

describe("JSON frame helpers", () => {
  it("round-trips a JSON object", () => {
    const enc = encodeJsonFrame(FrameType.OPEN, 42, { host: "x.com", port: 80 });
    const dec = decodeFrame(enc);
    expect(dec.type).toBe(FrameType.OPEN);
    expect(dec.streamId).toBe(42);
    expect(decodeJsonPayload(dec.payload)).toEqual({ host: "x.com", port: 80 });
  });
});
```

- [ ] **Step 6: Run the test (expect FAIL — JSON helpers undefined).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/frames.test.ts
```

Expected FAIL message: `No "encodeJsonFrame" export is defined`.

- [ ] **Step 7: Add the JSON helpers to `src/frames.ts`.**

Append to `relay/src/frames.ts`:

```ts
/** Encode a frame whose payload is a JSON-serialized object. */
export function encodeJsonFrame(
  type: FrameType,
  streamId: number,
  obj: unknown,
): Buffer {
  return encodeFrame(type, streamId, Buffer.from(JSON.stringify(obj), "utf8"));
}

/** Parse a frame payload as JSON. */
export function decodeJsonPayload<T = unknown>(payload: Buffer): T {
  return JSON.parse(payload.toString("utf8")) as T;
}
```

- [ ] **Step 8: Run the test (expect PASS).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/frames.test.ts
```

Expected: `Tests  15 passed (15)`.

- [ ] **Step 9: Commit.**

```bash
cd /home/hubextech/tetherproxy/relay
git add src/frames.ts test/frames.test.ts
git commit -m "feat(relay): binary tunnel frame codec with frozen type codes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Stream multiplexer (`src/mux.ts`)

**Files:**
- Create: `relay/src/mux.ts`
- Test: `relay/test/mux.test.ts`

The mux owns the per-connection (per-phone-tunnel) registry mapping `streamId → client socket`. streamId allocation is monotonic and odd-numbered avoidance is not required (relay owns allocation; OPEN is relay→phone). streamId 0 is reserved for control, so allocation starts at 1.

- [ ] **Step 1: Write the failing test for allocation + register/get/delete.**

Create `relay/test/mux.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Mux } from "../src/mux.js";

// Minimal fake of the bits of a net.Socket the Mux touches.
function fakeSocket() {
  const writes: Buffer[] = [];
  let destroyed = false;
  return {
    writes,
    get destroyed() {
      return destroyed;
    },
    write(b: Buffer) {
      writes.push(b);
      return true;
    },
    end() {
      destroyed = true;
    },
    destroy() {
      destroyed = true;
    },
  };
}

describe("Mux stream allocation", () => {
  it("allocates monotonic ids starting at 1, skipping 0", () => {
    const mux = new Mux();
    const a = mux.allocate(fakeSocket() as any);
    const b = mux.allocate(fakeSocket() as any);
    const c = mux.allocate(fakeSocket() as any);
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(c).toBe(3);
  });

  it("registers the socket under the allocated id", () => {
    const mux = new Mux();
    const sock = fakeSocket();
    const id = mux.allocate(sock as any);
    expect(mux.get(id)).toBe(sock);
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL — module missing).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/mux.test.ts
```

Expected FAIL message: `Failed to resolve import "../src/mux.js"`.

- [ ] **Step 3: Write the minimal `src/mux.ts`.**

Create `relay/src/mux.ts`:

```ts
import type { Socket } from "node:net";

/**
 * Per-tunnel stream registry. Maps a monotonically allocated streamId to the
 * proxy client's net.Socket. streamId 0 is reserved for control frames, so
 * allocation begins at 1.
 */
export class Mux {
  private nextId = 1;
  private readonly streams = new Map<number, Socket>();

  /** Allocate a fresh streamId and register the client socket under it. */
  allocate(socket: Socket): number {
    let id = this.nextId++;
    // Wrap past the 32-bit space and never hand out 0 (reserved for control).
    if (this.nextId > 0xffffffff) this.nextId = 1;
    while (id === 0 || this.streams.has(id)) {
      id = this.nextId++;
      if (this.nextId > 0xffffffff) this.nextId = 1;
    }
    this.streams.set(id, socket);
    return id;
  }

  /** Look up the socket for a streamId, or undefined if none. */
  get(id: number): Socket | undefined {
    return this.streams.get(id);
  }

  /** Remove a stream from the registry. Returns the socket if it existed. */
  delete(id: number): Socket | undefined {
    const sock = this.streams.get(id);
    this.streams.delete(id);
    return sock;
  }

  /** Number of active streams. */
  get size(): number {
    return this.streams.size;
  }

  /** All currently registered stream ids. */
  ids(): number[] {
    return [...this.streams.keys()];
  }
}
```

- [ ] **Step 4: Run the test (expect PASS).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/mux.test.ts
```

Expected: `Tests  2 passed (2)`.

- [ ] **Step 5: Add failing tests for routing DATA, CLOSE, and full cleanup.**

Append to `relay/test/mux.test.ts`:

```ts
describe("Mux routing", () => {
  it("routeData writes payload to the matching socket", () => {
    const mux = new Mux();
    const sock = fakeSocket();
    const id = mux.allocate(sock as any);
    const ok = mux.routeData(id, Buffer.from([9, 8, 7]));
    expect(ok).toBe(true);
    expect(sock.writes.length).toBe(1);
    expect(Buffer.compare(sock.writes[0], Buffer.from([9, 8, 7]))).toBe(0);
  });

  it("routeData returns false for an unknown stream", () => {
    const mux = new Mux();
    expect(mux.routeData(999, Buffer.from([1]))).toBe(false);
  });

  it("routeClose ends the socket and removes the stream", () => {
    const mux = new Mux();
    const sock = fakeSocket();
    const id = mux.allocate(sock as any);
    const closed = mux.routeClose(id);
    expect(closed).toBe(true);
    expect(sock.destroyed).toBe(true);
    expect(mux.get(id)).toBeUndefined();
    expect(mux.size).toBe(0);
  });

  it("routeClose returns false for an unknown stream", () => {
    const mux = new Mux();
    expect(mux.routeClose(123)).toBe(false);
  });

  it("destroyAll ends every socket and empties the registry", () => {
    const mux = new Mux();
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    mux.allocate(s1 as any);
    mux.allocate(s2 as any);
    mux.destroyAll();
    expect(s1.destroyed).toBe(true);
    expect(s2.destroyed).toBe(true);
    expect(mux.size).toBe(0);
  });
});
```

- [ ] **Step 6: Run the test (expect FAIL — methods undefined).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/mux.test.ts
```

Expected FAIL message: `mux.routeData is not a function`.

- [ ] **Step 7: Add the routing methods to `src/mux.ts`.**

Append the following methods inside the `Mux` class in `relay/src/mux.ts` (place them before the closing brace of the class, after the `ids()` method):

```ts
  /** Write DATA payload to the client socket for a stream. */
  routeData(id: number, payload: Buffer): boolean {
    const sock = this.streams.get(id);
    if (!sock || sock.destroyed) return false;
    sock.write(payload);
    return true;
  }

  /** Tear down a stream: end its socket and drop it from the registry. */
  routeClose(id: number): boolean {
    const sock = this.streams.get(id);
    if (!sock) return false;
    this.streams.delete(id);
    if (!sock.destroyed) sock.end();
    return true;
  }

  /** Destroy every stream's socket and clear the registry. */
  destroyAll(): void {
    for (const sock of this.streams.values()) {
      if (!sock.destroyed) sock.destroy();
    }
    this.streams.clear();
  }
```

- [ ] **Step 8: Run the test (expect PASS).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/mux.test.ts
```

Expected: `Tests  7 passed (7)`.

- [ ] **Step 9: Commit.**

```bash
cd /home/hubextech/tetherproxy/relay
git add src/mux.ts test/mux.test.ts
git commit -m "feat(relay): per-tunnel stream multiplexer with lifecycle routing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Proxy auth (`src/auth.ts`)

**Files:**
- Create: `relay/src/auth.ts`
- Test: `relay/test/auth.test.ts`

- [ ] **Step 1: Write the failing test for bcrypt hash/verify.**

Create `relay/test/auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth.js";

describe("password hashing", () => {
  it("hashes then verifies the correct password", async () => {
    const hash = await hashPassword("s3cret-pw");
    expect(hash).not.toBe("s3cret-pw");
    expect(hash.startsWith("$2")).toBe(true);
    expect(await verifyPassword("s3cret-pw", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("s3cret-pw");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL — module missing).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/auth.test.ts
```

Expected FAIL message: `Failed to resolve import "../src/auth.js"`.

- [ ] **Step 3: Write the minimal `src/auth.ts` with hashing.**

Create `relay/src/auth.ts`:

```ts
import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 10;

/** Hash a plaintext proxy password with bcrypt. */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/** Verify a plaintext password against a bcrypt hash. */
export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
```

- [ ] **Step 4: Run the test (expect PASS).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/auth.test.ts
```

Expected: `Tests  2 passed (2)`.

- [ ] **Step 5: Add failing tests for parsing the Proxy-Authorization header and building the 407.**

Append to `relay/test/auth.test.ts`:

```ts
import { parseProxyAuthorization, buildProxyAuthRequired } from "../src/auth.js";

describe("parseProxyAuthorization", () => {
  it("parses a valid Basic header", () => {
    const creds = Buffer.from("alice:p@ss:word", "utf8").toString("base64");
    const out = parseProxyAuthorization(`Basic ${creds}`);
    expect(out).toEqual({ username: "alice", password: "p@ss:word" });
  });

  it("returns null for a missing header", () => {
    expect(parseProxyAuthorization(undefined)).toBeNull();
  });

  it("returns null for a non-Basic scheme", () => {
    expect(parseProxyAuthorization("Bearer abc123")).toBeNull();
  });

  it("returns null when base64 has no colon", () => {
    const creds = Buffer.from("nocolon", "utf8").toString("base64");
    expect(parseProxyAuthorization(`Basic ${creds}`)).toBeNull();
  });

  it("returns null for an empty credential", () => {
    expect(parseProxyAuthorization("Basic ")).toBeNull();
  });

  it("is case-insensitive on the scheme keyword", () => {
    const creds = Buffer.from("bob:pw", "utf8").toString("base64");
    expect(parseProxyAuthorization(`basic ${creds}`)).toEqual({
      username: "bob",
      password: "pw",
    });
  });
});

describe("buildProxyAuthRequired", () => {
  it("builds a 407 response with the Proxy-Authenticate header", () => {
    const res = buildProxyAuthRequired();
    const text = res.toString("utf8");
    expect(text).toContain("HTTP/1.1 407 Proxy Authentication Required");
    expect(text).toContain('Proxy-Authenticate: Basic realm="TetherProxy"');
    expect(text).toContain("Content-Length: 0");
    expect(text.endsWith("\r\n\r\n")).toBe(true);
  });
});
```

- [ ] **Step 6: Run the test (expect FAIL — functions undefined).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/auth.test.ts
```

Expected FAIL message: `No "parseProxyAuthorization" export is defined`.

- [ ] **Step 7: Add the header parser and 407 builder to `src/auth.ts`.**

Append to `relay/src/auth.ts`:

```ts
export interface BasicCredentials {
  username: string;
  password: string;
}

/**
 * Parse a "Proxy-Authorization: Basic <base64>" header value into
 * {username, password}. Returns null if absent, not Basic, or malformed.
 * Only the first colon separates username from password (passwords may
 * contain colons).
 */
export function parseProxyAuthorization(
  header: string | undefined,
): BasicCredentials | null {
  if (!header) return null;
  const trimmed = header.trim();
  const sp = trimmed.indexOf(" ");
  if (sp === -1) return null;
  const scheme = trimmed.slice(0, sp);
  const value = trimmed.slice(sp + 1).trim();
  if (scheme.toLowerCase() !== "basic") return null;
  if (value.length === 0) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  const username = decoded.slice(0, colon);
  const password = decoded.slice(colon + 1);
  if (username.length === 0) return null;
  return { username, password };
}

/** Build a raw HTTP 407 Proxy Authentication Required response. */
export function buildProxyAuthRequired(): Buffer {
  const body =
    "HTTP/1.1 407 Proxy Authentication Required\r\n" +
    'Proxy-Authenticate: Basic realm="TetherProxy"\r\n' +
    "Content-Length: 0\r\n" +
    "Connection: close\r\n" +
    "\r\n";
  return Buffer.from(body, "utf8");
}
```

- [ ] **Step 8: Run the test (expect PASS).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/auth.test.ts
```

Expected: `Tests  10 passed (10)`.

- [ ] **Step 9: Commit.**

```bash
cd /home/hubextech/tetherproxy/relay
git add src/auth.ts test/auth.test.ts
git commit -m "feat(relay): bcrypt password hashing + proxy Basic-auth parsing/407

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Credential store (`src/store.ts`)

**Files:**
- Create: `relay/src/store.ts`
- Test: `relay/test/store.test.ts`

Persists `{ deviceId, proxyUsername, bcryptPassword, createdAt }`. Lookup by username; upsert on re-pair. Uses better-sqlite3; tests use an in-memory database (path `:memory:`).

- [ ] **Step 1: Write the failing test for upsert + lookup.**

Create `relay/test/store.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { Store, type DeviceRecord } from "../src/store.js";

let store: Store | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

describe("Store upsert + lookup", () => {
  it("inserts a device and looks it up by username", () => {
    store = new Store(":memory:");
    store.upsertDevice({
      deviceId: "dev-1",
      proxyUsername: "alice",
      bcryptPassword: "$2a$10$hashhashhash",
    });
    const rec = store.findByUsername("alice");
    expect(rec).not.toBeNull();
    expect((rec as DeviceRecord).deviceId).toBe("dev-1");
    expect((rec as DeviceRecord).proxyUsername).toBe("alice");
    expect((rec as DeviceRecord).bcryptPassword).toBe("$2a$10$hashhashhash");
    expect(typeof (rec as DeviceRecord).createdAt).toBe("number");
  });

  it("returns null for an unknown username", () => {
    store = new Store(":memory:");
    expect(store.findByUsername("nobody")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL — module missing).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/store.test.ts
```

Expected FAIL message: `Failed to resolve import "../src/store.js"`.

- [ ] **Step 3: Write the minimal `src/store.ts`.**

Create `relay/src/store.ts`:

```ts
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface DeviceRecord {
  deviceId: string;
  proxyUsername: string;
  bcryptPassword: string;
  createdAt: number;
}

export interface UpsertInput {
  deviceId: string;
  proxyUsername: string;
  bcryptPassword: string;
}

/**
 * Persistent device + credential store backed by better-sqlite3.
 * Pass ":memory:" for tests, or a file path on a Docker volume in production.
 */
export class Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        deviceId       TEXT PRIMARY KEY,
        proxyUsername  TEXT NOT NULL UNIQUE,
        bcryptPassword TEXT NOT NULL,
        createdAt      INTEGER NOT NULL
      );
    `);
  }

  /**
   * Insert or update a device. Re-pairing the same deviceId replaces its
   * username and password. createdAt is preserved on update.
   */
  upsertDevice(input: UpsertInput): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO devices (deviceId, proxyUsername, bcryptPassword, createdAt)
      VALUES (@deviceId, @proxyUsername, @bcryptPassword, @createdAt)
      ON CONFLICT(deviceId) DO UPDATE SET
        proxyUsername  = excluded.proxyUsername,
        bcryptPassword = excluded.bcryptPassword
    `);
    stmt.run({
      deviceId: input.deviceId,
      proxyUsername: input.proxyUsername,
      bcryptPassword: input.bcryptPassword,
      createdAt: now,
    });
  }

  /** Find a device by its proxy username, or null if absent. */
  findByUsername(username: string): DeviceRecord | null {
    const row = this.db
      .prepare(
        `SELECT deviceId, proxyUsername, bcryptPassword, createdAt
         FROM devices WHERE proxyUsername = ?`,
      )
      .get(username) as DeviceRecord | undefined;
    return row ?? null;
  }

  /** Find a device by its deviceId, or null if absent. */
  findByDeviceId(deviceId: string): DeviceRecord | null {
    const row = this.db
      .prepare(
        `SELECT deviceId, proxyUsername, bcryptPassword, createdAt
         FROM devices WHERE deviceId = ?`,
      )
      .get(deviceId) as DeviceRecord | undefined;
    return row ?? null;
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run the test (expect PASS).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/store.test.ts
```

Expected: `Tests  2 passed (2)`.

- [ ] **Step 5: Add failing tests for re-pair upsert behavior and deviceId lookup.**

Append to `relay/test/store.test.ts`:

```ts
describe("Store re-pair (upsert on conflict)", () => {
  it("replaces username and password when the same deviceId re-pairs", () => {
    store = new Store(":memory:");
    store.upsertDevice({
      deviceId: "dev-1",
      proxyUsername: "alice",
      bcryptPassword: "$2a$10$old",
    });
    const first = store.findByDeviceId("dev-1") as DeviceRecord;
    store.upsertDevice({
      deviceId: "dev-1",
      proxyUsername: "alice2",
      bcryptPassword: "$2a$10$new",
    });
    expect(store.findByUsername("alice")).toBeNull();
    const rec = store.findByUsername("alice2") as DeviceRecord;
    expect(rec.deviceId).toBe("dev-1");
    expect(rec.bcryptPassword).toBe("$2a$10$new");
    // createdAt preserved across the re-pair.
    expect(rec.createdAt).toBe(first.createdAt);
  });

  it("looks up by deviceId", () => {
    store = new Store(":memory:");
    store.upsertDevice({
      deviceId: "dev-9",
      proxyUsername: "carol",
      bcryptPassword: "$2a$10$x",
    });
    const rec = store.findByDeviceId("dev-9") as DeviceRecord;
    expect(rec.proxyUsername).toBe("carol");
    expect(store.findByDeviceId("missing")).toBeNull();
  });
});
```

- [ ] **Step 6: Run the test (expect FAIL on the createdAt-preserved assertion).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/store.test.ts
```

Expected FAIL message: the `createdAt preserved` assertion fails because the current `ON CONFLICT` clause does not set createdAt at all, but the value is fine — actually the insert always uses `now`. Re-examine: on first insert createdAt = now1; on update createdAt is NOT in the SET list, so it is preserved. If timers are too coarse the test may pass spuriously. To make the FAIL deterministic, first run will currently PASS this block. If it passes, proceed to Step 7 as a no-op confirmation; the assertions document the contract.

> Note: the `upsertDevice` implementation from Step 3 already preserves `createdAt` (it is omitted from the `DO UPDATE SET`). This step's tests therefore PASS immediately and lock in that behavior. Confirm the green run.

- [ ] **Step 7: Confirm PASS (behavior already implemented in Step 3).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/store.test.ts
```

Expected: `Tests  4 passed (4)`.

- [ ] **Step 8: Add a failing test for on-disk persistence across reopen.**

Append to `relay/test/store.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Store on-disk persistence", () => {
  it("persists data across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-store-"));
    const path = join(dir, "nested", "store.db");
    try {
      const s1 = new Store(path);
      s1.upsertDevice({
        deviceId: "dev-p",
        proxyUsername: "dave",
        bcryptPassword: "$2a$10$persist",
      });
      s1.close();
      const s2 = new Store(path);
      const rec = s2.findByUsername("dave") as DeviceRecord;
      expect(rec.deviceId).toBe("dev-p");
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 9: Run the test (expect PASS — confirms `mkdirSync` + file backing work).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/store.test.ts
```

Expected: `Tests  5 passed (5)`.

- [ ] **Step 10: Commit.**

```bash
cd /home/hubextech/tetherproxy/relay
git add src/store.ts test/store.test.ts
git commit -m "feat(relay): better-sqlite3 device+credential store with re-pair upsert

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Config (`src/config.ts`)

**Files:**
- Create: `relay/src/config.ts`
- Test: `relay/test/config.test.ts`

- [ ] **Step 1: Write the failing test for env parsing with defaults.**

Create `relay/test/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults when only PAIRING_TOKEN is set", () => {
    const cfg = loadConfig({ PAIRING_TOKEN: "tok" });
    expect(cfg.pairingToken).toBe("tok");
    expect(cfg.proxyPort).toBe(8080);
    expect(cfg.proxyTlsPort).toBeUndefined();
    expect(cfg.tunnelPort).toBe(8443);
    expect(cfg.allowedClientCidrs).toEqual([]);
    expect(cfg.dataDir).toBe("/data");
    expect(cfg.certDir).toBe("/certs");
    expect(cfg.rateLimit).toEqual({
      maxTotal: 512,
      maxPerIp: 64,
      maxNewPerMin: 120,
      windowMs: 60000,
    });
  });

  it("throws when PAIRING_TOKEN is missing", () => {
    expect(() => loadConfig({})).toThrow(/PAIRING_TOKEN/);
  });

  it("parses overrides for every field", () => {
    const cfg = loadConfig({
      PAIRING_TOKEN: "tok",
      PROXY_PORT: "9090",
      PROXY_TLS_PORT: "9091",
      TUNNEL_PORT: "9443",
      ALLOWED_CLIENT_CIDRS: "10.0.0.0/8, 192.168.1.0/24",
      DATA_DIR: "/var/data",
      CERT_DIR: "/var/certs",
      TLS_CERT_PATH: "/var/certs/c.pem",
      TLS_KEY_PATH: "/var/certs/k.pem",
      RATE_LIMIT_MAX_TOTAL: "1000",
      RATE_LIMIT_MAX_PER_IP: "128",
      RATE_LIMIT_MAX_NEW_PER_MIN: "300",
      RATE_LIMIT_WINDOW_MS: "30000",
    });
    expect(cfg.proxyPort).toBe(9090);
    expect(cfg.proxyTlsPort).toBe(9091);
    expect(cfg.tunnelPort).toBe(9443);
    expect(cfg.allowedClientCidrs).toEqual(["10.0.0.0/8", "192.168.1.0/24"]);
    expect(cfg.dataDir).toBe("/var/data");
    expect(cfg.certDir).toBe("/var/certs");
    expect(cfg.tlsCertPath).toBe("/var/certs/c.pem");
    expect(cfg.tlsKeyPath).toBe("/var/certs/k.pem");
    expect(cfg.rateLimit).toEqual({
      maxTotal: 1000,
      maxPerIp: 128,
      maxNewPerMin: 300,
      windowMs: 30000,
    });
  });

  it("throws on a non-numeric port", () => {
    expect(() => loadConfig({ PAIRING_TOKEN: "tok", PROXY_PORT: "abc" })).toThrow(
      /PROXY_PORT/,
    );
  });

  it("throws on a non-numeric rate-limit value", () => {
    expect(() =>
      loadConfig({ PAIRING_TOKEN: "tok", RATE_LIMIT_MAX_TOTAL: "abc" }),
    ).toThrow(/RATE_LIMIT_MAX_TOTAL/);
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL — module missing).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/config.test.ts
```

Expected FAIL message: `Failed to resolve import "../src/config.js"`.

- [ ] **Step 3: Write the minimal `src/config.ts`.**

Create `relay/src/config.ts`:

```ts
export interface RateLimitConfig {
  maxTotal: number;
  maxPerIp: number;
  maxNewPerMin: number;
  windowMs: number;
}

export interface Config {
  pairingToken: string;
  proxyPort: number;
  proxyTlsPort: number | undefined;
  tunnelPort: number;
  allowedClientCidrs: string[];
  dataDir: string;
  certDir: string;
  tlsCertPath: string;
  tlsKeyPath: string;
  rateLimit: RateLimitConfig;
}

function parsePort(raw: string | undefined, name: string, def: number): number {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} must be an integer 1-65535, got "${raw}"`);
  }
  return n;
}

function parsePositiveInt(
  raw: string | undefined,
  name: string,
  def: number,
): number {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

function parseOptionalPort(
  raw: string | undefined,
  name: string,
): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} must be an integer 1-65535, got "${raw}"`);
  }
  return n;
}

/** Parse environment variables (defaults to process.env) into a Config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const pairingToken = env.PAIRING_TOKEN;
  if (!pairingToken || pairingToken.length === 0) {
    throw new Error("PAIRING_TOKEN is required");
  }
  const dataDir = env.DATA_DIR || "/data";
  const certDir = env.CERT_DIR || "/certs";
  const allowedClientCidrs = (env.ALLOWED_CLIENT_CIDRS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    pairingToken,
    proxyPort: parsePort(env.PROXY_PORT, "PROXY_PORT", 8080),
    proxyTlsPort: parseOptionalPort(env.PROXY_TLS_PORT, "PROXY_TLS_PORT"),
    tunnelPort: parsePort(env.TUNNEL_PORT, "TUNNEL_PORT", 8443),
    allowedClientCidrs,
    dataDir,
    certDir,
    tlsCertPath: env.TLS_CERT_PATH || `${certDir}/tunnel-cert.pem`,
    tlsKeyPath: env.TLS_KEY_PATH || `${certDir}/tunnel-key.pem`,
    rateLimit: {
      maxTotal: parsePositiveInt(
        env.RATE_LIMIT_MAX_TOTAL,
        "RATE_LIMIT_MAX_TOTAL",
        512,
      ),
      maxPerIp: parsePositiveInt(
        env.RATE_LIMIT_MAX_PER_IP,
        "RATE_LIMIT_MAX_PER_IP",
        64,
      ),
      maxNewPerMin: parsePositiveInt(
        env.RATE_LIMIT_MAX_NEW_PER_MIN,
        "RATE_LIMIT_MAX_NEW_PER_MIN",
        120,
      ),
      windowMs: parsePositiveInt(
        env.RATE_LIMIT_WINDOW_MS,
        "RATE_LIMIT_WINDOW_MS",
        60000,
      ),
    },
  };
}
```

- [ ] **Step 4: Run the test (expect PASS).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/config.test.ts
```

Expected: `Tests  5 passed (5)`.

- [ ] **Step 5: Commit.**

```bash
cd /home/hubextech/tetherproxy/relay
git add src/config.ts test/config.test.ts
git commit -m "feat(relay): env config parsing with defaults, rate-limit caps, and validation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Connection limiter (`src/rateLimiter.ts`)

**Files:**
- Create: `relay/src/rateLimiter.ts`
- Test: `relay/test/rateLimiter.test.ts`

A pure, unit-testable connection limiter. It tracks the global active connection count and per-IP active counts, and enforces a fixed-window per-IP new-connection rate limit. The clock is injected (`now: () => number`) so window-reset behavior is deterministic in tests. The proxy server (Task 10) calls `tryAcquire(ip)` on each new connection and `release(ip)` when the connection closes.

- [ ] **Step 1: Write the failing test for the per-IP active cap and release.**

Create `relay/test/rateLimiter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ConnectionLimiter } from "../src/rateLimiter.js";

describe("ConnectionLimiter per-IP active cap", () => {
  it("rejects with 'per-ip cap' once an IP reaches maxPerIp active", () => {
    let t = 0;
    const lim = new ConnectionLimiter({
      maxTotal: 100,
      maxPerIp: 2,
      maxNewPerMin: 100,
      windowMs: 60000,
      now: () => t,
    });
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
    expect(lim.tryAcquire("1.1.1.1")).toEqual({
      ok: false,
      reason: "per-ip cap",
    });
    // A different IP is unaffected.
    expect(lim.tryAcquire("2.2.2.2")).toEqual({ ok: true });
  });

  it("release decrements active and frees a slot (never below 0)", () => {
    let t = 0;
    const lim = new ConnectionLimiter({
      maxTotal: 100,
      maxPerIp: 1,
      maxNewPerMin: 100,
      windowMs: 60000,
      now: () => t,
    });
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
    expect(lim.tryAcquire("1.1.1.1")).toEqual({
      ok: false,
      reason: "per-ip cap",
    });
    lim.release("1.1.1.1");
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
    // Extra releases must not underflow.
    lim.release("1.1.1.1");
    lim.release("1.1.1.1");
    lim.release("1.1.1.1");
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL — module missing).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/rateLimiter.test.ts
```

Expected FAIL message: `Failed to resolve import "../src/rateLimiter.js"`.

- [ ] **Step 3: Write the minimal `src/rateLimiter.ts`.**

Create `relay/src/rateLimiter.ts`:

```ts
export interface ConnectionLimiterOptions {
  /** Maximum total active connections across all IPs. */
  maxTotal?: number;
  /** Maximum active connections from any single IP. */
  maxPerIp?: number;
  /** Maximum new connections per IP within one fixed window. */
  maxNewPerMin?: number;
  /** Fixed-window length in milliseconds. */
  windowMs?: number;
  /** Injectable monotonic-ish clock (defaults to Date.now). */
  now?: () => number;
}

export interface AcquireResult {
  ok: boolean;
  reason?: string;
}

interface IpState {
  /** Currently active connections from this IP. */
  active: number;
  /** New-connection count within the current window. */
  windowCount: number;
  /** Start timestamp (ms) of the current fixed window. */
  windowStart: number;
}

/**
 * Pure connection limiter for the proxy front end. Tracks global + per-IP
 * active connection counts and a fixed-window per-IP new-connection rate.
 * No timers and no I/O: the clock is injected so tests are deterministic.
 */
export class ConnectionLimiter {
  private readonly maxTotal: number;
  private readonly maxPerIp: number;
  private readonly maxNewPerMin: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private totalActive = 0;
  private readonly ips = new Map<string, IpState>();

  constructor(opts: ConnectionLimiterOptions = {}) {
    this.maxTotal = opts.maxTotal ?? 512;
    this.maxPerIp = opts.maxPerIp ?? 64;
    this.maxNewPerMin = opts.maxNewPerMin ?? 120;
    this.windowMs = opts.windowMs ?? 60000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Attempt to admit a new connection from `ip`. On success the global and
   * per-IP active counts are incremented and the caller MUST eventually call
   * release(ip). On failure nothing is mutated and a reason is returned.
   */
  tryAcquire(ip: string): AcquireResult {
    if (this.totalActive >= this.maxTotal) {
      return { ok: false, reason: "global cap" };
    }
    const state = this.getState(ip);
    if (state.active >= this.maxPerIp) {
      return { ok: false, reason: "per-ip cap" };
    }
    const t = this.now();
    if (t - state.windowStart >= this.windowMs) {
      state.windowStart = t;
      state.windowCount = 0;
    }
    if (state.windowCount >= this.maxNewPerMin) {
      return { ok: false, reason: "rate limit" };
    }
    state.active += 1;
    state.windowCount += 1;
    this.totalActive += 1;
    return { ok: true };
  }

  /** Release one active connection for `ip`. Never decrements below 0. */
  release(ip: string): void {
    const state = this.ips.get(ip);
    if (!state) return;
    if (state.active > 0) {
      state.active -= 1;
      if (this.totalActive > 0) this.totalActive -= 1;
    }
    // Drop fully-idle, expired entries to bound memory.
    if (state.active === 0 && this.now() - state.windowStart >= this.windowMs) {
      this.ips.delete(ip);
    }
  }

  private getState(ip: string): IpState {
    let state = this.ips.get(ip);
    if (!state) {
      state = { active: 0, windowCount: 0, windowStart: this.now() };
      this.ips.set(ip, state);
    }
    return state;
  }
}
```

- [ ] **Step 4: Run the test (expect PASS).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/rateLimiter.test.ts
```

Expected: `Tests  2 passed (2)`.

- [ ] **Step 5: Add failing tests for the global cap and fixed-window reset.**

Append to `relay/test/rateLimiter.test.ts`:

```ts
describe("ConnectionLimiter global cap", () => {
  it("rejects with 'global cap' once total active reaches maxTotal", () => {
    let t = 0;
    const lim = new ConnectionLimiter({
      maxTotal: 2,
      maxPerIp: 100,
      maxNewPerMin: 100,
      windowMs: 60000,
      now: () => t,
    });
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
    expect(lim.tryAcquire("2.2.2.2")).toEqual({ ok: true });
    expect(lim.tryAcquire("3.3.3.3")).toEqual({
      ok: false,
      reason: "global cap",
    });
    // Freeing a slot lets the next IP in.
    lim.release("1.1.1.1");
    expect(lim.tryAcquire("3.3.3.3")).toEqual({ ok: true });
  });
});

describe("ConnectionLimiter fixed-window rate limit", () => {
  it("rejects with 'rate limit' after maxNewPerMin in a window, then resets", () => {
    let t = 1000;
    const lim = new ConnectionLimiter({
      maxTotal: 100,
      maxPerIp: 100,
      maxNewPerMin: 2,
      windowMs: 60000,
      now: () => t,
    });
    // Two new connections allowed in the window...
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
    // ...the third is rate-limited even after the actives are released.
    lim.release("1.1.1.1");
    lim.release("1.1.1.1");
    expect(lim.tryAcquire("1.1.1.1")).toEqual({
      ok: false,
      reason: "rate limit",
    });
    // Advance the clock past windowMs: the window resets and new conns flow.
    t += 60000;
    expect(lim.tryAcquire("1.1.1.1")).toEqual({ ok: true });
  });
});
```

- [ ] **Step 6: Run the test (expect PASS — behavior implemented in Step 3).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/rateLimiter.test.ts
```

Expected: `Tests  4 passed (4)`.

- [ ] **Step 7: Commit.**

```bash
cd /home/hubextech/tetherproxy/relay
git add src/rateLimiter.ts test/rateLimiter.test.ts
git commit -m "feat(relay): pure connection limiter with global/per-IP caps + rate limit

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: TLS cert generation (`src/tls.ts`)

**Files:**
- Create: `relay/src/tls.ts`
- Test: `relay/test/tls.test.ts`

Generates a self-signed cert on first boot using `selfsigned`, persists it, and computes the SHA-256 fingerprint (for phone pinning). On subsequent boots it loads the existing cert.

- [ ] **Step 1: Write the failing test for fingerprint computation.**

Create `relay/test/tls.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintSha256, ensureCert } from "../src/tls.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "tp-tls-"));
  dirs.push(d);
  return d;
}

describe("fingerprintSha256", () => {
  it("formats a 32-byte digest as colon-separated uppercase hex", () => {
    const certPem =
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    const fp = fingerprintSha256(certPem);
    expect(fp).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL — module missing).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/tls.test.ts
```

Expected FAIL message: `Failed to resolve import "../src/tls.js"`.

- [ ] **Step 3: Write the minimal `src/tls.ts`.**

Create `relay/src/tls.ts`:

```ts
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import selfsigned from "selfsigned";

export interface TlsMaterial {
  cert: string;
  key: string;
  fingerprint: string;
}

/**
 * Compute the SHA-256 fingerprint of a PEM certificate, formatted as
 * colon-separated uppercase hex (the form a phone pins against).
 */
export function fingerprintSha256(certPem: string): string {
  const der = pemToDer(certPem);
  const digest = createHash("sha256").update(der).digest("hex").toUpperCase();
  return digest.match(/.{2}/g)!.join(":");
}

function pemToDer(pem: string): Buffer {
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s+/g, "");
  return Buffer.from(b64, "base64");
}

/**
 * Load existing TLS material from certPath/keyPath, or generate a fresh
 * self-signed cert (valid 10 years) on first boot and persist it.
 * Returns cert, key, and the SHA-256 fingerprint.
 */
export function ensureCert(certPath: string, keyPath: string): TlsMaterial {
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, "utf8");
    const key = readFileSync(keyPath, "utf8");
    return { cert, key, fingerprint: fingerprintSha256(cert) };
  }
  const attrs = [{ name: "commonName", value: "tetherproxy-relay" }];
  const pems = selfsigned.generate(attrs, {
    keySize: 2048,
    days: 3650,
    algorithm: "sha256",
  });
  mkdirSync(dirname(certPath), { recursive: true });
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(certPath, pems.cert, { mode: 0o644 });
  writeFileSync(keyPath, pems.private, { mode: 0o600 });
  return {
    cert: pems.cert,
    key: pems.private,
    fingerprint: fingerprintSha256(pems.cert),
  };
}
```

- [ ] **Step 4: Run the fingerprint test (expect PASS).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/tls.test.ts
```

Expected: `Tests  1 passed (1)`.

- [ ] **Step 5: Add failing tests for `ensureCert` generation, persistence, and idempotency.**

Append to `relay/test/tls.test.ts`:

```ts
describe("ensureCert", () => {
  it("generates and persists a cert on first call", () => {
    const dir = freshDir();
    const certPath = join(dir, "c", "cert.pem");
    const keyPath = join(dir, "c", "key.pem");
    const mat = ensureCert(certPath, keyPath);
    expect(mat.cert).toContain("BEGIN CERTIFICATE");
    expect(mat.key).toContain("PRIVATE KEY");
    expect(mat.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(existsSync(certPath)).toBe(true);
    expect(existsSync(keyPath)).toBe(true);
  });

  it("returns the same cert + fingerprint on a second call (no regen)", () => {
    const dir = freshDir();
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");
    const first = ensureCert(certPath, keyPath);
    const second = ensureCert(certPath, keyPath);
    expect(second.cert).toBe(first.cert);
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});
```

- [ ] **Step 6: Run the test (expect PASS — behavior implemented in Step 3).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/tls.test.ts
```

Expected: `Tests  3 passed (3)`.

- [ ] **Step 7: Commit.**

```bash
cd /home/hubextech/tetherproxy/relay
git add src/tls.ts test/tls.test.ts
git commit -m "feat(relay): self-signed TLS cert generation + SHA-256 fingerprint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Tunnel server (`src/tunnelServer.ts`)

**Files:**
- Create: `relay/src/tunnelServer.ts`
- Test: `relay/test/tunnelServer.test.ts`

A WSS server on `TUNNEL_PORT`. On connect it expects an AUTH frame, verifies the `pairingToken`, upserts creds via the store, marks the device live, and maintains a ~25s PING/PONG heartbeat. The server exposes a `getLiveTunnel()` registry the proxy server uses to find a live phone, plus a Mux per tunnel.

Tests connect with a real `ws` client over plain `ws://` (TLS is configured at the `index.ts` wiring layer; the server accepts an injected `http.Server`/`https.Server`), so the test harness passes a plain HTTP server. To keep the heartbeat test fast, the interval is injectable.

- [ ] **Step 1: Write the failing test: AUTH_OK on valid token + device becomes live.**

Create `relay/test/tunnelServer.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test (expect FAIL — module missing).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/tunnelServer.test.ts
```

Expected FAIL message: `Failed to resolve import "../src/tunnelServer.js"`.

- [ ] **Step 3: Write `src/tunnelServer.ts`.**

Create `relay/src/tunnelServer.ts`:

```ts
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

/**
 * A single authenticated phone connection: its socket, its stream multiplexer,
 * and identifying metadata. The proxy server uses `mux` and `send`.
 */
export class Tunnel {
  readonly mux = new Mux();
  constructor(
    readonly ws: WebSocket,
    readonly deviceId: string,
    readonly proxyUsername: string,
  ) {}

  /** Send a pre-encoded frame to the phone. */
  send(frame: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
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
  /** Tracks PONG liveness per authenticated socket. */
  private readonly alive = new WeakMap<WebSocket, boolean>();

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
        this.alive.set(tunnel.ws, true);
        break;
      case FrameType.PING:
        tunnel.send(encodeFrame(FrameType.PONG, 0));
        break;
      // OPEN_OK / OPEN_FAIL are consumed by the proxy server via per-stream
      // listeners it attaches; see proxyServer.ts. They are ignored here.
      default:
        break;
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.alive.set(ws, true);
    const timer = setInterval(() => {
      if (this.alive.get(ws) === false) {
        ws.terminate();
        clearInterval(timer);
        return;
      }
      this.alive.set(ws, false);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeFrame(FrameType.PING, 0));
      }
    }, this.heartbeatMs);
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
```

> Important: the proxy server (Task 10) needs to observe `OPEN_OK`/`OPEN_FAIL` per stream. We do that by exposing a way for it to register a one-shot listener. Update `handleAuthedFrame` to also dispatch OPEN_OK/OPEN_FAIL to per-stream resolvers. This is implemented in Step 9 below, after the heartbeat test, to keep steps bite-sized.

- [ ] **Step 4: Run the AUTH test (expect PASS).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/tunnelServer.test.ts
```

Expected: `Tests  1 passed (1)`.

- [ ] **Step 5: Add a failing test for AUTH_FAIL on a bad token.**

Append to `relay/test/tunnelServer.test.ts`:

```ts
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
```

Also add the import at the top of the test file (next to existing imports):

```ts
import { decodeJsonPayload } from "../src/frames.js";
```

- [ ] **Step 6: Run the test (expect PASS — behavior implemented in Step 3).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/tunnelServer.test.ts
```

Expected: `Tests  3 passed (3)`.

- [ ] **Step 7: Add a failing test for the PING/PONG heartbeat (fast interval).**

Append to `relay/test/tunnelServer.test.ts`:

```ts
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
```

- [ ] **Step 8: Run the test (expect PASS — heartbeat implemented in Step 3).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/tunnelServer.test.ts
```

Expected: `Tests  5 passed (5)`.

- [ ] **Step 9: Add per-stream OPEN_OK/OPEN_FAIL dispatch so the proxy server can await an OPEN result. First write the failing test.**

Append to `relay/test/tunnelServer.test.ts`:

```ts
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
```

- [ ] **Step 10: Run the test (expect FAIL — `waitOpen` undefined).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/tunnelServer.test.ts
```

Expected FAIL message: `t.waitOpen is not a function`.

- [ ] **Step 11: Implement `waitOpen` on `Tunnel` and route OPEN_OK/OPEN_FAIL into it.**

In `relay/src/tunnelServer.ts`, replace the entire `Tunnel` class with:

```ts
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
```

Then in `handleAuthedFrame`, add OPEN_OK / OPEN_FAIL cases (replace the existing `switch` body's `default` region by inserting these two cases before `default`):

```ts
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
```

- [ ] **Step 12: Run the test (expect PASS).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/tunnelServer.test.ts
```

Expected: `Tests  7 passed (7)`.

- [ ] **Step 13: Commit.**

```bash
cd /home/hubextech/tetherproxy/relay
git add src/tunnelServer.ts test/tunnelServer.test.ts
git commit -m "feat(relay): WSS tunnel server with AUTH, heartbeat, OPEN dispatch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Proxy server (`src/proxyServer.ts`)

**Files:**
- Create: `relay/src/proxyServer.ts`
- Test: `relay/test/proxyServer.test.ts`

A raw `net.Server` on `PROXY_PORT`. It reads the first request line + headers, validates Basic proxy-auth, finds the live tunnel, allocates a streamId, sends OPEN, awaits OPEN_OK/OPEN_FAIL, then pipes bytes via DATA frames. Handles both `CONNECT host:port` and absolute-URI plain HTTP.

Per-connection handling lives in a reusable exported function `handleProxyConnection(socket, deps)` so the same logic backs both the plain `net.Server` here and the TLS proxy listener wired in Task 11. Before reading any request the handler asks an injected `ConnectionLimiter` (Task 7) to admit the connection by remote IP; if rejected it replies `429 Too Many Requests` and destroys the socket, and it always `release`s the IP when the socket closes.

The server depends on the tunnel server only through a small interface (`getLiveTunnel()` returning a `Tunnel`), so tests inject a fake tunnel.

- [ ] **Step 1: Write the failing test scaffolding + a 407 test for missing auth.**

Create `relay/test/proxyServer.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test (expect FAIL — module missing).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/proxyServer.test.ts
```

Expected FAIL message: `Failed to resolve import "../src/proxyServer.js"`.

- [ ] **Step 3: Write `src/proxyServer.ts`.**

Create `relay/src/proxyServer.ts`:

```ts
import { createServer, type Server, type Socket } from "node:net";
import { Store } from "./store.js";
import {
  parseProxyAuthorization,
  buildProxyAuthRequired,
  verifyPassword,
} from "./auth.js";
import { Mux } from "./mux.js";
import { ConnectionLimiter } from "./rateLimiter.js";
import {
  FrameType,
  encodeFrame,
  encodeJsonFrame,
} from "./frames.js";

/** The subset of a Tunnel the proxy server depends on. */
export interface TunnelLike {
  readonly mux: Mux;
  send(frame: Buffer): void;
  waitOpen(streamId: number): Promise<{ ok: boolean; reason?: string }>;
}

export interface ProxyServerOptions {
  getLiveTunnel: () => TunnelLike | null;
  store: Store;
  allowedClientCidrs: string[];
  /** Optional connection limiter; one is created from defaults if omitted. */
  limiter?: ConnectionLimiter;
}

/**
 * The dependencies a single proxy connection needs. Shared verbatim by the
 * plain `net.Server` and the TLS proxy listener (Task 11).
 */
export interface ProxyDeps {
  getLiveTunnel: () => TunnelLike | null;
  store: Store;
  allowedClientCidrs: string[];
  limiter: ConnectionLimiter;
}

interface ParsedRequest {
  method: string;
  target: string;
  headers: Map<string, string>;
  raw: Buffer;
  headerEnd: number;
}

/**
 * Per-connection proxy handler shared by the plain `net.Server` and the TLS
 * proxy listener (Task 11). Applies the IP allowlist + connection limiter,
 * parses the request, validates Basic proxy-auth, finds the live tunnel, and
 * pipes bytes over a multiplexed stream. Always releases the limiter slot when
 * the socket closes.
 */
export function handleProxyConnection(sock: Socket, deps: ProxyDeps): void {
  sock.on("error", () => sock.destroy());

  // IP allowlist (CIDR) check before anything else.
  const ip = (sock.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (
    deps.allowedClientCidrs.length > 0 &&
    !ipAllowed(ip, deps.allowedClientCidrs)
  ) {
    sock.end(
      "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    return;
  }

  // Connection cap + rate limit. Reserve a slot and release it on close.
  const admit = deps.limiter.tryAcquire(ip);
  if (!admit.ok) {
    sock.end(
      "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    return;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    deps.limiter.release(ip);
  };
  sock.on("close", release);

  // Accumulate until we have a full header block.
  let buf = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf("\r\n\r\n");
    if (end === -1) {
      if (buf.length > 64 * 1024) {
        sock.off("data", onData);
        sock.end(
          "HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n",
        );
      }
      return;
    }
    sock.off("data", onData);
    const parsed = parseRequest(buf, end);
    void handleRequest(sock, parsed, deps);
  };
  sock.on("data", onData);
}

/**
 * Raw TCP proxy server. Wraps a `net.Server` whose connections are handled by
 * the shared `handleProxyConnection`. The TLS listener in `index.ts` calls
 * `handleProxyConnection` directly with the same deps.
 */
export class ProxyServer {
  private readonly server: Server;
  readonly deps: ProxyDeps;

  constructor(opts: ProxyServerOptions) {
    this.deps = {
      getLiveTunnel: opts.getLiveTunnel,
      store: opts.store,
      allowedClientCidrs: opts.allowedClientCidrs,
      limiter: opts.limiter ?? new ConnectionLimiter(),
    };
    this.server = createServer((sock) => handleProxyConnection(sock, this.deps));
  }

  /** Start listening; resolves with the bound port. */
  listen(port: number, host = "0.0.0.0"): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        const addr = this.server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  /** Stop the server. */
  close(): void {
    this.server.close();
  }
}

async function handleRequest(
  sock: Socket,
  req: ParsedRequest,
  deps: ProxyDeps,
): Promise<void> {
  // 1. Validate proxy auth.
  const creds = parseProxyAuthorization(req.headers.get("proxy-authorization"));
  if (!creds) {
    sock.end(buildProxyAuthRequired());
    return;
  }
  const rec = deps.store.findByUsername(creds.username);
  if (!rec || !(await verifyPassword(creds.password, rec.bcryptPassword))) {
    sock.end(buildProxyAuthRequired());
    return;
  }

  // 2. Find a live phone tunnel.
  const tunnel = deps.getLiveTunnel();
  if (!tunnel) {
    sock.end(
      "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    return;
  }

  if (req.method === "CONNECT") {
    await handleConnect(sock, req, tunnel);
  } else {
    await handleAbsoluteHttp(sock, req, tunnel);
  }
}

async function handleConnect(
  sock: Socket,
  req: ParsedRequest,
  tunnel: TunnelLike,
): Promise<void> {
  const target = parseHostPort(req.target, 443);
  if (!target) {
    sock.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const streamId = tunnel.mux.allocate(sock);
  const waiter = tunnel.waitOpen(streamId);
  tunnel.send(
    encodeJsonFrame(FrameType.OPEN, streamId, {
      host: target.host,
      port: target.port,
    }),
  );
  const result = await waiter;
  if (!result.ok) {
    tunnel.mux.delete(streamId);
    sock.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    return;
  }
  sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  pipeStream(sock, tunnel, streamId, Buffer.alloc(0));
}

async function handleAbsoluteHttp(
  sock: Socket,
  req: ParsedRequest,
  tunnel: TunnelLike,
): Promise<void> {
  // Absolute-form request target: METHOD http://host[:port]/path HTTP/1.1
  const m = /^https?:\/\/([^/]+)(\/.*)?$/i.exec(req.target);
  if (!m) {
    sock.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const target = parseHostPort(m[1], 80);
  if (!target) {
    sock.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const path = m[2] || "/";

  const streamId = tunnel.mux.allocate(sock);
  const waiter = tunnel.waitOpen(streamId);
  tunnel.send(
    encodeJsonFrame(FrameType.OPEN, streamId, {
      host: target.host,
      port: target.port,
    }),
  );
  const result = await waiter;
  if (!result.ok) {
    tunnel.mux.delete(streamId);
    sock.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    return;
  }

  // Rebuild the request in origin-form (strip the absolute URI, drop hop
  // headers) and forward it as the first DATA chunk, then pipe the rest.
  const rebuilt = rebuildOriginForm(req, path);
  pipeStream(sock, tunnel, streamId, rebuilt);
}

/**
 * Bidirectional pipe: client socket <-> phone tunnel stream.
 * `initial` is bytes already read from the client to forward immediately.
 */
function pipeStream(
  sock: Socket,
  tunnel: TunnelLike,
  streamId: number,
  initial: Buffer,
): void {
  if (initial.length > 0) {
    tunnel.send(encodeFrame(FrameType.DATA, streamId, initial));
  }
  sock.on("data", (chunk: Buffer) => {
    tunnel.send(encodeFrame(FrameType.DATA, streamId, chunk));
  });
  const teardown = () => {
    if (tunnel.mux.get(streamId)) {
      tunnel.mux.delete(streamId);
      tunnel.send(encodeFrame(FrameType.CLOSE, streamId));
    }
  };
  sock.on("close", teardown);
  sock.on("end", teardown);
  sock.on("error", () => {
    teardown();
    sock.destroy();
  });
}

function parseRequest(buf: Buffer, headerEnd: number): ParsedRequest {
  const headText = buf.subarray(0, headerEnd).toString("utf8");
  const lines = headText.split("\r\n");
  const [method, target] = lines[0].split(" ");
  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const c = line.indexOf(":");
    if (c === -1) continue;
    const k = line.slice(0, c).trim().toLowerCase();
    const v = line.slice(c + 1).trim();
    headers.set(k, v);
  }
  return { method, target, headers, raw: buf, headerEnd };
}

function parseHostPort(
  s: string,
  defaultPort: number,
): { host: string; port: number } | null {
  const idx = s.lastIndexOf(":");
  if (idx === -1) return { host: s, port: defaultPort };
  const host = s.slice(0, idx);
  const port = Number(s.slice(idx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (host.length === 0) return null;
  return { host, port };
}

const HOP_HEADERS = new Set([
  "proxy-authorization",
  "proxy-connection",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

function rebuildOriginForm(req: ParsedRequest, path: string): Buffer {
  const reqLine = `${req.method} ${path} HTTP/1.1\r\n`;
  let head = reqLine;
  for (const [k, v] of req.headers) {
    if (HOP_HEADERS.has(k)) continue;
    head += `${capitalizeHeader(k)}: ${v}\r\n`;
  }
  head += "Connection: close\r\n\r\n";
  // Include any body bytes that arrived after the header block.
  const body = req.raw.subarray(req.headerEnd + 4);
  return Buffer.concat([Buffer.from(head, "utf8"), body]);
}

function capitalizeHeader(name: string): string {
  return name
    .split("-")
    .map((p) => (p.length ? p[0].toUpperCase() + p.slice(1) : p))
    .join("-");
}

/** Check whether an IP is within any of the given CIDRs (IPv4 only, v1). */
export function ipAllowed(ip: string, cidrs: string[]): boolean {
  const addr = ip.replace(/^::ffff:/, "");
  const ipNum = ipv4ToInt(addr);
  if (ipNum === null) return false;
  for (const cidr of cidrs) {
    const [net, bitsRaw] = cidr.split("/");
    const bits = Number(bitsRaw);
    const netNum = ipv4ToInt(net);
    if (netNum === null || !Number.isInteger(bits)) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((ipNum & mask) === (netNum & mask)) return true;
  }
  return false;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}
```

- [ ] **Step 4: Run the 407 test (expect PASS).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/proxyServer.test.ts
```

Expected: `Tests  1 passed (1)`.

- [ ] **Step 5: Add a failing test for 503 when no live phone, and a full CONNECT happy path.**

Append to `relay/test/proxyServer.test.ts`:

```ts
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
    await new Promise((r) => setTimeout(r, 50));
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
```

- [ ] **Step 6: Run the test (expect PASS — implemented in Step 3).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/proxyServer.test.ts
```

Expected: `Tests  3 passed (3)`.

- [ ] **Step 7: Add a failing test for 502 on OPEN_FAIL and 407 on a wrong password.**

Append to `relay/test/proxyServer.test.ts`:

```ts
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
```

- [ ] **Step 8: Run the test (expect PASS — implemented in Step 3).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/proxyServer.test.ts
```

Expected: `Tests  5 passed (5)`.

- [ ] **Step 9: Add a failing test for absolute-URI plain HTTP forwarding.**

Append to `relay/test/proxyServer.test.ts`:

```ts
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
    await new Promise((r) => setTimeout(r, 60));

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
```

- [ ] **Step 10: Run the test (expect PASS — implemented in Step 3).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/proxyServer.test.ts
```

Expected: `Tests  6 passed (6)`.

- [ ] **Step 11: Add a failing unit test for the exported `ipAllowed` CIDR helper.**

Append to `relay/test/proxyServer.test.ts`:

```ts
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
```

- [ ] **Step 12: Run the test (expect PASS — `ipAllowed` implemented in Step 3).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/proxyServer.test.ts
```

Expected: `Tests  10 passed (10)`.

- [ ] **Step 13: Add a failing test that an injected limiter rejects with 429.**

Append to `relay/test/proxyServer.test.ts`:

```ts
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
```

- [ ] **Step 14: Run the test (expect PASS — limiter wiring implemented in Step 3).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/proxyServer.test.ts
```

Expected: `Tests  11 passed (11)`.

- [ ] **Step 15: Commit.**

```bash
cd /home/hubextech/tetherproxy/relay
git add src/proxyServer.ts test/proxyServer.test.ts
git commit -m "feat(relay): reusable handleProxyConnection with CONNECT, HTTP, auth, CIDR, rate limiting

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Wiring + graceful shutdown (`src/index.ts`)

**Files:**
- Create: `relay/src/index.ts`
- Test: covered by Task 12 integration test (index is the composition root; its parts are unit-tested individually). A focused boot test is added here.
- Test: `relay/test/index.test.ts`

`index.ts` wires config + TLS + store + tunnel server (over HTTPS on `TUNNEL_PORT`) + proxy server (`PROXY_PORT`, optional TLS proxy on `PROXY_TLS_PORT`) and handles SIGINT/SIGTERM graceful shutdown. To make it testable, the bootstrap logic lives in an exported `createRelay(config)` returning a handle with `start()`/`stop()`.

- [ ] **Step 1: Write the failing test that boots a relay on ephemeral ports and stops it.**

Create `relay/test/index.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelay, type Relay } from "../src/index.js";
import { loadConfig } from "../src/config.js";

let relay: Relay | null = null;
let dir: string | null = null;

afterEach(async () => {
  await relay?.stop();
  relay = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("createRelay", () => {
  it("starts on ephemeral ports and exposes the TLS fingerprint", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-relay-"));
    const cfg = loadConfig({
      PAIRING_TOKEN: "tok",
      PROXY_PORT: "0",
      TUNNEL_PORT: "0",
      DATA_DIR: join(dir, "data"),
      CERT_DIR: join(dir, "certs"),
    });
    relay = createRelay(cfg);
    const info = await relay.start();
    expect(info.proxyPort).toBeGreaterThan(0);
    expect(info.tunnelPort).toBeGreaterThan(0);
    expect(info.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    await relay.stop();
    relay = null;
  });
});
```

- [ ] **Step 2: Run the test (expect FAIL — module/exports missing).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/index.test.ts
```

Expected FAIL message: `Failed to resolve import "../src/index.js"` (or `No "createRelay" export`).

- [ ] **Step 3: Write `src/index.ts`.**

Create `relay/src/index.ts`:

```ts
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

// Run only when invoked directly (not when imported by tests).
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error("[relay] fatal:", err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the test (expect PASS).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/index.test.ts
```

Expected: `Tests  1 passed (1)`.

- [ ] **Step 5: Add a failing test that the optional TLS proxy listener binds and is reported in RelayInfo.**

Append to `relay/test/index.test.ts`:

```ts
describe("createRelay with PROXY_TLS_PORT", () => {
  it("binds the TLS proxy listener and reports its port", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-relay-tls-"));
    const cfg = loadConfig({
      PAIRING_TOKEN: "tok",
      PROXY_PORT: "0",
      PROXY_TLS_PORT: "0",
      TUNNEL_PORT: "0",
      DATA_DIR: join(dir, "data"),
      CERT_DIR: join(dir, "certs"),
    });
    relay = createRelay(cfg);
    const info = await relay.start();
    expect(info.proxyTlsPort).toBeGreaterThan(0);
    await relay.stop();
    relay = null;
  });

  it("omits proxyTlsPort when PROXY_TLS_PORT is unset", async () => {
    dir = mkdtempSync(join(tmpdir(), "tp-relay-notls-"));
    const cfg = loadConfig({
      PAIRING_TOKEN: "tok",
      PROXY_PORT: "0",
      TUNNEL_PORT: "0",
      DATA_DIR: join(dir, "data"),
      CERT_DIR: join(dir, "certs"),
    });
    relay = createRelay(cfg);
    const info = await relay.start();
    expect(info.proxyTlsPort).toBeUndefined();
    await relay.stop();
    relay = null;
  });
});
```

- [ ] **Step 6: Run the test (expect PASS — TLS listener wired in Step 3).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/index.test.ts
```

Expected: `Tests  3 passed (3)`.

- [ ] **Step 7: Run the FULL unit suite to confirm nothing regressed.**

```bash
cd /home/hubextech/tetherproxy/relay && npm test
```

Expected: all test files pass (frames, mux, auth, store, config, rateLimiter, tls, tunnelServer, proxyServer, index, smoke).

- [ ] **Step 8: Verify a production build compiles.**

```bash
cd /home/hubextech/tetherproxy/relay && npm run build
```

Expected: `tsc` exits 0 and `dist/index.js` exists.

- [ ] **Step 9: Commit.**

```bash
cd /home/hubextech/tetherproxy/relay
git add src/index.ts test/index.test.ts
git commit -m "feat(relay): composition root createRelay with optional TLS proxy listener + graceful shutdown

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: End-to-end integration test (`test/integration.test.ts`)

**Files:**
- Test: `relay/test/integration.test.ts`

Starts the real relay (over ephemeral ports), connects a fake "phone" WS client (Node `ws` over TLS with cert verification disabled) that opens real sockets to a local HTTP and a local HTTPS test server, performs a real proxied `GET` (plain HTTP) and a real `CONNECT` (HTTPS), and asserts the response body came back AND egress went through the fake phone.

- [ ] **Step 1: Write the integration test.**

Create `relay/test/integration.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the integration test (expect PASS — relies on already-built modules).**

```bash
cd /home/hubextech/tetherproxy/relay && npx vitest run test/integration.test.ts
```

Expected: `Tests  3 passed (3)`. All three bodies (`ORIGIN-HTTP-OK`, `ORIGIN-HTTPS-OK`, `ORIGIN-VIA-TLS-PROXY`) returned and each `egress` array contained the origin `host:port`, proving the bytes left via the fake phone — including the path over the encrypted `:proxyTlsPort` listener.

- [ ] **Step 3: Run the FULL suite once more.**

```bash
cd /home/hubextech/tetherproxy/relay && npm test
```

Expected: every test file passes.

- [ ] **Step 4: Commit.**

```bash
cd /home/hubextech/tetherproxy/relay
git add test/integration.test.ts
git commit -m "test(relay): end-to-end HTTP+HTTPS proxying through a fake phone tunnel, incl. TLS proxy listener

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 13: Packaging (Dockerfile, compose, .env.example)

**Files:**
- Create: `relay/Dockerfile`
- Create: `relay/docker-compose.yml`
- Create: `relay/.env.example`
- Create: `relay/.dockerignore`

- [ ] **Step 1: Write `relay/.dockerignore`.**

Create `relay/.dockerignore`:

```
node_modules
dist
data
certs
.env
*.log
test
.git
```

- [ ] **Step 2: Write `relay/Dockerfile` (multi-stage on node:lts-alpine).**

Create `relay/Dockerfile`:

```dockerfile
# ---- Build stage ----
FROM node:lts-alpine AS build
WORKDIR /app
# Toolchain for better-sqlite3 native build.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:lts-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Build deps needed again to compile better-sqlite3 for production install.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && apk del python3 make g++
COPY --from=build /app/dist ./dist
# Persisted store + generated TLS cert live on mounted volumes.
RUN mkdir -p /data /certs
VOLUME ["/data", "/certs"]
ENV DATA_DIR=/data CERT_DIR=/certs
EXPOSE 8080 8081 8443
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Write `relay/.env.example`.**

Create `relay/.env.example`:

```
# Required: shared secret the phone must present in its AUTH frame.
PAIRING_TOKEN=change-me-to-a-long-random-string

# Proxy listener (cloud clients point HTTPS_PROXY/HTTP_PROXY here).
PROXY_PORT=8080

# Optional TLS proxy listener so client->relay credentials are encrypted.
# PROXY_TLS_PORT=8081

# WSS tunnel listener (the phone dials this).
TUNNEL_PORT=8443

# Optional comma-separated IPv4 CIDR allowlist for the proxy port.
# ALLOWED_CLIENT_CIDRS=34.0.0.0/8,35.0.0.0/8

# Rate limiting / connection caps on the proxy front end.
RATE_LIMIT_MAX_TOTAL=512
RATE_LIMIT_MAX_PER_IP=64
RATE_LIMIT_MAX_NEW_PER_MIN=120
RATE_LIMIT_WINDOW_MS=60000

# Storage + cert locations (defaults match the Docker volumes).
DATA_DIR=/data
CERT_DIR=/certs
```

- [ ] **Step 4: Write `relay/docker-compose.yml`.**

Create `relay/docker-compose.yml`:

```yaml
services:
  relay:
    build: .
    image: tetherproxy-relay:latest
    container_name: tetherproxy-relay
    restart: unless-stopped
    env_file: .env
    ports:
      - "8080:8080"   # proxy
      - "8443:8443"   # wss tunnel
      # - "8081:8081" # optional TLS proxy (uncomment with PROXY_TLS_PORT)
    volumes:
      - relay-data:/data
      - relay-certs:/certs

volumes:
  relay-data:
  relay-certs:
```

- [ ] **Step 5: Validate the compose file parses.**

```bash
cd /home/hubextech/tetherproxy/relay && cp .env.example .env && docker compose config >/dev/null && echo "compose OK"
```

Expected: prints `compose OK` (requires Docker installed; if Docker is unavailable in CI, skip and verify on the deploy host).

- [ ] **Step 6: Build the image (smoke; optional if Docker present).**

```bash
cd /home/hubextech/tetherproxy/relay && docker build -t tetherproxy-relay:latest .
```

Expected: image builds; final line `naming to docker.io/library/tetherproxy-relay:latest`.

- [ ] **Step 7: Commit.**

```bash
cd /home/hubextech/tetherproxy/relay
git add Dockerfile docker-compose.yml .env.example .dockerignore
git commit -m "build(relay): multi-stage Dockerfile, compose with named volumes, env example

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 14: Deploy README (`relay/README.md`)

**Files:**
- Create: `relay/README.md`

- [ ] **Step 1: Write `relay/README.md`.**

Create `relay/README.md`:

````markdown
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
````

- [ ] **Step 2: Commit.**

```bash
cd /home/hubextech/tetherproxy/relay
git add README.md
git commit -m "docs(relay): Alibaba Cloud ECS deploy + client usage README

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 15: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Run the complete test suite from a clean state.**

```bash
cd /home/hubextech/tetherproxy/relay && rm -rf data certs && npm test
```

Expected: all test files pass (smoke, frames, mux, auth, store, config, rateLimiter, tls, tunnelServer, proxyServer, index, integration). Final summary shows `Test Files  12 passed (12)`.

- [ ] **Step 2: Confirm a clean production build.**

```bash
cd /home/hubextech/tetherproxy/relay && rm -rf dist && npm run build && ls dist/index.js
```

Expected: `dist/index.js` listed, `tsc` exits 0.

- [ ] **Step 3: Confirm the git history is complete.**

```bash
cd /home/hubextech/tetherproxy/relay && git log --oneline
```

Expected: one commit per task (init, frames, mux, auth, store, config, rateLimiter, tls, tunnelServer, proxyServer, index, integration test, packaging, README).

- [ ] **Step 4: Tag the milestone.**

```bash
cd /home/hubextech/tetherproxy/relay && git tag relay-v1 && git log --oneline -1
```

Expected: `relay-v1` tag created on the latest commit.
