import type { RemoteSourceProvider } from "../types";

const YOUTUBE_TRACK_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

export type RemoteImportUrlValidation =
  | { ok: true; provider: RemoteSourceProvider }
  | { ok: false; reason: "invalid" | "spotify-disabled" };

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

  if (url.protocol !== "https:") return { ok: false, reason: "invalid" };
  const hostname = url.hostname.toLowerCase();
  if (YOUTUBE_TRACK_HOSTS.has(hostname)) return { ok: true, provider: "youtube" };
  if (hostname === "open.spotify.com") {
    return spotifyEnabled
      ? { ok: true, provider: "spotify" }
      : { ok: false, reason: "spotify-disabled" };
  }
  return { ok: false, reason: "invalid" };
}
