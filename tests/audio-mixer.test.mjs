import assert from "node:assert/strict";
import test from "node:test";

import {
  metronomePeakGain,
  resolveStemMix,
  snapRangeValue,
} from "../src/lib/audioMixer.ts";
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

test("range detents snap only inside the requested radius", () => {
  assert.equal(snapRangeValue(4, 0, 5), 0);
  assert.equal(snapRangeValue(-5, 0, 5), 0);
  assert.equal(snapRangeValue(6, 0, 5), 6);
  assert.equal(snapRangeValue(77, 78, 3), 78);
  assert.equal(snapRangeValue(74, 78, 3), 74);
});

test("metronome gain is louder while remaining below full scale", () => {
  assert.equal(metronomePeakGain(62, true), 0.279);
  assert.equal(metronomePeakGain(100, true), 0.45);
  assert.equal(metronomePeakGain(100, false), 0);
  assert.equal(metronomePeakGain(150, true), 0.45);
});
