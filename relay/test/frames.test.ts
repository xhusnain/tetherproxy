import { describe, it, expect } from "vitest";
import { FrameType, encodeFrame, decodeFrame } from "../src/frames.js";
import { encodeJsonFrame, decodeJsonPayload } from "../src/frames.js";

describe("FrameType enum", () => {
  it("has the frozen type codes", () => {
    expect(FrameType.AUTH).toBe(0x01);
    expect(FrameType.AUTH_OK).toBe(0x02);
    expect(FrameType.AUTH_FAIL).toBe(0x03);
    expect(FrameType.OPEN).toBe(0x10);
    expect(FrameType.OPEN_OK).toBe(0x11);
    expect(FrameType.OPEN_FAIL).toBe(0x12);
    expect(FrameType.DATA).toBe(0x20);
    expect(FrameType.CLOSE).toBe(0x21);
    expect(FrameType.PING).toBe(0x30);
    expect(FrameType.PONG).toBe(0x31);
  });
});

describe("encodeFrame / decodeFrame", () => {
  it("round-trips an empty-payload control frame", () => {
    const buf = encodeFrame(FrameType.AUTH_OK, 0, Buffer.alloc(0));
    expect(buf.length).toBe(5);
    expect(buf[0]).toBe(0x02);
    const f = decodeFrame(buf);
    expect(f.type).toBe(FrameType.AUTH_OK);
    expect(f.streamId).toBe(0);
    expect(f.payload.length).toBe(0);
  });
});

describe("encodeFrame round-trips every frame type", () => {
  const cases: Array<[FrameType, number, Buffer]> = [
    [FrameType.AUTH, 0, Buffer.from('{"pairingToken":"t"}', "utf8")],
    [FrameType.AUTH_OK, 0, Buffer.alloc(0)],
    [FrameType.AUTH_FAIL, 0, Buffer.from('{"reason":"bad"}', "utf8")],
    [FrameType.OPEN, 7, Buffer.from('{"host":"a","port":443}', "utf8")],
    [FrameType.OPEN_OK, 7, Buffer.alloc(0)],
    [FrameType.OPEN_FAIL, 7, Buffer.from('{"reason":"refused"}', "utf8")],
    [FrameType.DATA, 9, Buffer.from([1, 2, 3, 4, 5])],
    [FrameType.CLOSE, 9, Buffer.alloc(0)],
    [FrameType.PING, 0, Buffer.alloc(0)],
    [FrameType.PONG, 0, Buffer.alloc(0)],
  ];

  for (const [type, streamId, payload] of cases) {
    it(`round-trips type 0x${type.toString(16)} stream ${streamId}`, () => {
      const enc = encodeFrame(type, streamId, payload);
      const dec = decodeFrame(enc);
      expect(dec.type).toBe(type);
      expect(dec.streamId).toBe(streamId);
      expect(Buffer.compare(dec.payload, payload)).toBe(0);
    });
  }

  it("preserves a large 32-bit streamId via big-endian", () => {
    const enc = encodeFrame(FrameType.DATA, 0xdeadbeef, Buffer.from([0xff]));
    expect(enc[1]).toBe(0xde);
    expect(enc[2]).toBe(0xad);
    expect(enc[3]).toBe(0xbe);
    expect(enc[4]).toBe(0xef);
    expect(decodeFrame(enc).streamId).toBe(0xdeadbeef);
  });

  it("throws on a buffer shorter than the header", () => {
    expect(() => decodeFrame(Buffer.from([0x20, 0x00]))).toThrow();
  });
});

describe("JSON frame helpers", () => {
  it("round-trips a JSON object", () => {
    const enc = encodeJsonFrame(FrameType.OPEN, 42, { host: "x.com", port: 80 });
    const dec = decodeFrame(enc);
    expect(dec.type).toBe(FrameType.OPEN);
    expect(dec.streamId).toBe(42);
    expect(decodeJsonPayload(dec.payload)).toEqual({ host: "x.com", port: 80 });
  });
});
