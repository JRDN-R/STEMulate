"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PREVIEW_STEM_IDS,
  previewManifestPath,
  previewStreamPrefix,
  validatePreviewManifestV1,
} = require("../lib/preview-manifest.js");

const ownerUid = "owner_123";
const jobId = "job_456";
const attempt = 3;

function validManifest() {
  return {
    version: 1,
    codec: "mp4a.40.2",
    bitstream: "adts",
    sampleRate: 48_000,
    packetFrames: 1_024,
    durationFrames: 192_512,
    stems: {
      vocals: {
        storagePath: `${previewStreamPrefix(ownerUid, jobId, attempt)}vocals.aac`,
        channels: 2,
        sizeBytes: 2_000,
        windows: [
          {
            startFrame: 0,
            frameCount: 96_256,
            prerollByteStart: 0,
            byteStart: 100,
            byteEndExclusive: 1_000,
          },
          {
            startFrame: 96_256,
            frameCount: 96_256,
            prerollByteStart: 900,
            byteStart: 1_000,
            byteEndExclusive: 2_000,
          },
        ],
      },
    },
  };
}

test("validates and sanitizes the versioned ADTS manifest", () => {
  const raw = validManifest();
  raw.untrusted = "discarded";
  raw.stems.vocals.untrusted = "discarded";
  const manifest = validatePreviewManifestV1(raw, ownerUid, jobId, attempt);

  assert.equal(manifest.version, 1);
  assert.equal(manifest.stems.vocals.storagePath,
    `users/${ownerUid}/jobs/${jobId}/streams/v1/attempt-${attempt}/vocals.aac`);
  assert.equal("untrusted" in manifest, false);
  assert.equal("untrusted" in manifest.stems.vocals, false);
  assert.equal(
    previewManifestPath(ownerUid, jobId, attempt),
    `users/${ownerUid}/jobs/${jobId}/streams/v1/attempt-${attempt}/manifest.json`,
  );
});

test("accepts the five canonical drum-component preview IDs", () => {
  assert.deepEqual(PREVIEW_STEM_IDS, [
    "vocals",
    "drums",
    "kick",
    "snare",
    "toms",
    "hi_hat",
    "cymbals",
    "bass",
    "guitars",
    "piano",
    "keys",
    "strings",
    "wind",
    "other",
  ]);

  const baseStem = validManifest().stems.vocals;
  const raw = validManifest();
  raw.stems = Object.fromEntries(
    ["kick", "snare", "toms", "hi_hat", "cymbals"].map((stemId) => [
      stemId,
      {
        ...structuredClone(baseStem),
        storagePath: `${previewStreamPrefix(ownerUid, jobId, attempt)}${stemId}.aac`,
      },
    ]),
  );

  const manifest = validatePreviewManifestV1(raw, ownerUid, jobId, attempt);
  assert.deepEqual(
    Object.keys(manifest.stems),
    ["kick", "snare", "toms", "hi_hat", "cymbals"],
  );
});

test("scopes immutable preview objects to one retry attempt", () => {
  assert.notEqual(
    previewManifestPath(ownerUid, jobId, attempt),
    previewManifestPath(ownerUid, jobId, attempt + 1),
  );
  assert.throws(
    () => validatePreviewManifestV1(
      validManifest(),
      ownerUid,
      jobId,
      attempt + 1,
    ),
    /storage path/i,
  );
});

test("rejects unsupported manifest versions and audio formats", () => {
  for (const mutate of [
    (manifest) => { manifest.version = 2; },
    (manifest) => { manifest.codec = "opus"; },
    (manifest) => { manifest.bitstream = "mp4"; },
    (manifest) => { manifest.sampleRate = 44_100; },
    (manifest) => { manifest.packetFrames = 960; },
  ]) {
    const manifest = validManifest();
    mutate(manifest);
    assert.throws(
      () => validatePreviewManifestV1(manifest, ownerUid, jobId, attempt),
      /manifest|format|version/i,
    );
  }
});

test("rejects path escapes and noncanonical stem IDs", () => {
  const escaped = validManifest();
  escaped.stems.vocals.storagePath = "users/another/jobs/job/streams/v1/vocals.aac";
  assert.throws(
    () => validatePreviewManifestV1(escaped, ownerUid, jobId, attempt),
    /storage path/i,
  );

  const unknown = validManifest();
  unknown.stems.synth = unknown.stems.vocals;
  delete unknown.stems.vocals;
  assert.throws(
    () => validatePreviewManifestV1(unknown, ownerUid, jobId, attempt),
    /invalid stem/i,
  );
});

test("rejects window gaps, overlaps, and incomplete byte coverage", () => {
  const frameGap = validManifest();
  frameGap.stems.vocals.windows[1].startFrame += 1;
  assert.throws(
    () => validatePreviewManifestV1(frameGap, ownerUid, jobId, attempt),
    /contiguous/i,
  );

  const byteOverlap = validManifest();
  byteOverlap.stems.vocals.windows[1].byteStart -= 1;
  assert.throws(
    () => validatePreviewManifestV1(byteOverlap, ownerUid, jobId, attempt),
    /contiguous/i,
  );

  const invalidPreroll = validManifest();
  invalidPreroll.stems.vocals.windows[1].prerollByteStart = 1_000;
  assert.throws(
    () => validatePreviewManifestV1(invalidPreroll, ownerUid, jobId, attempt),
    /contiguous|bounds/i,
  );

  const incomplete = validManifest();
  incomplete.stems.vocals.sizeBytes += 1;
  assert.throws(
    () => validatePreviewManifestV1(incomplete, ownerUid, jobId, attempt),
    /complete stem/i,
  );
});

test("requires every stem to share the same packet-aligned frame windows", () => {
  const manifest = validManifest();
  manifest.stems.drums = {
    ...structuredClone(manifest.stems.vocals),
    storagePath: `${previewStreamPrefix(ownerUid, jobId, attempt)}drums.aac`,
    windows: [
      {
        startFrame: 0,
        frameCount: 102_400,
        prerollByteStart: 0,
        byteStart: 100,
        byteEndExclusive: 1_000,
      },
      {
        startFrame: 102_400,
        frameCount: 90_112,
        prerollByteStart: 900,
        byteStart: 1_000,
        byteEndExclusive: 2_000,
      },
    ],
  };
  assert.throws(
    () => validatePreviewManifestV1(manifest, ownerUid, jobId, attempt),
    /same frame windows/i,
  );
});
