import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, parseProxyAuthorization, buildProxyAuthRequired } from "../src/auth.js";

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
