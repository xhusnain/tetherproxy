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
