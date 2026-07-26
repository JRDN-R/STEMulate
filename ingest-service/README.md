# STEMulate private ingest service

This is the private Cloud Run worker for owner-authorized, single-track remote
imports. It accepts authenticated Cloud Tasks requests, reads the canonical
YouTube or Spotify source URL from `internalJobs/{jobId}`, produces one
metadata-free M4A audio file, and uploads it through the one-use signed URL
created by Firebase Functions. The resulting Storage finalization event enters
the existing Music.ai pipeline.

The service has no browser endpoint, Music.ai key, Firebase web credential, or
YouTube cookie support. Cloud Run IAM is the authentication boundary. Task
headers are checked only as defense in depth and for retry handling; they are
not treated as user identity.

## Request contract

`POST /tasks/download` accepts exactly:

```json
{
  "jobId": "32-character-lowercase-hex-job-id",
  "ownerUid": "firebase-owner-uid",
  "storageBucket": "stem-ulate.firebasestorage.app",
  "inputPath": "users/OWNER/jobs/JOB/input/source.m4a",
  "uploadUrl": "https://storage.googleapis.com/...signed-v4-url..."
}
```

The Cloud Task must be named `download-JOB` and be dispatched from the queue in
`EXPECTED_TASK_QUEUE`. The service verifies that:

- the bucket equals `STORAGE_BUCKET`;
- the input path is exactly derived from the owner and job IDs;
- the V4 URL targets that exact object on `storage.googleapis.com`;
- `ifGenerationMatch=0` is signed;
- `Content-Type` and both STEMulate metadata headers are signed; and
- the internal job has the same owner, path, `sourceKind=remote`, canonical
  source URL, and provider.

The PUT always sends these fixed headers:

```text
Content-Type: audio/mp4
x-goog-meta-stemulate-source: remote-import
x-goog-meta-stemulate-job-id: JOB
```

A Storage `412 Precondition Failed` response is treated as idempotent success:
another attempt already created the only permitted object generation.

If the upload connection times out, GCS may have committed the object even
though the worker did not receive the response. The first attempt retries; on
the final attempt the worker records `awaiting_finalize` without changing the
internal `awaiting_upload` status. A valid Storage finalize event can therefore
advance the job to Music.ai, while the scheduled 25-hour stale-import cleanup
eventually fails the job when no valid object was created. Retry and failure
writes are Firestore transactions that no-op once Storage finalization has
already changed the internal status.

## Media processing policy

- YouTube watch links from `youtube.com`, `m.youtube.com`, and
  `music.youtube.com`, `youtu.be` links, and Shorts links are all canonicalized
  to one single-video URL before this service receives them. Playlists,
  channels, searches, live videos, private/account-gated videos, and videos
  longer than 20 minutes are rejected.
- YouTube URLs run through pinned `yt-dlp`, EJS, Deno, curl-cffi, and the pinned
  BgUtils PO-token plugin. User-writable plugin directories, cookies, configuration,
  remote components, caches, and interactive input remain unavailable through
  the isolated empty HOME/XDG directories and disabled Python user site. The
  PO-token plugin can contact only the loopback sidecar configured below.
- Spotify track URLs run through spotDL with one thread and YouTube Music then
  YouTube as audio providers. spotDL uses Spotify for metadata; it does not
  retrieve Spotify's audio stream.
- Spotify imports require both `SPOTIFY_CLIENT_ID` and
  `SPOTIFY_CLIENT_SECRET`. They should be credentials for your own official
  Spotify developer application and must be mounted from Secret Manager.
- No client cookies, user credentials, proxies, playlists, albums, channels,
  third-party URL shorteners, or arbitrary URLs are accepted.
- Child processes receive isolated empty HOME/XDG/Deno directories and no
  proxy variables. Commands use fixed argument arrays with `shell=False`.
