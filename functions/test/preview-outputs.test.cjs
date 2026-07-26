"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  preparePreviewOutputs,
} = require("../lib/preview-outputs.js");

test("preserves the complete authoritative original-output snapshot", () => {
  const prefix = "users/owner/jobs/job/outputs/";
  const outputs = preparePreviewOutputs("owner", "job", [
    {
      key: "mapping__beats",
      storagePath: `${prefix}mapping__beats.json`,
      contentType: "application/json; charset=utf-8",
      sizeBytes: 500,
    },
    {
      key: "stems__vocals",
      storagePath: `${prefix}stems__vocals.wav`,
      contentType: "audio/wav",
      sizeBytes: 10_000,
    },
    {
      key: "stems__drums",
      storagePath: `${prefix}stems__drums.flac`,
      contentType: "application/octet-stream",
      sizeBytes: 20_000,
    },
  ]);

  assert.deepEqual(outputs, [
    {
      key: "mapping__beats",
      storagePath: `${prefix}mapping__beats.json`,
      contentType: "application/json; charset=utf-8",
      sizeBytes: 500,
    },
    {
      key: "stems__drums",
      storagePath: `${prefix}stems__drums.flac`,
      contentType: "application/octet-stream",
      sizeBytes: 20_000,
    },
    {
      key: "stems__vocals",
      storagePath: `${prefix}stems__vocals.wav`,
      contentType: "audio/wav",
      sizeBytes: 10_000,
    },
  ]);
});

test("rejects path escapes, malformed metadata, and duplicate identities", () => {
  const valid = {
    key: "vocals",
    storagePath: "users/owner/jobs/job/outputs/vocals.wav",
    contentType: "audio/wav",
    sizeBytes: 10_000,
  };
  for (const output of [
    { ...valid, storagePath: "users/other/jobs/job/outputs/vocals.wav" },
    { ...valid, key: "../vocals" },
    { ...valid, contentType: "not media" },
    { ...valid, sizeBytes: 0 },
  ]) {
    assert.throws(
      () => preparePreviewOutputs("owner", "job", [output]),
      /invalid/i,
    );
  }
  assert.throws(
    () => preparePreviewOutputs("owner", "job", [valid, valid]),
    /unique/i,
  );
});

test("bounds task snapshots independently from the nine-stem manifest", () => {
  const prefix = "users/owner/jobs/job/outputs/";
  const outputs = Array.from({ length: 40 }, (_, index) => ({
    key: `output_${index}`,
    storagePath: `${prefix}output_${index}.json`,
    contentType: "application/json",
    sizeBytes: 100,
  }));
  assert.equal(preparePreviewOutputs("owner", "job", outputs).length, 40);
  assert.throws(
    () => preparePreviewOutputs("owner", "job", [
      ...outputs,
      {
        key: "too_many",
        storagePath: `${prefix}too_many.json`,
        contentType: "application/json",
        sizeBytes: 100,
      },
    ]),
    /count/i,
  );
});
