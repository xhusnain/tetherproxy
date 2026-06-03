/**
 * Frozen tunnel frame protocol (relay <-> phone).
 * Layout: [1 byte type][4 bytes streamId big-endian][payload].
 * streamId 0 = control frames.
 */

export enum FrameType {
  AUTH = 0x01,
  AUTH_OK = 0x02,
  AUTH_FAIL = 0x03,
  OPEN = 0x10,
  OPEN_OK = 0x11,
  OPEN_FAIL = 0x12,
  DATA = 0x20,
  CLOSE = 0x21,
  PING = 0x30,
  PONG = 0x31,
}

export interface Frame {
  type: FrameType;
  streamId: number;
  payload: Buffer;
}

export const HEADER_LEN = 5;

/** Encode a frame to a Buffer: [type][streamId BE][payload]. */
export function encodeFrame(
  type: FrameType,
  streamId: number,
  payload: Buffer = Buffer.alloc(0),
): Buffer {
  const buf = Buffer.allocUnsafe(HEADER_LEN + payload.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(streamId >>> 0, 1);
  payload.copy(buf, HEADER_LEN);
  return buf;
}

/** Decode a Buffer into a Frame. Throws if shorter than the 5-byte header. */
export function decodeFrame(buf: Buffer): Frame {
  if (buf.length < HEADER_LEN) {
    throw new Error(`frame too short: ${buf.length} bytes`);
  }
  const type = buf.readUInt8(0) as FrameType;
  const streamId = buf.readUInt32BE(1);
  const payload = buf.subarray(HEADER_LEN);
  return { type, streamId, payload };
}

/** Encode a frame whose payload is a JSON-serialized object. */
export function encodeJsonFrame(
  type: FrameType,
  streamId: number,
  obj: unknown,
): Buffer {
  return encodeFrame(type, streamId, Buffer.from(JSON.stringify(obj), "utf8"));
}

/** Parse a frame payload as JSON. */
export function decodeJsonPayload<T = unknown>(payload: Buffer): T {
  return JSON.parse(payload.toString("utf8")) as T;
}
