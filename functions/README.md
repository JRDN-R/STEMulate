# STEMulate Firebase backend

This directory contains the private control plane for STEMulate. The browser
creates a job with an App Check-protected callable, uploads the source directly
to Cloud Storage, and watches its owner-only Firestore record. A Storage event
then submits one or more short Music.ai requests against the same signed input.
Cloud Tasks polls each status with delayed, finite invocations, merges their
results, and copies successful output URLs into private Storage.

No Music.ai key or signed source URL is ever returned to the browser or stored
in the client-readable job document. `yt-dlp` and spotDL live in the separate
private Cloud Run service under `../ingest-service`; they are never bundled into
the static site or an HTTP callable.

## 1. Prerequisites

- Upgrade `stem-ulate` to Firebase Blaze. Functions, Cloud Tasks, Secret Manager,
  and this project's Cloud Storage usage require billing.
- Install Node.js 22, `firebase-tools`, and the Google Cloud CLI.
- Enable a Firebase Authentication provider and create the one account that will
  own the app.
- In Authentication > Settings > Authorized domains, add
  `jrdn-r.github.io` (and any future custom domain).
- For the live private app, prefer a dedicated custom domain rather than a
  GitHub project path. All `OWNER.github.io/*` projects share one origin and
  therefore one Firebase/local-storage security boundary.
- Create and test either one combined Music.ai workflow or the three saved
  templates **Basic Stems - Auto**, **Chords and Beat Mapping**, and
  **Song Sections**. Every workflow's public-file input must exactly match the
  configured `MUSIC_AI_INPUT_PARAM`. In the Song Sections graph, keep its Beats
  module connected so `beatMap` feeds the Sections module's `inputBeatsUrl`.
- Deploy the private downloader by following `../ingest-service/README.md`. Copy
  its `run.app` base URL and create the `stemulate-downloads` Cloud Tasks queue.

## 2. Install and configure

```sh
npm --prefix functions install
cp functions/.env.example functions/.env.stem-ulate
firebase login
firebase use stem-ulate
firebase functions:secrets:set MUSIC_AI_API_KEY
```

Edit `functions/.env.stem-ulate` with the Firebase Auth UID, Music.ai workflow
slug(s), exact workflow input parameter, private downloader URL, queue name, and
task-invoker service-account email. For the three-template setup, use:

```text
MUSIC_AI_WORKFLOW_SLUGS=stems=stemulate-multistem,mapping=stemulate-harmony-beats,sections=stemulate-song-sections
MUSIC_AI_WORKFLOW_SLUG=
MUSIC_AI_INPUT_PARAM=inputUrl
```

These are the exact slugs of the three workflows already saved in the Music.ai
workspace. The stable names to the left of each `=` are internal keys. Named
entries are preferred over bare comma-separated slugs because they remain stable
if the list is reordered. `MUSIC_AI_WORKFLOW_SLUGS` takes precedence. For a
single combined workflow, leave it empty and set the backward-compatible
`MUSIC_AI_WORKFLOW_SLUG` instead.

The Music.ai API uses the raw API key
as its `Authorization` header; never prefix it with `Bearer` and never copy the
key into frontend configuration. Firebase web configuration is public by design,
but this API secret is not.

Apply the included read-only browser CORS policy to the Storage bucket so the
short-lived output URLs can stream from GitHub Pages. Add any future custom site
origin to `storage.cors.json` first:

```sh
gcloud storage buckets update gs://stem-ulate.firebasestorage.app --cors-file=storage.cors.json
```

Set the matching custom claim used by Firestore and Storage Rules. The helper
uses Application Default Credentials and preserves existing custom claims:

```sh
gcloud auth application-default login
GCLOUD_PROJECT=stem-ulate npm --prefix functions run set-owner -- YOUR_AUTH_UID
```

Sign out and back in after changing claims. The Functions allowlist and the
`owner=true` claim are both required.

## 3. App Check

Register the Firebase web app with App Check (reCAPTCHA Enterprise is suitable
for production web use), initialize App Check before calling Functions, and use
a registered debug token during local browser development. Callables in this
scaffold already set `enforceAppCheck: true`. Also enable App Check enforcement
for Cloud Storage in the Firebase console after the client integration works.

The Firebase Emulator Suite can be started with:

```sh
npm --prefix functions run serve
```

For the local browser, set `VITE_STEMULATE_BACKEND_ENABLED=true` and
`VITE_USE_FIREBASE_EMULATORS=true` in `.env.local`. Use the Auth, Functions,
Firestore, and Storage emulators together; do not point an emulator client at
production Storage.

## 4. Deploy

```sh
npm --prefix functions run build
firebase deploy --only firestore,storage,functions
```

The first deployment may prompt to enable Cloud Functions, Cloud Run, Eventarc,
Pub/Sub, Cloud Build, Artifact Registry, Cloud Tasks, Secret Manager, and IAM
Credentials APIs. Firebase creates queues for task functions, but the downloader
uses the separate pre-created `stemulate-downloads` queue. Its Firestore outbox
trigger needs `roles/cloudtasks.enqueuer` and permission to act as the dedicated
task-invoker service account. Exact IAM commands are in the downloader README.

Creating the V4 signed source URL requires the runtime service account to sign
blobs. If `signBlob` is denied, enable the IAM Service Account Credentials API
and grant that runtime service account `roles/iam.serviceAccountTokenCreator` on
itself. Use the service account shown on the deployed function rather than
guessing its address.

## Browser contract

1. Call `createProcessingJob` with `{ displayName, fileName, contentType,
   sizeBytes }` while authenticated and App Check-attested.
2. Upload exactly that file to the returned `inputPath` with the same `audio/*`
   or supported `video/*` content type. Use `uploadBytesResumable`; media does
   not pass through an HTTP Function.
3. Listen to `users/{uid}/jobs/{jobId}`. Status progresses through
   `awaiting_upload`, `queued`, `processing`, and `completed` or `failed`.
4. On completion, call the App Check-protected `getProcessingOutputs` callable.
   It returns owner-only signed playback URLs that expire after six hours; no
permanent Firebase download token is attached to the stored output.

For a remote source, call `createRemoteProcessingJob` with `{ url,
clientRequestId, rightsConfirmed: true }`. `clientRequestId` must be one browser-
generated UUID and is used to make retries idempotent. Only one YouTube video or
one Spotify track URL is accepted. The client then observes the same public job
record; it never receives the source URL stored in `internalJobs`, the signed
write URL placed in the Cloud Task, or downloader credentials.

The backend stores Music.ai IDs and temporary source/output URLs only in
`internalJobs/{jobId}`, which all client rules deny.

## Operational notes

- `storage.rules` has a 500 MiB source cap. Keep it equal to
  `MAX_INPUT_BYTES`; rules cannot read Functions deployment parameters.
- JSON and text analysis artifacts are capped independently by
  `MAX_ANALYSIS_OUTPUT_BYTES` (16 MiB by default) before they can reach iOS.
- Remote imports have an independent 100 MiB normalized-output cap, 20-minute
  duration cap in the worker, and configurable ten-new-jobs-per-UTC-day default.
  Browser Storage Rules permit uploads only for `sourceType == "upload"`, so an
  owner client cannot spoof a downloader result for a remote job.
- Polling is explicit delayed Cloud Tasks work, not a sleeping Function. The
  default 180-poll window applies independently to each workflow and backs off
  from 15 to 60 seconds.
- Music.ai does not document an idempotency key for `POST /job`. This scaffold
  records a separate submission lease and paid job ID for each workflow and
  refuses blind automatic retries after an ambiguous network failure. The
  workflow plan is snapshotted when the source upload is accepted, so changing
  deployment configuration cannot silently redirect an in-flight job. Check
  Music.ai before intentionally creating a replacement job in that rare case.
- All configured workflows must succeed before output copies start. Their
  outputs retain the original flat key for frontend compatibility. If two
  workflows expose the same key, the first keeps it and later collisions use
  `workflowKey__outputKey`. `MAX_OUTPUT_FILES` applies to the merged total.
- Output-copy tasks are deterministic and idempotent by output key. A permanently
  unreachable Music.ai result is retried with backoff and then moves the public
  job to a visible failed state.
- Inputs and outputs are retained. Add a deliberate cleanup callable or Storage
  lifecycle policy once the desired retention period is known.
- Before using a custom site origin, add it to `CALLABLE_CORS` in
  `src/config.ts` and to Firebase Authentication authorized domains.
