# STEMulate private preview-stream service

This Cloud Run service turns the already-stored Music.ai stem outputs into
small, synchronized AAC-LC playback streams. It never replaces, modifies, or
deletes the original WAV/FLAC outputs. STEMulate continues to use those
originals for stem export.

Cloud Run IAM is the authentication boundary. The only work endpoint accepts
Cloud Tasks requests; there is no public browser API and no Firebase or
Music.ai secret in this image.

## Request contract

`POST /tasks/preview` accepts:

```json
{
  "jobId": "Firestore-job-id",
  "ownerUid": "firebase-owner-uid",
  "attempt": 1,
  "storageBucket": "stem-ulate.firebasestorage.app",
  "outputs": [
    {
      "key": "vocals",
      "storagePath": "users/OWNER/jobs/JOB/outputs/vocals.wav",
      "contentType": "audio/wav",
      "sizeBytes": 12345678
    }
  ],
  "manifestPath": "users/OWNER/jobs/JOB/streams/v1/attempt-1/manifest.json"
}
```

The task must be named `preview-JOB-v1-ATTEMPT` (attempt 1–99) and come from
`EXPECTED_TASK_QUEUE`.
The service validates all of the following before reading audio:

- owner and job IDs contain only letters, digits, `_`, or `-`;
- the bucket is exactly `STORAGE_BUCKET`;
- every source is a direct child of
  `users/OWNER/jobs/JOB/outputs/`;
- the manifest path is exactly
  `users/OWNER/jobs/JOB/streams/v1/attempt-ATTEMPT/manifest.json`;
- both `internalJobs/JOB` and `users/OWNER/jobs/JOB` exist, have the exact
  owner, and retain main `status=completed`;
- the task attempt and manifest path are still the active generation recorded
  in Firestore, so a delayed task cannot overwrite a newer retry;
- the supplied output list, including keys, paths, content types, and sizes,
  exactly matches both authoritative Firestore output records; and
- the bounded source objects still have their recorded sizes.

Task headers are checked as defense in depth. They are not treated as caller
identity; Cloud Run IAM verifies the task's OIDC token.

## Stream and manifest contract

Each recognized canonical stem is normalized to 48 kHz, padded to the longest
stem, trimmed to one common packet-aligned duration, and encoded by ffmpeg as
AAC-LC in an ADTS stream. The supported IDs are:

```text
vocals drums kick snare toms hi_hat cymbals bass guitars piano keys strings wind other
```

Drum-component names are matched before the generic `drums` stem, so outputs
such as `drums__kick`, `drum-snare`, and `percussion_hi-hat` retain their
specific component IDs.

The service parses every ADTS header after encoding. It accepts only AAC-LC,
48 kHz, one raw AAC block per packet, and mono or stereo channel
configurations. All stems must contain the same number of 1,024-sample AAC
packets.

Streams are stored at:

```text
users/OWNER/jobs/JOB/streams/v1/attempt-ATTEMPT/STEM.aac
```

The manifest is uploaded last and has this shape:

```json
{
  "version": 1,
  "codec": "mp4a.40.2",
  "bitstream": "adts",
  "sampleRate": 48000,
  "packetFrames": 1024,
  "durationFrames": 8306688,
  "stems": {
    "vocals": {
      "storagePath": "users/OWNER/jobs/JOB/streams/v1/attempt-1/vocals.aac",
      "channels": 2,
      "sizeBytes": 3478123,
      "windows": [
        {
          "startFrame": 0,
          "frameCount": 245760,
          "prerollByteStart": 0,
          "byteStart": 428,
          "byteEndExclusive": 103456
        }
      ]
    }
  }
}
```

Each full window contains 240 AAC packets:
`240 × 1,024 / 48,000 = 5.12 seconds`. The last window can be shorter.
Byte ranges are contiguous, end-exclusive, and always start and end on ADTS
packet boundaries. Every window's `prerollByteStart` points to exactly one
preceding AAC packet. For the first window that packet is FFmpeg's encoder
priming packet; for later windows it restores AAC's overlap state. The browser
decodes and discards the packet, preventing a global 1,024-frame delay and
clicks at window boundaries. It can therefore range-read a few seconds per
stem without decoding entire tracks into iPhone memory.

