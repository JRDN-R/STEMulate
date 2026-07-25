"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  canonicalizeRemoteTrackUrl,
  remoteJobId,
  validateClientRequestId,
} = require("../lib/remote-import.js");

test("canonicalizes supported single-track URLs", () => {
  const cases = [
    {
      input: "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b?si=test",
      expected: {
        provider: "spotify",
        resourceId: "0VjIjW4GlUZAMYd2vXMi3b",
        url: "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
      },
    },
    {
      input: "https://youtu.be/dQw4w9WgXcQ?t=43",
      expected: {
        provider: "youtube",
        resourceId: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
    },
    {
      input: "https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
      expected: {
        provider: "youtube",
        resourceId: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
    },
    {
      input: "https://m.youtube.com/shorts/dQw4w9WgXcQ",
      expected: {
        provider: "youtube",
        resourceId: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
    },
  ];

  for (const { input, expected } of cases) {
    assert.deepEqual(canonicalizeRemoteTrackUrl(input), expected);
  }
});

test("rejects unsupported, unsafe, playlist, and malformed URLs", () => {
  const cases = [
    [undefined, "SOURCE_URL_INVALID"],
    ["not a URL", "SOURCE_URL_INVALID"],
    ["http://youtu.be/dQw4w9WgXcQ", "SOURCE_URL_INVALID"],
    ["https://user:pass@youtu.be/dQw4w9WgXcQ", "SOURCE_URL_INVALID"],
    ["https://youtu.be:8443/dQw4w9WgXcQ", "SOURCE_URL_INVALID"],
    ["https://youtu.be/dQw4w9WgXcQ#fragment", "SOURCE_URL_INVALID"],
    ["https://youtube.example/watch?v=dQw4w9WgXcQ", "SOURCE_PROVIDER_UNSUPPORTED"],
    ["https://notyoutube.com/watch?v=dQw4w9WgXcQ", "SOURCE_PROVIDER_UNSUPPORTED"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123", "YOUTUBE_PLAYLISTS_UNSUPPORTED"],
    ["https://www.youtube.com/playlist?list=PL123", "YOUTUBE_PLAYLISTS_UNSUPPORTED"],
    ["https://www.youtube.com/channel/UC123", "YOUTUBE_SINGLE_VIDEO_REQUIRED"],
    ["https://youtu.be/not-eleven", "YOUTUBE_VIDEO_ID_INVALID"],
    ["https://open.spotify.com/playlist/0VjIjW4GlUZAMYd2vXMi3b", "SPOTIFY_SINGLE_TRACK_REQUIRED"],
    ["https://open.spotify.com/album/0VjIjW4GlUZAMYd2vXMi3b", "SPOTIFY_SINGLE_TRACK_REQUIRED"],
    ["https://open.spotify.com/track/too-short", "SPOTIFY_SINGLE_TRACK_REQUIRED"],
    ["https://evil.open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b", "SOURCE_PROVIDER_UNSUPPORTED"],
  ];

  for (const [input, expectedMessage] of cases) {
    assert.throws(
      () => canonicalizeRemoteTrackUrl(input),
      (error) => error instanceof Error && error.message === expectedMessage,
      String(input),
    );
  }
});

test("normalizes valid client request IDs and rejects invalid values", () => {
  assert.equal(
    validateClientRequestId("123E4567-E89B-12D3-A456-426614174000"),
    "123e4567-e89b-12d3-a456-426614174000",
  );

  for (const value of [
    undefined,
    "",
    "123e4567-e89b-02d3-a456-426614174000",
    "123e4567-e89b-12d3-7456-426614174000",
    "123e4567-e89b-12d3-a456-42661417400z",
  ]) {
    assert.throws(
      () => validateClientRequestId(value),
      (error) => error instanceof Error && error.message === "CLIENT_REQUEST_ID_INVALID",
      String(value),
    );
  }
});

test("creates stable, owner-scoped deterministic remote job IDs", () => {
  const requestId = "123e4567-e89b-12d3-a456-426614174000";
  const first = remoteJobId("owner-123", requestId);

  assert.equal(first, "2ef845a064f2e5d9bd55a4cb3738a824");
  assert.equal(remoteJobId("owner-123", requestId), first);
  assert.equal(remoteJobId("owner-456", requestId), "9ba30e551d0801c9c5d763be7a965fad");
  assert.equal(
    remoteJobId("owner-123", "123e4567-e89b-12d3-a456-426614174001"),
    "94d9e9a49a1d1aa6db0f3bcce5eca8c9",
  );
  assert.match(first, /^[0-9a-f]{32}$/);
});
