import assert from "node:assert/strict";
import test from "node:test";

import { parseAdtsFrames } from "../src/lib/adts.ts";

function adtsFrame({
  payloadBytes = 5,
  sampleRateIndex = 3,
  channels = 2,
  crc = false,
  rawDataBlocks = 0,
} = {}) {
  const headerLength = crc ? 9 : 7;
  const frameLength = headerLength + payloadBytes;
  const bytes = new Uint8Array(frameLength);
  bytes[0] = 0xff;
  bytes[1] = crc ? 0xf0 : 0xf1;
  bytes[2] = (1 << 6) | (sampleRateIndex << 2) | (channels >> 2);
  bytes[3] = ((channels & 3) << 6) | ((frameLength >> 11) & 3);
  bytes[4] = (frameLength >> 3) & 0xff;
  bytes[5] = ((frameLength & 7) << 5) | 0x1f;
  bytes[6] = 0xfc | rawDataBlocks;
  for (let index = headerLength; index < frameLength; index += 1) {
    bytes[index] = index & 0xff;
  }
  return bytes;
}

test("parses consecutive ADTS frames with exact byte and sample metadata", () => {
  const first = adtsFrame({ payloadBytes: 5 });
  const second = adtsFrame({ payloadBytes: 11, crc: true, rawDataBlocks: 1 });
  const bytes = new Uint8Array(first.length + second.length);
  bytes.set(first);
  bytes.set(second, first.length);

  const frames = parseAdtsFrames(bytes, { baseOffset: 1_000 });

  assert.equal(frames.length, 2);
  assert.deepEqual(
    frames.map((frame) => ({
      byteStart: frame.byteStart,
      byteEndExclusive: frame.byteEndExclusive,
      headerLength: frame.headerLength,
      sampleRate: frame.sampleRate,
      channels: frame.channels,
      audioObjectType: frame.audioObjectType,
      sampleCount: frame.sampleCount,
    })),
    [
      {
        byteStart: 1_000,
        byteEndExclusive: 1_000 + first.length,
        headerLength: 7,
        sampleRate: 48_000,
        channels: 2,
        audioObjectType: 2,
        sampleCount: 1_024,
      },
      {
        byteStart: 1_000 + first.length,
        byteEndExclusive: 1_000 + first.length + second.length,
        headerLength: 9,
        sampleRate: 48_000,
        channels: 2,
        audioObjectType: 2,
        sampleCount: 2_048,
      },
    ],
  );
  assert.equal(frames[0].data.buffer, bytes.buffer);
});

test("rejects malformed, reserved, and truncated ADTS frames", () => {
  assert.throws(
    () => parseAdtsFrames(new Uint8Array([0, 1, 2, 3, 4, 5, 6])),
    /sync word/,
  );
  assert.throws(
    () => parseAdtsFrames(adtsFrame({ sampleRateIndex: 15 })),
    /reserved sample-rate/,
  );
  const truncated = adtsFrame({ payloadBytes: 20 }).subarray(0, 10);
  assert.throws(() => parseAdtsFrames(truncated), /truncated frame payload/);
  assert.deepEqual(
    parseAdtsFrames(truncated, { allowTrailingPartialFrame: true }),
    [],
  );
});