## Safety, retries, and idempotence

- Tracks are limited to 20 minutes.
- One source is limited to 512 MiB; all sources together are limited to 2 GiB.
- One preview is limited to 64 MiB; all previews together are limited to
  512 MiB.
- The request is limited to 128 KiB and the manifest to 512 KiB.
- ffprobe and ffmpeg use fixed argument arrays with `shell=False`; tool output
  is suppressed or bounded.
- Child processes have a minimal environment and run in a private temporary
  directory.
- GCS downloads are pinned to the generation observed before download.
- Streams and the manifest use `ifGenerationMatch=0`. A retry accepts an
  existing object only when its size, MIME type, and SHA-256 metadata match.
- Each explicit retry uses a new attempt directory. Old immutable generations
  can therefore never block regeneration and a stale worker cannot publish
  into the active generation.
- `previewStatus` is written independently of the completed Music.ai job
  status. The service writes `processing`, `retrying`, `failed`, or
  `awaiting_finalize`; it never changes the main job status or original output
  list.
- The service keeps its fenced lease while it writes `awaiting_finalize` and
  creates the manifest last. If that final upload fails, the same lease can
  safely move the job to `retrying` or `failed`. The Storage finalization
  transaction is the authoritative writer of `previewStatus=ready`; it clears
  the lease and rejects manifests from superseded attempts.
- A callable status check replaces an expired `processing` or
  missing-manifest `awaiting_finalize` lease with a new attempt-scoped task.
  This recovers even if every delivery of the crashed task was exhausted.
- Logs and public errors never contain source paths, media names, signed URLs,
  tool output, or raw exception messages.

## Required environment

```text
STORAGE_BUCKET=stem-ulate.firebasestorage.app
EXPECTED_TASK_QUEUE=stemulate-previews
MAX_TASK_RETRY_COUNT=9
PREVIEW_BITRATE_KBPS=160
WORK_ROOT=/work
```

`PREVIEW_BITRATE_KBPS` accepts 64–320. At the default 160 kbps, fourteen stems
use about 2.24 Mbps while actively streaming, before normal HTTP overhead.

The service uses Application Default Credentials from its Cloud Run service
account. Do not create a service-account key or set
`GOOGLE_APPLICATION_CREDENTIALS`.

## Test

From `stream-service/`:

```sh
python -m pip install --requirement requirements.txt
PYTHONPATH=.:tests python -m unittest discover -s tests -p 'test_*.py' -v
```

Tests cover strict task/path validation, Firestore ownership and state
transactions, GCS generation/size/create-only behavior, idempotent conflicts,
safe failures, mocked end-to-end packaging, fixed ffmpeg/ffprobe commands,
manifest validation, and a pure ADTS parser/indexer.

## Build and deploy

The following is a first-time example for project `stem-ulate`. Review the
values before running it. These commands are documentation only; this
repository change does not deploy the service.

Set deployment values:

```sh
PROJECT_ID=stem-ulate
REGION=us-central1
REPOSITORY=stemulate
SERVICE=stemulate-streams
QUEUE=stemulate-previews
IMAGE_TAG=2026-07-25
RUNTIME_SA_NAME=stemulate-streams
INVOKER_SA_NAME=stemulate-preview-invoker
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
INVOKER_SA="${INVOKER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/streams:${IMAGE_TAG}"
gcloud config set project "$PROJECT_ID"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
CLOUD_TASKS_SERVICE_AGENT="service-${PROJECT_NUMBER}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
test -n "$PROJECT_NUMBER"
```

Enable APIs and create the two dedicated identities:

```sh
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  cloudtasks.googleapis.com \
  firestore.googleapis.com \
  iamcredentials.googleapis.com \
  run.googleapis.com \
  storage.googleapis.com

gcloud artifacts repositories describe "$REPOSITORY" \
  --location="$REGION" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$REPOSITORY" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Private STEMulate containers"

gcloud iam service-accounts describe "$RUNTIME_SA" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$RUNTIME_SA_NAME" \
    --display-name="STEMulate preview stream runtime"

gcloud iam service-accounts describe "$INVOKER_SA" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$INVOKER_SA_NAME" \
    --display-name="STEMulate preview task invoker"
```

