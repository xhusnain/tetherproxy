import type { Socket } from "node:net";

/**
 * Per-tunnel stream registry. Maps a monotonically allocated streamId to the
 * proxy client's net.Socket. streamId 0 is reserved for control frames, so
 * allocation begins at 1.
 */
export class Mux {
  private nextId = 1;
  private readonly streams = new Map<number, Socket>();

  /** Allocate a fresh streamId and register the client socket under it. */
  allocate(socket: Socket): number {
    let id = this.nextId++;
    // Wrap past the 32-bit space and never hand out 0 (reserved for control).
    if (this.nextId > 0xffffffff) this.nextId = 1;
    while (id === 0 || this.streams.has(id)) {
      id = this.nextId++;
      if (this.nextId > 0xffffffff) this.nextId = 1;
    }
    this.streams.set(id, socket);
    return id;
  }

  /** Look up the socket for a streamId, or undefined if none. */
  get(id: number): Socket | undefined {
    return this.streams.get(id);
  }

  /** Remove a stream from the registry. Returns the socket if it existed. */
  delete(id: number): Socket | undefined {
    const sock = this.streams.get(id);
    this.streams.delete(id);
    return sock;
  }

  /** Number of active streams. */
  get size(): number {
    return this.streams.size;
  }

  /** All currently registered stream ids. */
  ids(): number[] {
    return [...this.streams.keys()];
  }

  /** Write DATA payload to the client socket for a stream. */
  routeData(id: number, payload: Buffer): boolean {
    const sock = this.streams.get(id);
    if (!sock || sock.destroyed) return false;
    sock.write(payload);
    return true;
  }

  /** Tear down a stream: end its socket and drop it from the registry. */
  routeClose(id: number): boolean {
    const sock = this.streams.get(id);
    if (!sock) return false;
    this.streams.delete(id);
    if (!sock.destroyed) sock.end();
    return true;
  }

  /** Destroy every stream's socket and clear the registry. */
  destroyAll(): void {
    for (const sock of this.streams.values()) {
      if (!sock.destroyed) sock.destroy();
    }
    this.streams.clear();
  }
}
