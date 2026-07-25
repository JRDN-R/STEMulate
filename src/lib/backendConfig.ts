export const backendEnabled = String(
  import.meta.env.VITE_STEMULATE_BACKEND_ENABLED || "",
).toLowerCase() === "true";

export const spotifyImportEnabled = String(
  import.meta.env.VITE_ENABLE_SPOTIFY_IMPORT || "",
).toLowerCase() === "true";

export const appCheckSiteKey = String(
  import.meta.env.VITE_FIREBASE_APP_CHECK_SITE_KEY || "",
).trim();

export const functionsRegion = String(
  import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || "us-central1",
).trim();

export const useEmulators = String(
  import.meta.env.VITE_USE_FIREBASE_EMULATORS || "",
).toLowerCase() === "true";

export const backendConfigured = backendEnabled
  && (useEmulators || Boolean(appCheckSiteKey));
