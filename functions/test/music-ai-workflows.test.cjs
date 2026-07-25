"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.MAX_OUTPUT_FILES = "32";

const {
  mergeMusicAiWorkflowResults,
  musicAiSubmissionDisposition,
  parseMusicAiWorkflows,
} = require("../lib/music-ai.js");

test("parses a stable named multi-workflow plan ahead of the legacy slug", () => {
  assert.deepEqual(
    parseMusicAiWorkflows(
      "stems=basic-stems-auto, mapping=chords-and-beat-mapping, sections=song-sections",
      "legacy-combined-workflow",
    ),
    [
      { key: "stems", slug: "basic-stems-auto" },
      { key: "mapping", slug: "chords-and-beat-mapping" },
      { key: "sections", slug: "song-sections" },
    ],
  );
});

test("keeps legacy one-workflow configuration and accepts bare multi slugs", () => {
  assert.deepEqual(
    parseMusicAiWorkflows("", "combined-workflow"),
    [{ key: "primary", slug: "combined-workflow" }],
  );
  assert.deepEqual(
    parseMusicAiWorkflows("stems-workflow,analysis-workflow", ""),
    [
      { key: "workflow_1", slug: "stems-workflow" },
      { key: "workflow_2", slug: "analysis-workflow" },
    ],
  );
});

test("rejects missing, placeholder, duplicate, and malformed workflow plans", () => {
  for (const [multiple, legacy] of [
    ["", ""],
    ["", "replace-with-your-music-ai-workflow-slug"],
    ["stems=same,mapping=same", ""],
    ["stems=one,stems=two", ""],
    ["Bad Key=one", ""],
    ["stems=", ""],
  ]) {
    assert.throws(
      () => parseMusicAiWorkflows(multiple, legacy),
      /Music\.ai workflow|Configure one to eight/,
    );
  }
});

test("merges workflow outputs while preserving flat keys and namespacing collisions", () => {
  const merged = mergeMusicAiWorkflowResults([
    {
      workflow: { key: "stems", slug: "stems-workflow" },
      sources: [
        { key: "vocals", url: "https://cdn.music.ai/one/vocals.wav" },
        { key: "drums", url: "https://cdn.music.ai/one/drums.wav" },
      ],
      analysis: { bpm: 120 },
    },
    {
      workflow: { key: "mapping", slug: "mapping-workflow" },
      sources: [
        { key: "beats", url: "https://cdn.music.ai/two/beats.json" },
        { key: "vocals", url: "https://cdn.music.ai/two/debug-vocals.wav" },
      ],
      analysis: { bpm: 121, key: "Cm" },
    },
    {
      workflow: { key: "sections", slug: "sections-workflow" },
      sources: [
        { key: "sections", url: "https://cdn.music.ai/three/sections.json" },
      ],
      analysis: {},
    },
  ]);

  assert.deepEqual(
    merged.sources.map(({ key }) => key),
    ["vocals", "drums", "beats", "mapping__vocals", "sections"],
  );
  assert.deepEqual(merged.analysis, {
    bpm: 120,
    mapping_bpm: 121,
    key: "Cm",
  });
});

test("classifies per-workflow submission checkpoints without risking duplicate paid jobs", () => {
  const now = 1_000_000;
  assert.equal(
    musicAiSubmissionDisposition(
      { submissionAttempted: false },
      now,
    ),
    "submit",
  );
  assert.equal(
    musicAiSubmissionDisposition(
      {
        musicAiJobId: "remote-job-123",
        submissionAttempted: true,
        submissionLeaseUntilMs: now - 1,
      },
      now,
    ),
    "resume_polling",
  );
  assert.equal(
    musicAiSubmissionDisposition(
      {
        submissionAttempted: true,
        submissionLeaseUntilMs: now + 1,
      },
      now,
    ),
    "in_flight",
  );
  assert.equal(
    musicAiSubmissionDisposition(
      {
        submissionAttempted: true,
        submissionLeaseUntilMs: now,
      },
      now,
    ),
    "uncertain",
  );
});
