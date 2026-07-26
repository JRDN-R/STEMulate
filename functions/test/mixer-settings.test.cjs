"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeMixerSettingsInput,
} = require("../lib/mixer-settings");

function validSettings() {
  return {
    version: 1,
    stemIds: ["drums", "vocals"],
    channels: {
      vocals: { volume: 84, pan: 0, muted: false, solo: false },
      drums: { volume: 45, pan: -20, muted: true, solo: false },
      metronome: { volume: 90, pan: 0, muted: false, solo: false },
    },
  };
}

test("canonicalizes a bounded v1 mixer-settings payload", () => {
  const input = validSettings();
  input.channels.vocals.sourceUrl = "https://example.invalid/private.wav";

  assert.throws(
    () => normalizeMixerSettingsInput(input),
    /unsupported fields/,
  );
  delete input.channels.vocals.sourceUrl;

  assert.deepEqual(normalizeMixerSettingsInput(input), validSettings());
});

test("rejects unsupported versions, channels, and duplicate layout entries", () => {
  assert.throws(
    () => normalizeMixerSettingsInput({ ...validSettings(), version: 2 }),
    /version is unsupported/,
  );
  assert.throws(
    () => normalizeMixerSettingsInput({
      ...validSettings(),
      stemIds: ["vocals", "synth"],
    }),
    /unsupported channel/,
  );
  assert.throws(
    () => normalizeMixerSettingsInput({
      ...validSettings(),
      stemIds: ["vocals", "vocals"],
    }),
    /duplicate channel/,
  );
  assert.throws(
    () => normalizeMixerSettingsInput({
      ...validSettings(),
      stemIds: ["vocals", "drums", "kick"],
    }),
    /cannot combine drums with individual drum parts/,
  );
  assert.throws(
    () => normalizeMixerSettingsInput({
      ...validSettings(),
      channels: {
        ...validSettings().channels,
        synth: { volume: 80, pan: 0, muted: false, solo: false },
      },
    }),
    /unsupported channel/,
  );
});

test("rejects non-integer, out-of-range, and non-boolean controls", () => {
  const cases = [
    ["volume", 100.5, /volume must be an integer/],
    ["volume", 101, /volume must be an integer/],
    ["pan", -101, /pan must be an integer/],
    ["muted", 0, /must be booleans/],
    ["solo", "false", /must be booleans/],
  ];

  for (const [field, value, expected] of cases) {
    const settings = validSettings();
    settings.channels.drums[field] = value;
    assert.throws(() => normalizeMixerSettingsInput(settings), expected);
  }
});

test("rejects missing, empty, oversized, and arbitrary root data", () => {
  assert.throws(
    () => normalizeMixerSettingsInput(null),
    /must be an object/,
  );
  assert.throws(
    () => normalizeMixerSettingsInput({ ...validSettings(), stemIds: [] }),
    /must not be empty/,
  );
  assert.throws(
    () => normalizeMixerSettingsInput({
      ...validSettings(),
      stemIds: Array.from({ length: 15 }, () => "vocals"),
    }),
    /too many channels/,
  );
  assert.throws(
    () => normalizeMixerSettingsInput({
      ...validSettings(),
      ownerUid: "someone-else",
    }),
    /unsupported fields/,
  );
});