- Tracks must be at most 20 minutes and 100 MiB. The complete worker operation
  has a 1,380-second deadline, leaving 120 seconds inside the 1,500-second Cloud
  Tasks/Cloud Run request deadline for response and platform teardown.
- The download directory must contain exactly one regular, non-symlinked,
  single-link file.
- ffprobe verifies audio and duration. ffmpeg maps only the first audio stream
  to AAC in an M4A/MP4 container, removes video/cover art, subtitles, data,
  chapters, and metadata, and the result is probed again as exactly one audio
  stream.

Tool stdout/stderr, source URLs, signed URLs, and secrets are never logged or
written to the public job. Public failures contain only bounded error codes and
safe messages.

## Required environment

```text
STORAGE_BUCKET=stem-ulate.firebasestorage.app
EXPECTED_TASK_QUEUE=stemulate-downloads
MAX_TASK_RETRY_COUNT=1
WORK_ROOT=/work
YOUTUBE_POT_PROVIDER_URL=http://127.0.0.1:4416
```

`YOUTUBE_POT_PROVIDER_URL` is required for the recommended multi-container
deployment below. The service accepts only the exact loopback URL shown, so it
cannot be redirected to an arbitrary network service.

Optional globally, but required when a Spotify job is received:

```text
SPOTIFY_CLIENT_ID=<Secret Manager value>
SPOTIFY_CLIENT_SECRET=<Secret Manager value>
```

The Cloud Run service identity uses Application Default Credentials. Do not set
`GOOGLE_APPLICATION_CREDENTIALS` or place a service-account key in the image.

## Build and deploy

The commands below are a concrete first-time downloader setup for project `stem-ulate`.
Run them from the repository root after `gcloud auth login`. They create two
separate identities: the downloader runtime can read Firestore and its two
Spotify secrets; the task identity can only invoke this Cloud Run service.

Set the deployment values once:

```sh
PROJECT_ID=stem-ulate
REGION=us-central1
REPOSITORY=stemulate
SERVICE=stemulate-ingest
QUEUE=stemulate-downloads
IMAGE_TAG=2026-07-25-youtube
POT_IMAGE="docker.io/brainicism/bgutil-ytdlp-pot-provider@sha256:bea3cfda79245700d7ad90500052b4358b1c1828fdc0961929624b83933121bc"
RUNTIME_SA_NAME=stemulate-ingest
INVOKER_SA_NAME=stemulate-task-invoker
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
INVOKER_SA="${INVOKER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/ingest:${IMAGE_TAG}"
gcloud config set project "$PROJECT_ID"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
CLOUD_TASKS_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
test -n "$PROJECT_NUMBER"
```

Enable the required APIs, create the image repository, and create both service
accounts. Each create command is intended to run once:

```sh
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  cloudtasks.googleapis.com \
  firestore.googleapis.com \
  iamcredentials.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com

gcloud artifacts repositories create "$REPOSITORY" \
  --repository-format=docker \
  --location="$REGION" \
  --description="Private STEMulate containers"

gcloud iam service-accounts create "$RUNTIME_SA_NAME" \
  --display-name="STEMulate ingest runtime"
gcloud iam service-accounts create "$INVOKER_SA_NAME" \
  --display-name="STEMulate download task invoker"
```

Enabling Cloud Tasks normally creates its Google-managed primary service agent
and grants `roles/cloudtasks.serviceAgent`. Verify that project-level grant; if
the query prints no row, restore it with the second command. Then allow that
service agent to act as the dedicated task invoker when it mints the task's OIDC
token:

```sh
gcloud projects get-iam-policy "$PROJECT_ID" \
  --flatten='bindings[].members' \
  --filter="bindings.role:roles/cloudtasks.serviceAgent AND bindings.members:serviceAccount:${CLOUD_TASKS_SERVICE_AGENT}" \
  --format='table(bindings.role,bindings.members)'

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${CLOUD_TASKS_SERVICE_AGENT}" \
  --role=roles/cloudtasks.serviceAgent

gcloud iam service-accounts add-iam-policy-binding "$INVOKER_SA" \
  --member="serviceAccount:${CLOUD_TASKS_SERVICE_AGENT}" \
  --role=roles/iam.serviceAccountUser
```

