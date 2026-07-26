import assert from "node:assert/strict";
import test from "node:test";

import {
  captureMixerSettings,
  mixerSettingsEqual,
  normalizeMixerSettings,
  restoreMixerSettings,
} from "../src/lib/mixerSettings.ts";
import {
  normalizeStemSelection,
  stemStatesForSelection,
} from "../src/lib/stemSelection.ts";
import { stemPresentationFor } from "../src/lib/stems.ts";

test("captures only the adjustable controls and ordered channel selection", () => {
  const selection = normalizeStemSelection(["drums", "vocals"]);
  const stems = stemStatesForSelection({}, selection).map((stem) => {
    if (stem.id === "drums") {
      return {
        ...stem,
        volume: 41.6,
        pan: -24.6,
        muted: true,
        label: "Do not persist this label",
      };
    }
    return stem;
  });

  assert.deepEqual(captureMixerSettings(stems, selection), {
    version: 1,
    stemIds: ["drums", "vocals"],
    channels: {
      vocals: { volume: 84, pan: 0, muted: false, solo: false },
      drums: { volume: 42, pan: -25, muted: true, solo: false },
      metronome: { volume: 62, pan: 0, muted: false, solo: false },
    },
  });
});

test("normalizes untrusted persisted data without accepting unknown channels", () => {
  const normalized = normalizeMixerSettings({
    version: 1,
    stemIds: ["vocals", "synth", "vocals", "wind"],
    channels: {
      vocals: {
        volume: 37,
        pan: 15,
        muted: false,
        solo: true,
        sourceUrl: "https://example.invalid/private.wav",
      },
      synth: { volume: 100, pan: 0, muted: false, solo: false },
      wind: { volume: 500, pan: 0, muted: false, solo: false },
    },
    workflowSlug: "untrusted-workflow",
  });

  assert.deepEqual(normalized, {
    version: 1,
    stemIds: ["vocals", "wind"],
    channels: {
      vocals: { volume: 37, pan: 15, muted: false, solo: true },
    },
  });
  assert.equal(normalizeMixerSettings({ version: 2, stemIds: ["vocals"] }), null);
  assert.equal(normalizeMixerSettings({ version: 1, stemIds: ["synth"] }), null);
  assert.deepEqual(
    normalizeMixerSettings({
      version: 1,
      stemIds: ["vocals", "drums", "kick"],
      channels: {},
    })?.stemIds,
    ["vocals", "kick"],
  );
});

test("restores matching channels and defaults missing or newly available channels", () => {
  const fallback = normalizeStemSelection(["bass"]);
  const restored = restoreMixerSettings(
    {
      drums: "https://cdn.example/drums.wav",
      vocals: "https://cdn.example/vocals.wav",
      bass: "https://cdn.example/bass.wav",
    },
    fallback,
    {
      version: 1,
      stemIds: ["drums", "vocals", "wind"],
      channels: {
        drums: { volume: 28, pan: 70, muted: false, solo: true },
        wind: { volume: 12, pan: -90, muted: true, solo: false },
        metronome: { volume: 91, pan: 0, muted: false, solo: false },
      },
    },
  );

  assert.deepEqual(restored.selection.stemIds, ["drums", "vocals", "wind"]);
  assert.deepEqual(restored.stems.map(({ id }) => id), [
    "drums",
    "vocals",
    "metronome",
  ]);
  assert.deepEqual(
    restored.stems.find(({ id }) => id === "drums"),
    {
      id: "drums",
      ...stemPresentationFor("drums"),
      pan: 70,
      muted: false,
      solo: true,
      volume: 28,
    },
  );
  assert.equal(
    restored.stems.find(({ id }) => id === "vocals")?.volume,
    stemPresentationFor("vocals").volume,
  );
  assert.equal(
    restored.stems.find(({ id }) => id === "metronome")?.volume,
    91,
  );
});

test("falls back cleanly when no supported saved version exists", () => {
  const fallback = normalizeStemSelection(["bass", "other"]);
  const restored = restoreMixerSettings({}, fallback, {
    version: 99,
    stemIds: ["vocals"],
  });

  assert.deepEqual(restored.selection, fallback);
  assert.deepEqual(
    restored.stems.map(({ id }) => id),
    ["bass", "other", "metronome"],
  );
  assert.equal(restored.saved, null);
});

test("compares canonical settings instead of caller object key order", () => {
  const left = {
    version: 1,
    stemIds: ["vocals", "drums"],
    channels: {
      drums: { volume: 60, pan: 0, muted: false, solo: false },
      vocals: { volume: 70, pan: -5, muted: false, solo: false },
    },
  };
  const right = {
    channels: {
      vocals: { solo: false, muted: false, pan: -5, volume: 70 },
      drums: { solo: false, muted: false, pan: 0, volume: 60 },
    },
    stemIds: ["vocals", "drums"],
    version: 1,
  };

  assert.equal(mixerSettingsEqual(left, right), true);
  assert.equal(
    mixerSettingsEqual(left, { ...right, stemIds: ["drums", "vocals"] }),
    false,
  );
});
