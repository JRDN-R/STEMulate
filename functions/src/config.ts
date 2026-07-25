import { defineInt, defineSecret, defineString } from "firebase-functions/params";

export const REGION = "us-central1";
// Cloud Storage event functions must run in the bucket's physical region.
// The stem-ulate.firebasestorage.app bucket was provisioned in us-east1.
export const STORAGE_TRIGGER_REGION = "us-east1";

// Callable CORS is intentionally explicit. GitHub Pages project paths share the
// jrdn-r.github.io origin. Add a custom production origin before deploying it.
export const CALLABLE_CORS: Array<string | RegExp> = [
  "https://jrdn-r.github.io",
  "https://stem-ulate.web.app",
  "https://stem-ulate.firebaseapp.com",
  /^http:\/\/localhost(?::\d+)?$/,
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/,
];

export const MUSIC_AI_API_KEY = defineSecret("MUSIC_AI_API_KEY");

export const OWNER_UIDS = defineString("OWNER_UIDS", {
  description: "Comma-separated Firebase Auth UIDs allowed to use the private app.",
});

export const MUSIC_AI_WORKFLOW_SLUG = defineString(
  "MUSIC_AI_WORKFLOW_SLUG",
  {
    default: "",
    description: "Legacy single Music.ai workflow slug configured for STEMulate.",
  },
);

export const MUSIC_AI_WORKFLOW_SLUGS = defineString("MUSIC_AI_WORKFLOW_SLUGS", {
  default: "",
  description: "Comma-separated key=slug Music.ai workflows. Takes precedence over the legacy single slug.",
});

export const MUSIC_AI_INPUT_PARAM = defineString("MUSIC_AI_INPUT_PARAM", {
  default: "inputUrl",
  description: "Exact public-file input parameter name expected by the workflow.",
});

export const MUSIC_AI_API_BASE_URL = defineString("MUSIC_AI_API_BASE_URL", {
  default: "https://api.music.ai/v1",
  description: "Music.ai API base URL.",
});

export const MUSIC_AI_OUTPUT_HOSTS = defineString("MUSIC_AI_OUTPUT_HOSTS", {
  default: "cdn.music.ai,storage.googleapis.com",
  description: "Exact HTTPS hosts allowed for Music.ai result artifacts and redirects.",
});

export function musicAiOutputHosts(): ReadonlySet<string> {
  const configured = MUSIC_AI_OUTPUT_HOSTS.value().trim()
    || "cdn.music.ai,storage.googleapis.com";
  const hosts = configured
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (
    hosts.length === 0
    || hosts.some((host) =>
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host),
    )
  ) {
    throw new Error("MUSIC_AI_OUTPUT_HOSTS must contain exact comma-separated DNS hostnames.");
  }
  return new Set(hosts);
}

export const MAX_INPUT_BYTES = defineInt("MAX_INPUT_BYTES", {
  default: 524_288_000,
  description: "Maximum accepted source size. Keep this aligned with storage.rules.",
});

export const MAX_OUTPUT_BYTES = defineInt("MAX_OUTPUT_BYTES", {
  default: 1_073_741_824,
  description: "Maximum size of any single Music.ai output artifact.",
});

export const MAX_ANALYSIS_OUTPUT_BYTES = defineInt("MAX_ANALYSIS_OUTPUT_BYTES", {
  default: 16_777_216,
  description: "Maximum size of JSON or text analysis data returned to the browser.",
});

export const MAX_OUTPUT_FILES = defineInt("MAX_OUTPUT_FILES", {
  default: 32,
  description: "Maximum number of Music.ai output artifacts materialized per job.",
});

export const POLL_INITIAL_DELAY_SECONDS = defineInt(
  "POLL_INITIAL_DELAY_SECONDS",
  { default: 15 },
);

export const POLL_MAX_DELAY_SECONDS = defineInt("POLL_MAX_DELAY_SECONDS", {
  default: 60,
});

export const MUSIC_AI_MAX_POLLS = defineInt("MUSIC_AI_MAX_POLLS", {
  default: 180,
  description: "Maximum explicit status polls before marking a job timed out.",
});

export const DOWNLOADER_SERVICE_URL = defineString("DOWNLOADER_SERVICE_URL", {
  default: "https://replace-with-private-cloud-run-service.run.app",
  description: "Base URL of the private STEMulate yt-dlp/spotDL Cloud Run service.",
});

export const DOWNLOADER_QUEUE_ID = defineString("DOWNLOADER_QUEUE_ID", {
  default: "stemulate-downloads",
  description: "Cloud Tasks queue used for remote single-track imports.",
});

export const DOWNLOADER_INVOKER_SERVICE_ACCOUNT = defineString(
  "DOWNLOADER_INVOKER_SERVICE_ACCOUNT",
  {
    default: "replace-with-task-invoker@stem-ulate.iam.gserviceaccount.com",
    description: "Service account Cloud Tasks uses to invoke the private downloader.",
  },
);

export const REMOTE_IMPORT_MAX_BYTES = defineInt("REMOTE_IMPORT_MAX_BYTES", {
  default: 104_857_600,
  description: "Maximum normalized audio size accepted from yt-dlp or spotDL.",
});

export const REMOTE_IMPORT_DAILY_LIMIT = defineInt("REMOTE_IMPORT_DAILY_LIMIT", {
  default: 10,
  description: "Maximum new remote imports an owner may create per UTC day.",
});
