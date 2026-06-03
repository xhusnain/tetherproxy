import { describe, it, expect, afterEach } from "vitest";
import { Store, type DeviceRecord } from "../src/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
