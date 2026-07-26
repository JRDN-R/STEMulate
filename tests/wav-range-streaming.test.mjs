import assert from "node:assert/strict";
import test from "node:test";

import { validateStreamingStemDeck } from "../src/lib/stemPreviewManifest.ts";
import {
  FetchWavRangeWindowDecoder,
  decodePcmWavRange,
  fetchExactWavByteRange,
  parsePcmWavHeader,
  probeWavRangeStreamingDeck,
} from "../src/lib/wavRangeStreaming.ts";

const PCM_GUID = [
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
  0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];
const FLOAT_GUID = [
  0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
  0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

function ascii(bytes, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function writeInt24(view, offset, value) {
  const unsigned = value < 0 ? value + 0x1000000 : value;
  view.setUint8(offset, unsigned & 0xff);
  view.setUint8(offset + 1, (unsigned >>> 8) & 0xff);
  view.setUint8(offset + 2, (unsigned >>> 16) & 0xff);
}

function wav({
  channels = 1,
  sampleRate = 8_000,
  bits = 16,
  validBits = bits,
  float = false,
  extensible = false,
  frames = 2_000,
  sample = (frame, channel) => ((frame + channel) % 5) / 5,
  guid = float ? FLOAT_GUID : PCM_GUID,
} = {}) {
  const fmtSize = extensible ? 40 : 16;
  const bytesPerSample = bits / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const dataStart = 12 + 8 + fmtSize + 8;
  const bytes = new Uint8Array(dataStart + dataSize);
  const view = new DataView(bytes.buffer);
  ascii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  ascii(bytes, 8, "WAVE");
  ascii(bytes, 12, "fmt ");
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, extensible ? 0xfffe : float ? 3 : 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  if (extensible) {
    view.setUint16(36, 22, true);
    view.setUint16(38, validBits, true);
    view.setUint32(40, channels === 1 ? 0x4 : 0x3, true);
    bytes.set(guid, 44);
  }
  ascii(bytes, 20 + fmtSize, "data");
  view.setUint32(24 + fmtSize, dataSize, true);

  let offset = dataStart;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = sample(frame, channel);
      if (float) {
        view.setFloat32(offset, value, true);
      } else {
        const scale = 2 ** (validBits - 1);
        const integer = Math.max(-scale, Math.min(scale - 1, Math.round(value * scale)));
        const container = integer * (2 ** (bits - validBits));
        if (bits === 16) view.setInt16(offset, container, true);
        else if (bits === 24) writeInt24(view, offset, container);
        else view.setInt32(offset, container, true);
      }
      offset += bytesPerSample;
    }
  }
  return bytes;
}

function rangeFetch(files, { status = 206, mutateHeaders } = {}) {
  return async (url, init = {}) => {
    const file = files.get(String(url));
    if (!file) return new Response("missing", { status: 404 });
    const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get("Range") || "");
    assert.ok(match, "a bounded Range header is required");
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), file.length - 1);
    const body = file.slice(start, end + 1);
    const headers = new Headers({
      "Content-Length": String(body.length),
      "Content-Range": `bytes ${start}-${end}/${file.length}`,
    });
    mutateHeaders?.(headers);
    return new Response(body, { status, headers });
  };
}

test("probes standard and extensible WAV stems into exact common PCM windows", async () => {
  const vocals = wav({ channels: 1, frames: 4_000, bits: 24 });
  const drums = wav({
    channels: 2,
    frames: 4_000,
    bits: 32,
    validBits: 24,
    extensible: true,
  });
  const fetch = rangeFetch(new Map([
    ["https://audio.test/vocals.wav", vocals],
    ["https://audio.test/drums.wav", drums],
  ]));
  const result = await probeWavRangeStreamingDeck({
    vocals: "https://audio.test/vocals.wav",
    drums: "https://audio.test/drums.wav",
  }, { fetch, windowSeconds: 0.25 });

  assert.deepEqual(
    {
      codec: result.deck.codec,
      bitstream: result.deck.bitstream,
      sampleRate: result.deck.sampleRate,
      durationFrames: result.deck.durationFrames,
    },
    {
      codec: "audio/wav",
      bitstream: "pcm-range",
      sampleRate: 8_000,
      durationFrames: 4_000,
    },
  );
  assert.equal(result.metadata.drums.extensible, true);
  assert.equal(result.metadata.drums.validBitsPerSample, 24);
  assert.equal(result.deck.stems.vocals.windows.length, 2);
  assert.deepEqual(
    result.deck.stems.vocals.windows.map((window) => [
      window.startFrame,
      window.frameCount,
      window.prerollByteStart === window.byteStart,
    ]),
    [[0, 2_000, true], [2_000, 2_000, true]],
  );
  assert.equal(validateStreamingStemDeck(result.deck).codec, "audio/wav");
});

