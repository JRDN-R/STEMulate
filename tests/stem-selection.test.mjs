import assert from "node:assert/strict";
import test from "node:test";

import {
  STEM_SELECTION_PRESETS,
  STEM_SELECTION_STORAGE_KEY,
  loadStemSelection,
  moveStemSelection,
  normalizeStemSelection,
  reorderStemSelection,
  saveStemSelection,
  selectStemSources,
  stemSelectionForPreset,
  stemStatesForSelection,
  toggleStemSelection,
} from "../src/lib/stemSelection.ts";

test("provides the practical presets plus a non-doubling drum-parts layout", () => {
  assert.deepEqual(
    STEM_SELECTION_PRESETS.map(({ id, stemIds }) => [id, stemIds]),
    [
      ["4", ["vocals", "drums", "bass", "other"]],
      ["5", ["vocals", "drums", "bass", "guitars", "other"]],
      ["6", ["vocals", "drums", "bass", "guitars", "piano", "other"]],
      ["7", ["vocals", "drums", "bass", "guitars", "piano", "keys", "other"]],
      ["drum-parts", [
        "vocals",
        "kick",
        "snare",
        "toms",
        "hi_hat",
        "cymbals",
        "bass",
        "other",
      ]],
      ["full", [
        "vocals",
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
      ]],
    ],
  );
});

test("sanitizes persisted selections to canonical output IDs", () => {
  assert.deepEqual(
    normalizeStemSelection({
      mode: "full",
      stemIds: ["vocals", "background-vocals", "drums", "kick", "vocals", "wind"],
      workflowSlug: "untrusted-workflow",
    }),
    {
      mode: "custom",
      stemIds: ["vocals", "kick", "wind"],
    },
  );
  assert.deepEqual(normalizeStemSelection({ stemIds: [] }), stemSelectionForPreset("4"));
});

test("keeps combined drums and drum parts mutually exclusive", () => {
  let selection = stemSelectionForPreset("4");
  selection = toggleStemSelection(selection, "kick");
  assert.deepEqual(selection, {
    mode: "custom",
    stemIds: ["vocals", "kick", "bass", "other"],
  });

  selection = toggleStemSelection(selection, "snare");
  assert.deepEqual(selection.stemIds, ["vocals", "kick", "snare", "bass", "other"]);

  selection = toggleStemSelection(selection, "drums");
  assert.deepEqual(selection, stemSelectionForPreset("4"));

  assert.deepEqual(
    normalizeStemSelection(["vocals", "drums", "kick", "snare", "bass"]),
    {
      mode: "custom",
      stemIds: ["vocals", "kick", "snare", "bass"],
    },
  );
});

test("custom selection supports adding, removing, and reordering without becoming empty", () => {
  let selection = stemSelectionForPreset("4");
  selection = toggleStemSelection(selection, "guitars");
  assert.equal(selection.mode, "custom");
  assert.deepEqual(selection.stemIds, ["vocals", "drums", "bass", "other", "guitars"]);

  selection = moveStemSelection(selection, "guitars", -1);
  assert.deepEqual(selection.stemIds, ["vocals", "drums", "bass", "guitars", "other"]);
  assert.equal(selection.mode, "5");

  selection = reorderStemSelection(selection, 0, 4);
  assert.deepEqual(selection.stemIds, ["drums", "bass", "guitars", "other", "vocals"]);
  assert.equal(selection.mode, "custom");

  const one = normalizeStemSelection(["vocals"]);
  assert.deepEqual(toggleStemSelection(one, "vocals"), one);
});

test("filters and orders actual sources, and preserves existing mixer controls", () => {
  const sources = {
    vocals: "https://cdn.music.ai/vocals.wav",
    drums: "https://cdn.music.ai/drums.wav",
    bass: "https://cdn.music.ai/bass.wav",
    guitars: "https://cdn.music.ai/guitars.wav",
  };
  const selection = normalizeStemSelection(["guitars", "vocals", "wind"]);
  assert.deepEqual(selectStemSources(sources, selection), {
    guitars: "https://cdn.music.ai/guitars.wav",
    vocals: "https://cdn.music.ai/vocals.wav",
  });

  const previous = stemStatesForSelection({}, selection).map((stem) =>
    stem.id === "vocals" ? { ...stem, volume: 31, muted: true } : stem,
  );
  const states = stemStatesForSelection(sources, selection, previous);
  assert.deepEqual(states.map(({ id }) => id), ["guitars", "vocals", "metronome"]);
  assert.equal(states[1].volume, 31);
  assert.equal(states[1].muted, true);
});

test("falls back between combined drums and drum parts without doubling", () => {
  const legacySources = {
    vocals: "https://cdn.music.ai/vocals.wav",
    drums: "https://cdn.music.ai/drums.wav",
    bass: "https://cdn.music.ai/bass.wav",
    other: "https://cdn.music.ai/other.wav",
  };
  const componentSelection = stemSelectionForPreset("drum-parts");
  assert.deepEqual(selectStemSources(legacySources, componentSelection), legacySources);
  assert.deepEqual(
    stemStatesForSelection(legacySources, componentSelection).map(({ id }) => id),
    ["vocals", "drums", "bass", "other", "metronome"],
  );

  const componentOnlySources = {
    vocals: "https://cdn.music.ai/vocals.wav",
    kick: "https://cdn.music.ai/kick.wav",
    snare: "https://cdn.music.ai/snare.wav",
    bass: "https://cdn.music.ai/bass.wav",
    other: "https://cdn.music.ai/other.wav",
  };
  assert.deepEqual(
    selectStemSources(componentOnlySources, stemSelectionForPreset("4")),
    componentOnlySources,
  );
  assert.deepEqual(
    stemStatesForSelection(componentOnlySources, stemSelectionForPreset("4"))
      .map(({ id }) => id),
    ["vocals", "kick", "snare", "bass", "other", "metronome"],
  );

  const bothRepresentations = {
    ...legacySources,
    kick: "https://cdn.music.ai/kick.wav",
    snare: "https://cdn.music.ai/snare.wav",
    toms: "https://cdn.music.ai/toms.wav",
    hi_hat: "https://cdn.music.ai/hi_hat.wav",
    cymbals: "https://cdn.music.ai/cymbals.wav",
  };
  assert.deepEqual(
    Object.keys(selectStemSources(bothRepresentations, componentSelection)),
    ["vocals", "kick", "snare", "toms", "hi_hat", "cymbals", "bass", "other"],
  );
  assert.equal(
    "drums" in selectStemSources(bothRepresentations, componentSelection),
    false,
  );

  const partialComponents = {
    ...legacySources,
    kick: "https://cdn.music.ai/kick.wav",
  };
  assert.deepEqual(
    Object.keys(selectStemSources(partialComponents, componentSelection)),
    ["vocals", "drums", "bass", "other"],
  );
});

test("round-trips a versioned local preference and tolerates unavailable storage", () => {
  const values = new Map();
  const storage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
  const saved = saveStemSelection(normalizeStemSelection(["wind", "strings"]), storage);
  assert.equal(values.has(STEM_SELECTION_STORAGE_KEY), true);
  assert.deepEqual(loadStemSelection(storage), saved);

  const unavailable = {
    getItem() {
      throw new Error("disabled");
    },
    setItem() {
      throw new Error("disabled");
    },
  };
  assert.deepEqual(loadStemSelection(unavailable), stemSelectionForPreset("4"));
  assert.deepEqual(saveStemSelection(saved, unavailable), saved);
});
