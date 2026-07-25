import { createHash } from "node:crypto";

export type RemoteProvider = "youtube" | "spotify";

export interface CanonicalRemoteTrack {
  provider: RemoteProvider;
  url: string;
  resourceId: string;
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const CLIENT_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeUrl(value: unknown): URL {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) {
    throw new Error("SOURCE_URL_INVALID");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("SOURCE_URL_INVALID");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.hash
  ) {
    throw new Error("SOURCE_URL_INVALID");
  }
  return url;
}

export function canonicalizeRemoteTrackUrl(value: unknown): CanonicalRemoteTrack {
  const url = safeUrl(value);
  const hostname = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  if (hostname === "open.spotify.com") {
    if (parts.length !== 2 || parts[0] !== "track" || !SPOTIFY_ID.test(parts[1])) {
      throw new Error("SPOTIFY_SINGLE_TRACK_REQUIRED");
    }
    return {
      provider: "spotify",
      resourceId: parts[1],
      url: `https://open.spotify.com/track/${parts[1]}`,
    };
  }

  let videoId = "";
  if (hostname === "youtu.be") {
    if (parts.length !== 1) throw new Error("YOUTUBE_SINGLE_VIDEO_REQUIRED");
    videoId = parts[0];
  } else if (YOUTUBE_HOSTS.has(hostname)) {
    if (url.searchParams.has("list")) throw new Error("YOUTUBE_PLAYLISTS_UNSUPPORTED");
    if (url.pathname === "/watch") {
      videoId = url.searchParams.get("v") ?? "";
    } else if (parts.length === 2 && parts[0] === "shorts") {
      videoId = parts[1];
    } else {
      throw new Error("YOUTUBE_SINGLE_VIDEO_REQUIRED");
    }
  } else {
    throw new Error("SOURCE_PROVIDER_UNSUPPORTED");
  }

  if (!YOUTUBE_ID.test(videoId)) throw new Error("YOUTUBE_VIDEO_ID_INVALID");
  return {
    provider: "youtube",
    resourceId: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export function validateClientRequestId(value: unknown): string {
  if (typeof value !== "string" || !CLIENT_REQUEST_ID.test(value)) {
    throw new Error("CLIENT_REQUEST_ID_INVALID");
  }
  return value.toLowerCase();
}

export function remoteJobId(ownerUid: string, clientRequestId: string): string {
  return createHash("sha256")
    .update(`${ownerUid}:${clientRequestId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}