The primary service agent is Google-managed. Do not use it as either the Cloud
Run runtime identity or the task's configured OIDC identity.

Create the Spotify secrets, then paste one value at each prompt and press
Control-D. These must be credentials from your own official Spotify developer
application. If Spotify importing is intentionally disabled, omit both secrets,
both secret IAM bindings, and `--set-secrets` during deploy.

```sh
gcloud secrets create SPOTIFY_CLIENT_ID --replication-policy=automatic
gcloud secrets versions add SPOTIFY_CLIENT_ID --data-file=-
gcloud secrets create SPOTIFY_CLIENT_SECRET --replication-policy=automatic
gcloud secrets versions add SPOTIFY_CLIENT_SECRET --data-file=-
```

Grant only the runtime permissions used by this container. Secret access is
granted on each secret, not across the whole project:

```sh
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/datastore.user

gcloud secrets add-iam-policy-binding SPOTIFY_CLIENT_ID \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding SPOTIFY_CLIENT_SECRET \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/secretmanager.secretAccessor
```

Create the dedicated queue with one concurrent download and two total attempts.
If the queue already exists, use the update command instead. The service value
`MAX_TASK_RETRY_COUNT=1` matches the only retry-count values Cloud Tasks can send
with this policy: `0` on the initial attempt and `1` on the final attempt.

```sh
gcloud tasks queues create "$QUEUE" \
  --location="$REGION" \
  --max-concurrent-dispatches=1 \
  --max-attempts=2 \
  --min-backoff=1500s \
  --max-backoff=1500s \
  --max-doublings=0

gcloud tasks queues update "$QUEUE" \
  --location="$REGION" \
  --max-concurrent-dispatches=1 \
  --max-attempts=2 \
  --min-backoff=1500s \
  --max-backoff=1500s \
  --max-doublings=0
```

The 1,500-second retry delay intentionally exceeds the 1,440-second Firestore
lease. If a container dies after claiming a job but before clearing its lease,
the second and final attempt can safely reclaim it. The 24-hour one-use signed
URL remains valid across that bounded delay.

Build and deploy. This creates one private Cloud Run service with two containers:
the STEMulate ingress worker and a pinned BgUtils PO-token sidecar. They share
only the instance loopback network. The in-memory work volume is mounted only
into the ingress worker and is capped below that container's 2 GiB limit.
`--depends-on` plus the sidecar startup probe prevents the worker from starting
until `GET /ping` succeeds:

```sh
gcloud builds submit ingest-service --tag "$IMAGE"

gcloud run deploy "$SERVICE" \
  --region="$REGION" \
  --service-account="$RUNTIME_SA" \
  --no-allow-unauthenticated \
  --ingress=internal \
  --concurrency=1 \
  --max-instances=1 \
  --min-instances=0 \
  --timeout=1500s \
  --add-volume=name=work,type=in-memory,size-limit=512Mi \
  --container=ingest \
  --image="$IMAGE" \
  --port=8080 \
  --depends-on=pot-provider \
  --cpu=2 \
  --memory=2Gi \
  --add-volume-mount=volume=work,mount-path=/work \
  --set-env-vars=STORAGE_BUCKET=stem-ulate.firebasestorage.app,EXPECTED_TASK_QUEUE=stemulate-downloads,MAX_TASK_RETRY_COUNT=1,WORK_ROOT=/work,YOUTUBE_POT_PROVIDER_URL=http://127.0.0.1:4416 \
  --set-secrets=SPOTIFY_CLIENT_ID=SPOTIFY_CLIENT_ID:latest,SPOTIFY_CLIENT_SECRET=SPOTIFY_CLIENT_SECRET:latest \
  --container=pot-provider \
  --image="$POT_IMAGE" \
  --cpu=1 \
  --memory=512Mi \
  --startup-probe=httpGet.path=/ping,httpGet.port=4416,periodSeconds=1,timeoutSeconds=1,failureThreshold=30

SERVICE_URL="$(gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --format='value(status.url)')"
printf '%s\n' "$SERVICE_URL"
```

