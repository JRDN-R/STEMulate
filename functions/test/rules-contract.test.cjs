"use strict";

const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "../..");

test("Storage Rules reserve remote job inputs for the private worker", async () => {
  const rules = await readFile(path.join(projectRoot, "storage.rules"), "utf8");

  assert.match(rules, /sourceType\s*==\s*'upload'/);
  assert.match(rules, /request\.resource\.size\s*==\s*job\(userId, jobId\)\.sizeBytes/);
  assert.match(rules, /request\.resource\.contentType\s*==\s*job\(userId, jobId\)\.contentType/);
  assert.match(rules, /allow update:\s*if false/);
});

test("Storage Rules reserve generated stream previews for trusted services", async () => {
  const rules = await readFile(path.join(projectRoot, "storage.rules"), "utf8");

  assert.match(
    rules,
    /match \/users\/\{userId\}\/jobs\/\{jobId\}\/streams\/v1\/\{streamPath=\*\*\}/,
  );
  assert.match(
    rules,
    /streams\/v1\/\{streamPath=\*\*\}[\s\S]*allow read, write:\s*if false/,
  );
});

test("Storage CORS exposes byte-range response metadata", async () => {
  const cors = JSON.parse(await readFile(
    path.join(projectRoot, "storage.cors.json"),
    "utf8",
  ));
  const headers = cors[0]?.responseHeader ?? [];

  assert.ok(headers.includes("Accept-Ranges"));
  assert.ok(headers.includes("Content-Range"));
  assert.ok(headers.includes("ETag"));
  assert.ok(headers.includes("Range"));
});

test("Firestore Rules keep internal downloader and Music.ai state private", async () => {
  const rules = await readFile(path.join(projectRoot, "firestore.rules"), "utf8");

  assert.match(rules, /match \/users\/\{userId\}\/jobs\/\{jobId\}/);
  assert.match(rules, /allow get, list:\s*if isOwner\(userId\)/);
  assert.match(rules, /match \/\{document=\*\*\}[\s\S]*allow read, write:\s*if false/);
});

test("Storage upload trigger is colocated with the us-east1 bucket", async () => {
  const config = await readFile(
    path.join(projectRoot, "functions/src/config.ts"),
    "utf8",
  );
  const functions = await readFile(
    path.join(projectRoot, "functions/src/index.ts"),
    "utf8",
  );

  assert.match(config, /STORAGE_TRIGGER_REGION\s*=\s*"us-east1"/);
  assert.match(
    functions,
    /onObjectFinalized\(\s*\{\s*region:\s*STORAGE_TRIGGER_REGION,/,
  );
});

test("Preview tasks use private Cloud Run OIDC and App Check callables", async () => {
  const tasks = await readFile(
    path.join(projectRoot, "functions/src/preview-tasks.ts"),
    "utf8",
  );
  const functions = await readFile(
    path.join(projectRoot, "functions/src/index.ts"),
    "utf8",
  );

  assert.match(tasks, /url:\s*`\$\{serviceUrl\}\/tasks\/preview`/);
  assert.match(tasks, /oidcToken:\s*\{[\s\S]*serviceAccountEmail,[\s\S]*audience:\s*serviceUrl/);
  assert.match(
    functions,
    /requestProcessingPreview\s*=\s*onCall<PreviewJobInput>\([\s\S]*?enforceAppCheck:\s*true/,
  );
  assert.match(
    functions,
    /getProcessingPreview\s*=\s*onCall<PreviewJobInput>\([\s\S]*?enforceAppCheck:\s*true/,
  );
  assert.match(
    functions,
    /enqueueCompletedPreview\s*=\s*onDocumentUpdated\([\s\S]*?after\.status\s*!==\s*"completed"[\s\S]*?enqueuePreviewTask/,
  );

  const failureHelper = functions.match(
    /async function markPreviewFailed\([\s\S]*?\n\}\n\ninterface PreparedPreview/,
  )?.[0] ?? "";
  assert.ok(failureHelper);
  assert.match(failureHelper, /previewStatus:\s*"failed"/);
  assert.doesNotMatch(failureHelper, /\n\s*status:\s*"failed"/);
});

test("Preview deployment grants enqueue permission and outlives a worker lease", async () => {
  const readme = await readFile(
    path.join(projectRoot, "stream-service/README.md"),
    "utf8",
  );

  assert.match(readme, /roles\/cloudtasks\.enqueuer/);
  assert.match(readme, /--max-attempts=10/);
  assert.match(readme, /--max-retry-duration=3600s/);
  assert.match(readme, /gcloud tasks queues update/);
});
