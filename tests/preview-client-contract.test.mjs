import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../src/lib/musicAi.ts", import.meta.url),
  "utf8",
);
const appSource = await readFile(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);

test("preview client validates one finite state snapshot and queues at most once", () => {
  const start = source.indexOf(
    "export async function getOrRequestProcessingPreview",
  );
  const end = source.indexOf("async function readBoundedText", start);
  const client = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(client, /"getProcessingPreview"/);
  assert.match(client, /parsePreviewResponse\(jobId,\s*response\.data/);
  assert.match(source, /validateStemPreviewManifest\(record\.manifest\)/);
  assert.match(
    client,
    /current\.status === "unavailable" \|\| current\.status === "failed"/,
  );
  assert.equal(client.match(/"requestProcessingPreview"/g)?.length, 1);
  assert.doesNotMatch(client, /setInterval|setTimeout|while\s*\(/);
  assert.match(client, /catch \(error\)/);
});

test("every processing result preserves the job identity and original URL expiry", () => {
  assert.match(
    source,
    /export async function analyzeFile[\s\S]*Promise<CompletedJobResult>/,
  );
  assert.match(source, /return waitForJob\(owner\.uid,\s*job\.jobId/);
  assert.match(
    source,
    /return \{\s*\.\.\.completed,\s*title,\s*source,\s*provider,\s*\}/,
  );
  assert.match(source, /outputsExpireAt:\s*materialized\.expiresAt/g);
});

test("App retries preview reads, refreshes signed URLs, and defers live swaps", () => {
  assert.match(
    appSource,
    /\["unavailable",\s*"queued",\s*"processing",\s*"retrying",\s*"awaiting_finalize"\]/,
  );
  assert.match(appSource, /PREVIEW_REQUEST_MAX_ATTEMPTS/);
  assert.match(appSource, /PREVIEW_URL_REFRESH_LEAD_MS/);
  assert.match(appSource, /pendingPreviewManifest\.current = pending/);
  assert.match(
    appSource,
    /if \(isPlaying \|\| !pendingPreviewManifest\.current\) return;/,
  );
});

test("App observes runtime failures and steps down AAC to WAV to full buffering", () => {
  assert.match(appSource, /unsubscribeSnapshot = transport\.subscribe/);
  assert.match(appSource, /snapshot\.contextState === "interrupted"/);
  assert.match(appSource, /mode === "aac"[\s\S]*setAudioReloadTrigger/);
  assert.match(appSource, /mode === "wav"[\s\S]*setAudioReloadTrigger/);
  assert.match(
    appSource,
    /previewManifest !== disabledAacManifest\.current/,
  );
  assert.match(
    appSource,
    /audioSources !== disabledWavSources\.current/,
  );
});

test("section-loop switches update the transport before seeking", () => {
  const start = appSource.indexOf("const toggleLoopForSection");
  const end = appSource.indexOf("const resumeRemoteNow", start);
  const handler = appSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(handler.indexOf(".setLoop(nextLoop)") < handler.indexOf("seek(section.start)"));
});

test("late library and background refresh results cannot replace a newer choice", () => {
  assert.match(appSource, /mediaRequestGeneration/);
  assert.match(
    appSource,
    /requestGeneration !== mediaRequestGeneration\.current/,
  );
  assert.match(
    appSource,
    /!hadSourcesAtStart \|\| result\.jobId === jobAtStart/,
  );
  assert.match(appSource, /pendingAudioSourceRefresh/);
});
