import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  librarySource,
  viewSource,
  functionsSource,
  musicAiSource,
  mixerSettingsSource,
] = await Promise.all([
  readFile(new URL("../src/lib/songLibrary.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/LibraryView.tsx", import.meta.url), "utf8"),
  readFile(new URL("../functions/src/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/musicAi.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/mixerSettings.ts", import.meta.url), "utf8"),
]);

test("library subscribes only to the authenticated user's persisted jobs", () => {
  assert.match(
    librarySource,
    /collection\(getStemulateFirestore\(\),\s*"users",\s*ownerUid,\s*"jobs"\)/,
  );
  assert.match(librarySource, /orderBy\("createdAt",\s*"desc"\)/);
  assert.match(librarySource, /limit\(MAX_LIBRARY_ITEMS\)/);
  assert.match(librarySource, /status === "completed" && outputs\.length > 0/);
});

test("library presents key, BPM, processing state, and an accessible rename flow", () => {
  assert.match(viewSource, /song\.key \|\| "Key —"/);
  assert.match(viewSource, /formatBpm\(song\.bpm\)/);
  assert.match(viewSource, /statusLabel\(song\)/);
  assert.match(viewSource, /aria-label=\{`Rename \$\{song\.title\}`\}/);
  assert.match(viewSource, /maxLength=\{120\}/);
});

test("rename is App Check protected and restricted to the authenticated owner path", () => {
  const callable = functionsSource.slice(
    functionsSource.indexOf("export const renameProcessingJob"),
    functionsSource.indexOf("export const queueUploadedSource"),
  );
  assert.match(callable, /enforceAppCheck:\s*true/);
  assert.match(callable, /const ownerUid = requireOwner\(request\)/);
  assert.match(callable, /publicJobRef\(ownerUid,\s*jobId\)/);
  assert.match(callable, /const job = snapshot\.data\(\)/);
  assert.match(callable, /job\.ownerUid !== ownerUid/);
  assert.match(callable, /FieldValue\.serverTimestamp\(\)/);
});

test("a selected completed library song can safely refresh its signed playback URLs", () => {
  const loader = musicAiSource.slice(
    musicAiSource.indexOf("export async function loadProcessingJob"),
    musicAiSource.indexOf("export async function refreshLatestOutputs"),
  );
  assert.match(loader, /getOwnerUser\(\)/);
  assert.match(loader, /users\/\$\{owner\.uid\}\/jobs\/\$\{jobId\}/);
  assert.match(loader, /job\.status !== "completed"/);
  assert.match(loader, /materializeResult\(jobId,\s*job\)/);
});

test("saved mixer settings use the immutable job ID and an owner-only callable", () => {
  assert.match(
    librarySource,
    /saveSongMixerSettings\(\s*jobId:\s*string,\s*settings:\s*SavedMixerSettingsV1/,
  );
  assert.match(librarySource, /"saveProcessingJobMixerSettings"/);
  assert.match(librarySource, /mixerSettingsEqual\(saved,\s*normalized\)/);

  const callable = functionsSource.slice(
    functionsSource.indexOf("export const saveProcessingJobMixerSettings"),
    functionsSource.indexOf("export const finalizeProcessingPreview"),
  );
  assert.match(callable, /enforceAppCheck:\s*true/);
  assert.match(callable, /const ownerUid = requireOwner\(request\)/);
  assert.match(callable, /publicJobRef\(ownerUid,\s*jobId\)/);
  assert.match(callable, /job\.ownerUid !== ownerUid/);
  assert.match(callable, /job\.status !== "completed"/);
  assert.match(callable, /mixerSettingsUpdatedAt:\s*FieldValue\.serverTimestamp\(\)/);
});

test("completed-job loaders propagate only normalized mixer settings", () => {
  assert.match(musicAiSource, /mixerSettings\?:\s*unknown/);
  assert.ok(
    musicAiSource.match(
      /mixerSettings:\s*normalizeMixerSettings\(job\.mixerSettings\)/g,
    )?.length === 3,
  );
  assert.match(mixerSettingsSource, /MIXER_SETTINGS_VERSION\s*=\s*1/);
  assert.match(
    mixerSettingsSource,
    /if \(!isAudioStemId\(stemId\) \|\| seen\.has\(stemId\)\) continue/,
  );
  assert.doesNotMatch(mixerSettingsSource, /sourceUrl|workflowSlug|storagePath/);
});