test("decodes PCM s16/s24/s32 and IEEE float32 to planar Float32", () => {
  for (const setup of [
    { bits: 16 },
    { bits: 24 },
    { bits: 32 },
    { bits: 32, float: true },
    { bits: 32, validBits: 24, extensible: true },
  ]) {
    const input = wav({
      ...setup,
      channels: 2,
      frames: 4,
      sample: (frame, channel) => [-1, -0.5, 0.25, 0.75][frame] + channel * 0.1,
    });
    const metadata = parsePcmWavHeader(
      input,
      "https://audio.test/test.wav",
      input.length,
    );
    const payload = input.slice(
      metadata.dataByteStart,
      metadata.dataByteEndExclusive,
    );
    const channels = decodePcmWavRange(payload, metadata, 4);
    assert.equal(channels.length, 2);
    assert.ok(Math.abs(channels[0][0] + 1) < 0.0001);
    assert.ok(Math.abs(channels[0][2] - 0.25) < 0.0001);
    assert.ok(Math.abs(channels[1][3] - 0.85) < 0.0001);
  }
});

test("rejects non-206 responses, dishonest Content-Range, and unsupported GUIDs", async () => {
  const input = wav();
  await assert.rejects(
    fetchExactWavByteRange("https://audio.test/test.wav", 0, 44, {
      fetch: rangeFetch(new Map([["https://audio.test/test.wav", input]]), {
        status: 200,
      }),
    }),
    /expected HTTP 206/,
  );
  await assert.rejects(
    fetchExactWavByteRange("https://audio.test/test.wav", 0, 44, {
      fetch: rangeFetch(new Map([["https://audio.test/test.wav", input]]), {
        mutateHeaders: (headers) => headers.set(
          "Content-Range",
          `bytes 1-44/${input.length}`,
        ),
      }),
    }),
    /started at byte 1/,
  );
  const unsupported = wav({
    extensible: true,
    guid: Array.from({ length: 16 }, () => 0x7f),
  });
  assert.throws(
    () => parsePcmWavHeader(
      unsupported,
      "https://audio.test/unsupported.wav",
      unsupported.length,
    ),
    /SubFormat is unsupported/,
  );
});

test("works when current bucket CORS hides Content-Range", async () => {
  const input = wav({ frames: 2_000 });
  const url = "https://audio.test/vocals.wav";
  const fetch = rangeFetch(new Map([[url, input]]), {
    mutateHeaders: (headers) => headers.delete("Content-Range"),
  });
  const { deck, metadata } = await probeWavRangeStreamingDeck(
    { vocals: url },
    { fetch, windowSeconds: 0.25 },
  );
  assert.equal(metadata.vocals.sizeBytes, input.length);

  const source = deck.stems.vocals;
  const decoder = new FetchWavRangeWindowDecoder(metadata, { fetch });
  const decoded = await decoder.decode({
    generation: 1,
    stemId: "vocals",
    source,
    window: source.windows[0],
    codec: deck.codec,
    bitstream: deck.bitstream,
    sampleRate: deck.sampleRate,
    packetFrames: deck.packetFrames,
  });
  assert.equal(decoded.frameCount, 2_000);
});

test("uses the common safe duration but rejects sample-rate mismatches", async () => {
  const files = new Map([
    ["https://audio.test/vocals.wav", wav({ frames: 2_000 })],
    ["https://audio.test/drums.wav", wav({ frames: 2_001 })],
  ]);
  const result = await probeWavRangeStreamingDeck({
    vocals: "https://audio.test/vocals.wav",
    drums: "https://audio.test/drums.wav",
  }, { fetch: rangeFetch(files) });
  assert.equal(result.deck.durationFrames, 2_000);
  assert.equal(result.deck.stems.drums.windows.at(-1).byteEndExclusive,
    result.metadata.drums.dataByteStart + 2_000 * result.metadata.drums.blockAlign);

  files.set(
    "https://audio.test/drums.wav",
    wav({ frames: 2_001, sampleRate: 16_000 }),
  );
  await assert.rejects(
    probeWavRangeStreamingDeck({
      vocals: "https://audio.test/vocals.wav",
      drums: "https://audio.test/drums.wav",
    }, { fetch: rangeFetch(files) }),
    /uses 16000 Hz; every streamed stem must use 8000 Hz/,
  );
});

test("injectable range decoder fetches only the requested aligned PCM window", async () => {
  const input = wav({ frames: 4_000, sample: (frame) => (frame % 4) / 4 });
  const url = "https://audio.test/vocals.wav";
  const fetch = rangeFetch(new Map([[url, input]]));
  const { deck, metadata } = await probeWavRangeStreamingDeck(
    { vocals: url },
    { fetch, windowSeconds: 0.25 },
  );
  const source = deck.stems.vocals;
  const window = source.windows[1];
  const decoder = new FetchWavRangeWindowDecoder(metadata, { fetch });
  const decoded = await decoder.decode({
    generation: 7,
    stemId: "vocals",
    source,
    window,
    codec: deck.codec,
    bitstream: deck.bitstream,
    sampleRate: deck.sampleRate,
    packetFrames: deck.packetFrames,
  });

  assert.equal(decoded.startFrame, 2_000);
  assert.equal(decoded.frameCount, 2_000);
  assert.equal(decoded.channels[0].length, 2_000);
  assert.ok(Math.abs(decoded.channels[0][1] - 0.25) < 0.0001);
  decoder.dispose();
});
