import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
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
 * Persistent device + credential store backed by a plain JSON file.
 *
 * The dataset is tiny (one row per paired phone), so a JSON file keyed by
 * deviceId is sufficient and avoids any native dependency — the whole relay
 * builds and runs with no compile step, which matters on small (1 GB) VMs.
 *
 * Pass ":memory:" for tests (no file is written), or a file path on persistent
 * storage in production.
 */
export class Store {
  private readonly filePath: string | null;
  private readonly devices = new Map<string, DeviceRecord>();

  constructor(dbPath: string) {
    if (dbPath === ":memory:") {
      this.filePath = null;
      return;
    }
    this.filePath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.load();
  }

  /** Load existing records from disk, tolerating a missing/empty file. */
  private load(): void {
    if (this.filePath === null) return;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return; // first boot: no file yet
    }
    if (raw.trim().length === 0) return;
    const parsed = JSON.parse(raw) as DeviceRecord[];
    for (const rec of parsed) {
      this.devices.set(rec.deviceId, rec);
    }
  }

  /** Atomically persist all records (write temp + rename) to avoid corruption. */
  private persist(): void {
    if (this.filePath === null) return;
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.devices.values()], null, 2));
    renameSync(tmp, this.filePath);
  }

  /**
   * Insert or update a device. Re-pairing the same deviceId replaces its
   * username and password. createdAt is preserved on update.
   */
  upsertDevice(input: UpsertInput): void {
    const existing = this.devices.get(input.deviceId);
    this.devices.set(input.deviceId, {
      deviceId: input.deviceId,
      proxyUsername: input.proxyUsername,
      bcryptPassword: input.bcryptPassword,
      createdAt: existing?.createdAt ?? Date.now(),
    });
    this.persist();
  }

  /** Find a device by its proxy username, or null if absent. */
  findByUsername(username: string): DeviceRecord | null {
    for (const rec of this.devices.values()) {
      if (rec.proxyUsername === username) return rec;
    }
    return null;
  }

  /** Find a device by its deviceId, or null if absent. */
  findByDeviceId(deviceId: string): DeviceRecord | null {
    return this.devices.get(deviceId) ?? null;
  }

  /** No-op: writes are flushed synchronously on each upsert. */
  close(): void {
    // Nothing to release — kept for API compatibility with callers.
  }
}
