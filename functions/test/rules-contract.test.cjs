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

test("Firestore Rules keep internal downloader and Music.ai state private", async () => {
  const rules = await readFile(path.join(projectRoot, "firestore.rules"), "utf8");

  assert.match(rules, /match \/users\/\{userId\}\/jobs\/\{jobId\}/);
  assert.match(rules, /allow get, list:\s*if isOwner\(userId\)/);
  assert.match(rules, /match \/\{document=\*\*\}[\s\S]*allow read, write:\s*if false/);
});
