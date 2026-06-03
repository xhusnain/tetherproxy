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
