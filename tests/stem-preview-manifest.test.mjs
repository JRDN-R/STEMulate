import assert from "node:assert/strict";
import test from "node:test";

import {
  previewDurationSeconds,
  validateStemPreviewManifest,
} from "../src/lib/stemPreviewManifest.ts";

function manifest() {
  const windows = [
    {
      startFrame: 0,
      frameCount: 48 * 1_024,
      prerollByteStart: 0,
      byteStart: 100,
      byteEndExclusive: 1_000,
    },
    {
      startFrame: 48 * 1_024,
      frameCount: 24 * 1_024,
      prerollByteStart: 900,
      byteStart: 1_000,
      byteEndExclusive: 1_600,
    },
  ];
  return {
    version: 1,
    codec: "mp4a.40.2",
    bitstream: "adts",
    sampleRate: 48_000,
    packetFrames: 1_024,
    durationFrames: 72 * 1_024,
    stems: {
      vocals: {
        storagePath: "previews/job/vocals.aac",
        url: "https://media.test/vocals.aac",
        channels: 2,
        sizeBytes: 1_600,
        windows,
      },
      drums: {
        storagePath: "previews/job/drums.aac",
        url: "https://media.test/drums.aac",
        channels: 2,
        sizeBytes: 1_620,
        windows: windows.map((window, index) => ({
          ...window,
          prerollByteStart: index === 0 ? 0 : window.prerollByteStart + 20,
          byteStart: window.byteStart + 20,
          byteEndExclusive: window.byteEndExclusive + 20,
        })),
      },
    },
  };
}

test("validates a v1 keyed-stem manifest and detaches callable data", () => {
  const input = manifest();
  const result = validateStemPreviewManifest(input);

  assert.equal(previewDurationSeconds(result), (72 * 1_024) / 48_000);
  assert.deepEqual(Object.keys(result.stems), ["vocals", "drums"]);
  assert.equal(result.stems.vocals.windows[1].startFrame, 48 * 1_024);
  assert.equal("storagePath" in result.stems.vocals, false);

  input.stems.vocals.windows[0].frameCount = 12;
  assert.equal(result.stems.vocals.windows[0].frameCount, 48 * 1_024);
});

test("rejects mismatched timelines and unsafe byte windows", () => {
  const mismatched = manifest();
  mismatched.stems.drums.windows[1].startFrame += 1;
  mismatched.stems.drums.windows[0].frameCount += 1;
  assert.throws(
    () => validateStemPreviewManifest(mismatched),
    /same frame windows|must start at frame|windows cover/,
  );

  const overflow = manifest();
  overflow.stems.vocals.windows[1].byteEndExclusive = 99_000;
  assert.throws(
    () => validateStemPreviewManifest(overflow),
    /exceeds the stem size/,
  );

  const unknownStem = manifest();
  unknownStem.stems.synth = unknownStem.stems.vocals;
  assert.throws(
    () => validateStemPreviewManifest(unknownStem),
    /unsupported stem "synth"/,
  );
});
