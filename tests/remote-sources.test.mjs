import assert from "node:assert/strict";
import test from "node:test";

import { validateRemoteImportUrl } from "../src/lib/remoteSources.ts";

test("accepts supported YouTube hosts while Spotify is disabled", () => {
  assert.deepEqual(
    validateRemoteImportUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ", false),
    { ok: true, provider: "youtube" },
  );
  assert.deepEqual(
    validateRemoteImportUrl("https://youtu.be/dQw4w9WgXcQ", false),
    { ok: true, provider: "youtube" },
  );
});

test("rejects Spotify before job creation unless the deploy flag is enabled", () => {
  const url = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC";
  assert.deepEqual(
    validateRemoteImportUrl(url, false),
    { ok: false, reason: "spotify-disabled" },
  );
  assert.deepEqual(
    validateRemoteImportUrl(url, true),
    { ok: true, provider: "spotify" },
  );
});

test("rejects non-HTTPS and unrelated remote hosts", () => {
  assert.deepEqual(
    validateRemoteImportUrl("http://www.youtube.com/watch?v=dQw4w9WgXcQ", false),
    { ok: false, reason: "invalid" },
  );
  assert.deepEqual(
    validateRemoteImportUrl("https://example.com/audio", true),
    { ok: false, reason: "invalid" },
  );
});
