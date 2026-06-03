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
