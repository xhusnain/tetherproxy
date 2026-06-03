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
