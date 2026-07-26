import type { RemoteSourceProvider } from "../types";

const YOUTUBE_TRACK_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SPOTIFY_TRACK_ID = /^[A-Za-z0-9]{22}$/;

export type RemoteImportUrlValidation =
  | { ok: true; provider: RemoteSourceProvider }
  | {
      ok: false;
      reason:
        | "invalid"
        | "spotify-disabled"
        | "spotify-single-track"
        | "youtube-playlist"
        | "youtube-single-video";
    };

export function remoteImportValidationMessage(
  validation: Extract<RemoteImportUrlValidation, { ok: false }>,
  spotifyEnabled: boolean,
): string {
  switch (validation.reason) {
    case "spotify-disabled":
      return "Spotify importing is disabled on this deployment. Paste a YouTube video URL.";
    case "spotify-single-track":
      return "Paste one open.spotify.com track link, not an album, playlist, artist, or shortened link.";
    case "youtube-playlist":
      return "Paste one YouTube video, not a playlist.";
    case "youtube-single-video":
      return "Use one YouTube watch, Shorts, or youtu.be video link.";
    default:
      return spotifyEnabled
        ? "Enter a valid YouTube video or Spotify track URL."
        : "Enter a valid YouTube video URL.";
  }
}

export function validateRemoteImportUrl(
  value: string,
  spotifyEnabled: boolean,
): RemoteImportUrlValidation {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (
    value.length > 2_048
    || url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.hash
  ) {
    return { ok: false, reason: "invalid" };
  }

  const hostname = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  if (hostname === "youtu.be") {
    if (parts.length !== 1 || !YOUTUBE_VIDEO_ID.test(parts[0])) {
      return { ok: false, reason: "youtube-single-video" };
    }
    return { ok: true, provider: "youtube" };
  }

  if (YOUTUBE_TRACK_HOSTS.has(hostname)) {
    if (url.searchParams.has("list") || url.pathname === "/playlist") {
      return { ok: false, reason: "youtube-playlist" };
    }
    const videoId = url.pathname === "/watch"
      ? url.searchParams.get("v") ?? ""
      : parts.length === 2 && parts[0] === "shorts"
        ? parts[1]
        : "";
    return YOUTUBE_VIDEO_ID.test(videoId)
      ? { ok: true, provider: "youtube" }
      : { ok: false, reason: "youtube-single-video" };
  }

  if (hostname === "open.spotify.com") {
    if (
      parts.length !== 2
      || parts[0] !== "track"
      || !SPOTIFY_TRACK_ID.test(parts[1])
    ) {
      return { ok: false, reason: "spotify-single-track" };
    }
    return spotifyEnabled
      ? { ok: true, provider: "spotify" }
      : { ok: false, reason: "spotify-disabled" };
  }
  return { ok: false, reason: "invalid" };
}
