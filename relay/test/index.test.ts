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
