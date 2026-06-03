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
