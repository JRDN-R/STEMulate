import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const moduleUrl = new URL("../src/lib/musicAnalysis.ts", import.meta.url);

async function loadMusicAnalysis() {
  const source = await readFile(moduleUrl, "utf8");
  const { outputText, diagnostics } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  assert.deepEqual(diagnostics, []);
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

test("normalizes every documented Music.ai chord label class", async () => {
  const { normalizeChords } = await loadMusicAnalysis();
  const chords = normalizeChords({
    chords: [
      {
        start: 0,
        end: 1,
        chord: "N.C.",
        chord_simple_pop: "C",
      },
      { start: 1, end: 2, chord_complex_pop: "G7" },
      { start: 2, end: 3, chord_simple_jazz: "Dm7" },
      { start: 3, end: 4, chord_complex_jazz: "A13" },
      { start: 4, end: 5, chord_majmin: "F#m" },
    ],
  });

  assert.deepEqual(
    chords.map(({ chord }) => chord),
    ["C", "G7", "Dm7", "A13", "F#m"],
  );
});

test("retains legacy chord aliases without fabricating missing labels", async () => {
  const { normalizeChords } = await loadMusicAnalysis();
  const chords = normalizeChords({
    chordMap: [
      { startTime: 0, endTime: 1, simplePop: "Bb" },
      { start: 1, end: 2, complexJazz: "Cmaj9" },
      { start: 2, end: 3, label: "Am" },
      { start: 3, end: 4, chord_simple_pop: "N.C." },
      { start: 4, end: 5 },
      { start: 5, end: 6, chord: { value: "not-a-label" } },
    ],
  });

  assert.deepEqual(chords, [
    { chord: "Bb", start: 0, end: 1 },
    { chord: "Cmaj9", start: 1, end: 2 },
    { chord: "Am", start: 2, end: 3 },
    { chord: "N.C.", start: 3, end: 4 },
  ]);
});

test("uses Music.ai beatNum instead of inventing a four-beat sequence", async () => {
  const { normalizeBeats } = await loadMusicAnalysis();
  const beats = normalizeBeats({
    beatMap: [
      { time: 0.25, beatNum: 3 },
      { time: 0.75, beatNum: 1 },
      { time: 1.25, beatNum: 2 },
    ],
  });

  assert.deepEqual(beats, [
    { time: 0.25, beat: 3 },
    { time: 0.75, beat: 1 },
    { time: 1.25, beat: 2 },
  ]);
});
