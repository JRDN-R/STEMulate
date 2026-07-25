import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_STEM_IDS,
  initialStemStates,
  normalizeStemOutputs,
  stemStatesFor,
} from "../src/lib/stems.ts";

test("loads every useful Basic Stems - Auto output and skips the original mix", () => {
  const result = Object.fromEntries([
    ...AUDIO_STEM_IDS.map((id) => [id, `https://cdn.music.ai/job/example/${id}.wav`]),
    ["original", "https://cdn.music.ai/job/example/original.wav"],
  ]);

  assert.deepEqual(normalizeStemOutputs(result), {
    vocals: "https://cdn.music.ai/job/example/vocals.wav",
    drums: "https://cdn.music.ai/job/example/drums.wav",
    bass: "https://cdn.music.ai/job/example/bass.wav",
    guitars: "https://cdn.music.ai/job/example/guitars.wav",
    piano: "https://cdn.music.ai/job/example/piano.wav",
    keys: "https://cdn.music.ai/job/example/keys.wav",
    strings: "https://cdn.music.ai/job/example/strings.wav",
    wind: "https://cdn.music.ai/job/example/wind.wav",
    other: "https://cdn.music.ai/job/example/other.wav",
  });
});

test("keeps aliases and nested legacy Music.ai output shapes compatible", () => {
  const result = {
    stems: [
      { name: "Voice", file: "https://cdn.music.ai/job/example/output-1.wav" },
      { name: "Drum", file: "https://cdn.music.ai/job/example/output-2.wav" },
      { name: "Bass", file: "https://cdn.music.ai/job/example/output-3.wav" },
      { name: "Instrumental", file: "https://cdn.music.ai/job/example/output-4.wav" },
    ],
  };

  assert.deepEqual(normalizeStemOutputs(result), {
    vocals: "https://cdn.music.ai/job/example/output-1.wav",
    drums: "https://cdn.music.ai/job/example/output-2.wav",
    bass: "https://cdn.music.ai/job/example/output-3.wav",
    other: "https://cdn.music.ai/job/example/output-4.wav",
  });
});

test("adapts mixer rows to available stems while preserving channel controls", () => {
  const previous = initialStemStates().map((stem) =>
    stem.id === "vocals" ? { ...stem, volume: 41, muted: true } : stem,
  );
  const rows = stemStatesFor({
    vocals: "https://cdn.music.ai/vocals.wav",
    guitars: "https://cdn.music.ai/guitars.wav",
    strings: "https://cdn.music.ai/strings.wav",
  }, previous);

  assert.deepEqual(rows.map((stem) => stem.id), ["vocals", "guitars", "strings", "metronome"]);
  assert.equal(rows[0].volume, 41);
  assert.equal(rows[0].muted, true);
  assert.equal(rows[1].label, "Guitars");
  assert.equal(rows[2].shortLabel, "STR");
});

test("retains the compact four-stem demo mixer when no outputs are available", () => {
  assert.deepEqual(
    stemStatesFor({}).map((stem) => stem.id),
    ["vocals", "drums", "bass", "other", "metronome"],
  );
});
