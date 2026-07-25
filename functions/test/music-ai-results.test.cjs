"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.MUSIC_AI_OUTPUT_HOSTS = "cdn.music.ai,storage.googleapis.com";
process.env.MAX_OUTPUT_FILES = "32";

const { extractResultSources } = require("../lib/music-ai.js");

test("accepts artifacts only from configured Music.ai result hosts", () => {
  const sources = extractResultSources({
    vocals: "https://cdn.music.ai/jobs/example/vocals.wav?signature=test",
    beats: "https://storage.googleapis.com/moises/example/beats.json?signature=test",
    attacker: "https://example.com/not-an-output.wav",
    metadata: "https://metadata.google.internal/computeMetadata/v1/",
    lookalike: "https://cdn.music.ai.example.com/output.wav",
    port: "https://cdn.music.ai:8443/output.wav",
    credentials: "https://user:pass@cdn.music.ai/output.wav",
  });

  assert.deepEqual(sources, [
    {
      key: "vocals",
      url: "https://cdn.music.ai/jobs/example/vocals.wav?signature=test",
    },
    {
      key: "beats",
      url: "https://storage.googleapis.com/moises/example/beats.json?signature=test",
    },
  ]);
});

test("walks nested workflow outputs without treating inline metadata as files", () => {
  const sources = extractResultSources({
    stems: [
      { name: "Vocals", file: "https://cdn.music.ai/jobs/example/vocals.wav" },
      { name: "Drums", file: "https://cdn.music.ai/jobs/example/drums.wav" },
    ],
    bpm: 120,
    key: "Cm",
  });

  assert.deepEqual(sources.map((source) => source.key), [
    "stems__0__file",
    "stems__1__file",
  ]);
});