Grant the task identity access to this service only:

```sh
gcloud run services add-iam-policy-binding "$SERVICE" \
  --region="$REGION" \
  --member="serviceAccount:${INVOKER_SA}" \
  --role=roles/run.invoker
```

Put `SERVICE_URL`, `stemulate-downloads`, and `INVOKER_SA` into the matching
`DOWNLOADER_*` entries in `functions/.env.stem-ulate`, then deploy the Firebase
Functions. Discover the actual Gen 2 Functions runtime identity instead of
assuming the project's default identity:

```sh
npm --prefix functions run build
firebase deploy --only functions

FUNCTIONS_RUNTIME_SA="$(gcloud functions describe enqueueRemoteDownload \
  --gen2 \
  --region="$REGION" \
  --format='value(serviceConfig.serviceAccountEmail)')"
test -n "$FUNCTIONS_RUNTIME_SA"
printf '%s\n' "$FUNCTIONS_RUNTIME_SA"
```

Grant that exact runtime identity permission to enqueue download tasks and to
act as the dedicated task identity. The self-binding is required for the same
Functions runtime to create the V4 signed upload URL with `signBlob`:

```sh
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${FUNCTIONS_RUNTIME_SA}" \
  --role=roles/cloudtasks.enqueuer

gcloud iam service-accounts add-iam-policy-binding "$INVOKER_SA" \
  --member="serviceAccount:${FUNCTIONS_RUNTIME_SA}" \
  --role=roles/iam.serviceAccountUser

gcloud iam service-accounts add-iam-policy-binding "$FUNCTIONS_RUNTIME_SA" \
  --member="serviceAccount:${FUNCTIONS_RUNTIME_SA}" \
  --role=roles/iam.serviceAccountTokenCreator
```

Newer projects often do not give the Functions runtime a broad default Editor
role. Verify its existing grants, then explicitly grant the data-plane access
used by these Functions if it is absent:

```sh
gcloud projects get-iam-policy "$PROJECT_ID" \
  --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:${FUNCTIONS_RUNTIME_SA}" \
  --format='table(bindings.role)'

gcloud storage buckets get-iam-policy gs://stem-ulate.firebasestorage.app \
  --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:${FUNCTIONS_RUNTIME_SA}" \
  --format='table(bindings.role)'

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${FUNCTIONS_RUNTIME_SA}" \
  --role=roles/datastore.user

gcloud storage buckets add-iam-policy-binding gs://stem-ulate.firebasestorage.app \
  --member="serviceAccount:${FUNCTIONS_RUNTIME_SA}" \
  --role=roles/storage.objectAdmin
```

These are the narrow practical scopes available here: Firestore's predefined
data role is project-wide, while Storage object administration is limited to
the one STEMulate bucket. Do not grant either role to the task-invoker identity.
The downloader runtime needs Firestore but deliberately has no Storage IAM; its
single write uses the preconditioned signed URL.

Cloud Tasks and Cloud Run must be in the same project for internal ingress, and
the OIDC task identity must belong to that project. The Functions task builder
uses the base `run.app` URL as the OIDC audience while targeting
`/tasks/download`.

## Local verification

The unit suite does not contact YouTube, Spotify, Firebase, Storage, or Music.ai:

```sh
cd ingest-service
python -m unittest discover -s tests -v
```

For a local HTTP smoke test, provide ADC plus the required environment and run:

```sh
gunicorn --bind 127.0.0.1:8080 --workers 1 --threads 4 app:app
```

An end-to-end task should be tested only with a short recording you own or are
authorized to process. A browser should never call this service directly.