Grant only Firestore use plus read/create access to the configured bucket.
Neither role permits this runtime to delete original stems:

```sh
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/datastore.user

gcloud storage buckets add-iam-policy-binding \
  "gs://stem-ulate.firebasestorage.app" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/storage.objectViewer

gcloud storage buckets add-iam-policy-binding \
  "gs://stem-ulate.firebasestorage.app" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/storage.objectCreator
```

Build and deploy a private, concurrency-one service:

```sh
gcloud builds submit stream-service --tag "$IMAGE"

gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --platform=managed \
  --no-allow-unauthenticated \
  --service-account="$RUNTIME_SA" \
  --cpu=2 \
  --memory=4Gi \
  --concurrency=1 \
  --min-instances=0 \
  --max-instances=2 \
  --timeout=900 \
  --set-env-vars="STORAGE_BUCKET=stem-ulate.firebasestorage.app,EXPECTED_TASK_QUEUE=${QUEUE},MAX_TASK_RETRY_COUNT=9,PREVIEW_BITRATE_KBPS=160,WORK_ROOT=/work"

SERVICE_URL="$(gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --format='value(status.url)')"
test -n "$SERVICE_URL"

gcloud run services add-iam-policy-binding "$SERVICE" \
  --region="$REGION" \
  --member="serviceAccount:${INVOKER_SA}" \
  --role=roles/run.invoker
```

Create the bounded Cloud Tasks queue if necessary, then apply its retry
configuration even when the queue already exists:

```sh
gcloud tasks queues describe "$QUEUE" --location="$REGION" >/dev/null 2>&1 \
  || gcloud tasks queues create "$QUEUE" \
    --location="$REGION" \
    --max-concurrent-dispatches=1

gcloud tasks queues update "$QUEUE" \
  --location="$REGION" \
  --max-concurrent-dispatches=1 \
  --max-dispatches-per-second=1 \
  --max-attempts=10 \
  --max-retry-duration=3600s \
  --min-backoff=30s \
  --max-backoff=300s \
  --max-doublings=3
```

Ten attempts allow a delivery that encounters the worker's bounded lease to
remain queued past lease expiry. Attempt-scoped callable recovery is still the
backstop after queue exhaustion.

Allow the Cloud Tasks service agent to mint the dedicated invoker's OIDC token:

```sh
gcloud iam service-accounts add-iam-policy-binding "$INVOKER_SA" \
  --member="serviceAccount:${CLOUD_TASKS_SERVICE_AGENT}" \
  --role=roles/iam.serviceAccountUser
```

Configure the Firebase Functions deployment with:

```text
PREVIEW_SERVICE_URL=<SERVICE_URL>
PREVIEW_QUEUE_ID=stemulate-previews
PREVIEW_INVOKER_SERVICE_ACCOUNT=<INVOKER_SA>
```

The Functions runtime identity that creates HTTP tasks also needs
`iam.serviceAccounts.actAs` on `INVOKER_SA`. Grant
`roles/iam.serviceAccountUser` on that one service account to the exact
Functions runtime identity; do not grant it project-wide. It separately needs
permission to create tasks:

```sh
FUNCTIONS_RUNTIME_SA="$(gcloud functions describe requestProcessingPreview \
  --gen2 \
  --region="$REGION" \
  --format='value(serviceConfig.serviceAccountEmail)')"
test -n "$FUNCTIONS_RUNTIME_SA"

gcloud iam service-accounts add-iam-policy-binding "$INVOKER_SA" \
  --member="serviceAccount:${FUNCTIONS_RUNTIME_SA}" \
  --role=roles/iam.serviceAccountUser

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${FUNCTIONS_RUNTIME_SA}" \
  --role=roles/cloudtasks.enqueuer
```

After Functions and the browser streaming transport are deployed, submit one
new track and verify:

```sh
gcloud run services logs read "$SERVICE" \
  --region="$REGION" \
  --limit=50
```

The expected sequence is `processing` → `awaiting_finalize` → `ready`, with
the original `status=completed` and original `outputs` unchanged.
