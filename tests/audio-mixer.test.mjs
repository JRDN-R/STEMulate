import assert from "node:assert/strict";
import test from "node:test";

import { resolveStemMix } from "../src/lib/audioMixer.ts";
import { initialStemStates } from "../src/lib/stems.ts";

test("resolves fader percentages and pan to Web Audio values", () => {
  const stems = initialStemStates().map((stem) =>
    stem.id === "vocals" ? { ...stem, volume: 42, pan: -75 } : stem,
  );

  assert.deepEqual(resolveStemMix(stems).vocals, {
    gain: 0.42,
    pan: -0.75,
  });
});

test("mute and solo produce deterministic channel gains", () => {
  const stems = initialStemStates().map((stem) => {
    if (stem.id === "vocals") return { ...stem, muted: true };
    if (stem.id === "drums") return { ...stem, solo: true };
    return stem;
  });
  const mix = resolveStemMix(stems);

  assert.equal(mix.vocals?.gain, 0);
  assert.equal(mix.drums?.gain, 0.78);
  assert.equal(mix.bass?.gain, 0);
  assert.equal(mix.other?.gain, 0);
});

test("soloing the metronome silences every audio stem", () => {
  const stems = initialStemStates().map((stem) =>
    stem.id === "metronome" ? { ...stem, solo: true } : stem,
  );

  assert.ok(Object.values(resolveStemMix(stems)).every((channel) => channel?.gain === 0));
});
