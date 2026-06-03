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
