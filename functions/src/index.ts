import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFunctions } from "firebase-admin/functions";
import { getStorage } from "firebase-admin/storage";
import { logger } from "firebase-functions";
import { setGlobalOptions } from "firebase-functions/v2";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

import { requireOwner } from "./auth";
import {
  CALLABLE_CORS,
  MAX_INPUT_BYTES,
  MAX_ANALYSIS_OUTPUT_BYTES,
  MAX_OUTPUT_BYTES,
  MUSIC_AI_API_KEY,
  MUSIC_AI_MAX_POLLS,
  musicAiOutputHosts,
  POLL_INITIAL_DELAY_SECONDS,
  POLL_MAX_DELAY_SECONDS,
  REGION,
  REMOTE_IMPORT_DAILY_LIMIT,
  REMOTE_IMPORT_MAX_BYTES,
} from "./config";
import { downloaderConfig, enqueueDownloadTask } from "./download-tasks";
import {
  configuredMusicAiWorkflows,
  extractScalarAnalysis,
  extractResultSources,
  getMusicAiJob,
  mergeMusicAiWorkflowResults,
  musicAiSubmissionDisposition,
  MusicAiHttpError,
  submitMusicAiJob as createMusicAiJob,
  type MusicAiCreateResponse,
  type MusicAiJobResponse,
  type MusicAiStatus,
  type MusicAiWorkflow,
  type ResultSource,
} from "./music-ai";
import {
  canonicalizeRemoteTrackUrl,
  remoteJobId,
  type RemoteProvider,
  validateClientRequestId,
} from "./remote-import";

initializeApp();
setGlobalOptions({ region: REGION, maxInstances: 10 });

const db = getFirestore();
const ALLOWED_EXTENSIONS = new Set([
  "aac",
  "aif",
  "aiff",
  "flac",
  "m4a",
  "mp3",
  "ogg",
  "opus",
  "wav",
  "m4v",
  "mov",
  "mp4",
]);

type PublicStatus =
  | "awaiting_upload"
  | "queued"
  | "processing"
  | "completed"
  | "failed";

interface CreateJobInput {
  displayName?: unknown;
  fileName?: unknown;
  contentType?: unknown;
  sizeBytes?: unknown;
}

interface CreateRemoteJobInput {
  url?: unknown;
  clientRequestId?: unknown;
  rightsConfirmed?: unknown;
}

interface GetOutputsInput {
  jobId?: unknown;
}

interface SubmitTaskData {
  jobId: string;
  ownerUid: string;
  inputUrl: string;
  workflowKey?: string;
}

interface PollTaskData {
  jobId: string;
  ownerUid: string;
  attempt: number;
  workflowKey?: string;
}

interface CopyTaskData {
  jobId: string;
  ownerUid: string;
  outputKey: string;
  attempt: number;
}

interface StoredOutput {
  key: string;
  storagePath: string;
  contentType: string;
  sizeBytes: number;
}

interface InternalMusicAiWorkflow {
  slug: string;
  musicAiJobId?: string;
  submissionAttemptedAt?: Timestamp;
  submissionLeaseUntil?: Timestamp;
  musicAiStatus?: MusicAiStatus;
  pollAttempt?: number;
  resultSources?: Record<string, ResultSource>;
  analysis?: Record<string, string | number | boolean>;
}

interface InternalJob {
  ownerUid: string;
  inputPath: string;
  status: PublicStatus;
  sourceKind?: "upload" | "remote";
  sourceProvider?: RemoteProvider;
  sourceUrl?: string;
  clientRequestId?: string;
  downloadStatus?: string;
  downloadLeaseUntil?: Timestamp;
  expectedContentType?: string;
  expectedSizeBytes?: number;
  musicAiWorkflowOrder?: string[];
  musicAiWorkflows?: Record<string, InternalMusicAiWorkflow>;
  // Legacy fields are retained for records made by the original single-workflow
  // deployment. New work is stored in musicAiWorkflows, including when only the
  // legacy MUSIC_AI_WORKFLOW_SLUG configuration is used.
  musicAiJobId?: string;
  submissionAttemptedAt?: Timestamp;
  submissionLeaseUntil?: Timestamp;
  pollAttempt?: number;
  resultSources?: Record<string, ResultSource>;
  expectedOutputKeys?: string[];
  outputs?: Record<string, StoredOutput>;
  analysis?: Record<string, string | number | boolean>;
  createdAt?: Timestamp;
}

function workflowPlanForJob(job: InternalJob): MusicAiWorkflow[] {
  const order = job.musicAiWorkflowOrder ?? [];
  const stored = job.musicAiWorkflows ?? {};
  if (order.length > 0 && order.every((key) => Boolean(stored[key]?.slug))) {
    return order.map((key) => ({ key, slug: stored[key].slug }));
  }
  return configuredMusicAiWorkflows();
}

function workflowForTask(job: InternalJob, workflowKey?: string): MusicAiWorkflow {
  const plan = workflowPlanForJob(job);
  if (!workflowKey && plan.length === 1) return plan[0];
  const workflow = plan.find(({ key }) => key === workflowKey);
  if (!workflow) throw new Error("Music.ai workflow task does not match the job plan.");
  return workflow;
}

function workflowStateForJob(
  job: InternalJob,
  workflow: MusicAiWorkflow,
): InternalMusicAiWorkflow {
  const stored = job.musicAiWorkflows?.[workflow.key];
  if (stored) return stored;
  const plan = workflowPlanForJob(job);
  if (plan.length === 1 && job.musicAiJobId) {
    return {
      slug: workflow.slug,
      musicAiJobId: job.musicAiJobId,
      submissionAttemptedAt: job.submissionAttemptedAt,
      submissionLeaseUntil: job.submissionLeaseUntil,
      pollAttempt: job.pollAttempt,
    };
  }
  return { slug: workflow.slug };
}

function publicJobRef(ownerUid: string, jobId: string) {
  return db.doc(`users/${ownerUid}/jobs/${jobId}`);
}

function internalJobRef(jobId: string) {
  return db.doc(`internalJobs/${jobId}`);
}

function queue(functionName: string) {
  return getFunctions().taskQueue(
    `locations/${REGION}/functions/${functionName}`,
  );
}

function isAlreadyExists(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === 6
    || code === "6"
    || code === "already-exists"
    || code === "task-already-exists"
    || code === "functions/task-already-exists";
}

async function enqueueOnce(
  functionName: string,
  data: object,
  taskId: string,
  scheduleDelaySeconds = 0,
): Promise<void> {
  try {
    await queue(functionName).enqueue(data, { id: taskId, scheduleDelaySeconds });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    logger.info("Task already exists; treating enqueue as idempotent.", {
      functionName,
      taskId,
    });
  }
}

function extensionFrom(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  if (!match || !ALLOWED_EXTENSIONS.has(match[1])) {
    throw new HttpsError(
      "invalid-argument",
      "Use a supported audio or video file (MP3, WAV, M4A, AAC, FLAC, OGG, OPUS, AIFF, MP4, MOV, or M4V).",
    );
  }
  return match[1];
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new HttpsError("invalid-argument", `${field} is invalid.`);
  }
  return value.trim();
}

async function markFailed(
  jobId: string,
  ownerUid: string,
  code: string,
  message: string,
): Promise<void> {
  const error = { code, message: message.slice(0, 500) };
  const internalRef = internalJobRef(jobId);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(internalRef);
    if (!snapshot.exists) return;
    const job = snapshot.data() as InternalJob;
    if (job.ownerUid !== ownerUid) {
      throw new Error("Failure owner does not match job owner.");
    }
    // Cloud Tasks are at-least-once. A slower duplicate must never overwrite a
    // terminal state committed by a successful sibling.
    if (job.status === "completed" || job.status === "failed") return;
    transaction.set(
      internalRef,
      { status: "failed", error, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    transaction.set(
      publicJobRef(ownerUid, jobId),
      {
        status: "failed",
        stage: "failed",
        error,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

function safeErrorFields(error: unknown): Record<string, string | number | boolean> {
  if (error instanceof MusicAiHttpError) {
    return {
      errorType: error.name,
      httpStatus: error.status,
      retryable: error.retryable,
    };
  }
  return {
    errorType: error instanceof Error ? error.name.slice(0, 80) : "UnknownError",
  };
}

export const createProcessingJob = onCall<CreateJobInput>(
  {
    cors: CALLABLE_CORS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (request) => {
    const ownerUid = requireOwner(request);
    const fileName = requiredString(request.data.fileName, "fileName", 255);
    const contentType = requiredString(request.data.contentType, "contentType", 100);
    const displayName = request.data.displayName === undefined
      ? fileName.replace(/\.[^.]+$/, "")
      : requiredString(request.data.displayName, "displayName", 120);
    const sizeBytes = request.data.sizeBytes;

    if (!/^(audio|video)\//.test(contentType)) {
      throw new HttpsError("invalid-argument", "The source must be an audio or video file.");
    }
    if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) <= 0) {
      throw new HttpsError("invalid-argument", "sizeBytes must be a positive integer.");
    }
    if (Number(sizeBytes) > MAX_INPUT_BYTES.value()) {
      throw new HttpsError(
        "invalid-argument",
        `The source exceeds the ${MAX_INPUT_BYTES.value()} byte upload limit.`,
      );
    }

    const extension = extensionFrom(fileName);
    const jobId = internalJobRef("placeholder").parent.doc().id;
    const inputPath = `users/${ownerUid}/jobs/${jobId}/input/source.${extension}`;
    const now = FieldValue.serverTimestamp();

    const publicRecord = {
      id: jobId,
      ownerUid,
      displayName,
      sourceFileName: fileName,
      contentType,
      sizeBytes: Number(sizeBytes),
      inputPath,
      sourceType: "upload" as const,
      status: "awaiting_upload" as const,
      stage: "awaiting_upload",
      outputs: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const internalRecord = {
      ownerUid,
      inputPath,
      expectedContentType: contentType,
      expectedSizeBytes: Number(sizeBytes),
      sourceKind: "upload" as const,
      status: "awaiting_upload" as const,
      createdAt: now,
      updatedAt: now,
    };

    const batch = db.batch();
    batch.create(publicJobRef(ownerUid, jobId), publicRecord);
    batch.create(internalJobRef(jobId), internalRecord);
    await batch.commit();

    return {
      jobId,
      inputPath,
      status: "awaiting_upload",
      maxInputBytes: MAX_INPUT_BYTES.value(),
    };
  },
);

function remoteInputError(error: unknown): HttpsError {
  const code = error instanceof Error ? error.message : "SOURCE_URL_INVALID";
  const messages: Record<string, string> = {
    SOURCE_URL_INVALID: "Enter a valid HTTPS YouTube or Spotify track URL.",
    SOURCE_PROVIDER_UNSUPPORTED: "Only YouTube videos and Spotify tracks are supported.",
    SPOTIFY_SINGLE_TRACK_REQUIRED: "Use one Spotify track URL, not a playlist, album, artist, or search.",
    YOUTUBE_SINGLE_VIDEO_REQUIRED: "Use one YouTube video URL, not a channel, search, or playlist.",
    YOUTUBE_PLAYLISTS_UNSUPPORTED: "YouTube playlists are not supported. Paste one video URL.",
    YOUTUBE_VIDEO_ID_INVALID: "The YouTube video ID is invalid.",
    CLIENT_REQUEST_ID_INVALID: "The import request identifier is invalid.",
  };
  return new HttpsError("invalid-argument", messages[code] ?? messages.SOURCE_URL_INVALID);
}

export const createRemoteProcessingJob = onCall<CreateRemoteJobInput>(
  {
    cors: CALLABLE_CORS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (request) => {
    const ownerUid = requireOwner(request);
    if (request.data.rightsConfirmed !== true) {
      throw new HttpsError(
        "failed-precondition",
        "Confirm that you have permission to download, process, and transmit this track.",
      );
    }

    let source;
    let clientRequestId;
    try {
      source = canonicalizeRemoteTrackUrl(request.data.url);
      clientRequestId = validateClientRequestId(request.data.clientRequestId);
    } catch (error) {
      throw remoteInputError(error);
    }
    try {
      // Refuse to create an orphaned job when the private worker is not configured.
      downloaderConfig();
    } catch (error) {
      logger.error("The private downloader is not configured.", safeErrorFields(error));
      throw new HttpsError(
        "failed-precondition",
        "Remote imports are not configured on this STEMulate deployment yet.",
      );
    }

    const jobId = remoteJobId(ownerUid, clientRequestId);
    const inputPath = `users/${ownerUid}/jobs/${jobId}/input/source.m4a`;
    const publicRef = publicJobRef(ownerUid, jobId);
    const internalRef = internalJobRef(jobId);
    const usageDate = new Date().toISOString().slice(0, 10);
    const usageRef = db.doc(`remoteImportUsage/${remoteJobId(ownerUid, usageDate)}`);
    const now = FieldValue.serverTimestamp();

    await db.runTransaction(async (transaction) => {
      const existingPublic = await transaction.get(publicRef);
      const existingInternal = await transaction.get(internalRef);
      if (existingPublic.exists || existingInternal.exists) {
        const existing = existingInternal.data() as InternalJob | undefined;
        if (
          !existingPublic.exists
          || !existingInternal.exists
          || existing?.ownerUid !== ownerUid
          || existing?.sourceKind !== "remote"
          || existing?.sourceUrl !== source.url
          || existing?.clientRequestId !== clientRequestId
          || existing?.inputPath !== inputPath
        ) {
          throw new HttpsError("already-exists", "That import request conflicts with an existing job.");
        }
        return;
      }

      const usageSnapshot = await transaction.get(usageRef);
      const usageCount = Number(usageSnapshot.data()?.count ?? 0);
      const dailyLimit = REMOTE_IMPORT_DAILY_LIMIT.value();
      if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1) {
        throw new HttpsError("failed-precondition", "Remote import limits are misconfigured.");
      }
      if (!Number.isSafeInteger(usageCount) || usageCount >= dailyLimit) {
        throw new HttpsError(
          "resource-exhausted",
          `The ${dailyLimit}-track remote import limit for today has been reached.`,
        );
      }

      transaction.create(publicRef, {
        id: jobId,
        ownerUid,
        displayName: source.provider === "spotify" ? "Spotify import" : "YouTube import",
        sourceFileName: "remote-source.m4a",
        contentType: "audio/mp4",
        inputPath,
        sourceType: "remote",
        sourceProvider: source.provider,
        status: "awaiting_upload",
        stage: "queued_for_download",
        outputs: [],
        error: null,
        createdAt: now,
        updatedAt: now,
      });
      transaction.create(internalRef, {
        ownerUid,
        inputPath,
        expectedContentType: "audio/mp4",
        sourceKind: "remote",
        sourceProvider: source.provider,
        sourceUrl: source.url,
        clientRequestId,
        rightsConfirmedAt: now,
        downloadStatus: "queued",
        status: "awaiting_upload",
        createdAt: now,
        updatedAt: now,
      });
      transaction.set(
        usageRef,
        {
          ownerUid,
          date: usageDate,
          count: usageCount + 1,
          updatedAt: now,
        },
        { merge: true },
      );
    });

    return {
      jobId,
      provider: source.provider,
      status: "queued_for_download",
    };
  },
);

export const enqueueRemoteDownload = onDocumentCreated(
  {
    document: "internalJobs/{jobId}",
    retry: true,
    timeoutSeconds: 120,
    memory: "256MiB",
    maxInstances: 5,
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    const jobId = event.params.jobId;
    const job = snapshot.data() as InternalJob;
    if (job.sourceKind !== "remote") return;
    if (
      !/^[a-f0-9]{32}$/.test(jobId)
      || !job.ownerUid
      || job.inputPath !== `users/${job.ownerUid}/jobs/${jobId}/input/source.m4a`
      || !job.sourceUrl
      || !job.sourceProvider
    ) {
      logger.error("Remote job failed its internal integrity check.", { jobId });
      return;
    }

    const bucket = getStorage().bucket();
    const [uploadUrl] = await bucket.file(job.inputPath).getSignedUrl({
      action: "write",
      version: "v4",
      // Exact-object + generation-zero preconditions make this safe to keep
      // valid through a concurrency-one queue's bounded retry window.
      expires: Date.now() + 24 * 60 * 60 * 1000,
      contentType: "audio/mp4",
      extensionHeaders: {
        "x-goog-meta-stemulate-source": "remote-import",
        "x-goog-meta-stemulate-job-id": jobId,
      },
      queryParams: { ifGenerationMatch: "0" },
    });
    await enqueueDownloadTask({
      jobId,
      ownerUid: job.ownerUid,
      storageBucket: bucket.name,
      inputPath: job.inputPath,
      uploadUrl,
    });

    await internalJobRef(jobId).set(
      {
        downloadTaskQueuedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  },
);

export const expireStaleRemoteImports = onSchedule(
  {
    schedule: "every 15 minutes",
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    // This is deliberately beyond the 24-hour exact-object signed PUT window,
    // so a concurrency-one queue and its bounded retry cannot be expired while
    // still legitimately waiting or working.
    const cutoff = Timestamp.fromMillis(Date.now() - 25 * 60 * 60 * 1000);
    const snapshots = await db.collection("internalJobs")
      .where("sourceKind", "==", "remote")
      .where("status", "==", "awaiting_upload")
      .where("createdAt", "<", cutoff)
      .orderBy("createdAt", "asc")
      .limit(100)
      .get();
    const stale = snapshots.docs;
    await Promise.all(stale.map(async (snapshot) => {
      const internalRef = internalJobRef(snapshot.id);
      await db.runTransaction(async (transaction) => {
        const freshSnapshot = await transaction.get(internalRef);
        if (!freshSnapshot.exists) return;
        const job = freshSnapshot.data() as InternalJob;
        if (
          job.sourceKind !== "remote"
          || job.status !== "awaiting_upload"
          || !(job.createdAt instanceof Timestamp)
          || job.createdAt.toMillis() >= cutoff.toMillis()
          || (
            job.downloadLeaseUntil instanceof Timestamp
            && job.downloadLeaseUntil.toMillis() > Date.now()
          )
        ) return;
        const error = {
          code: "DOWNLOAD_TIMEOUT",
          message: "The remote import did not produce a valid audio file in time.",
        };
        transaction.set(
          internalRef,
          { status: "failed", error, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        transaction.set(
          publicJobRef(job.ownerUid, snapshot.id),
          {
            status: "failed",
            stage: "failed",
            error,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      });
    }));
  },
);

export const getProcessingOutputs = onCall<GetOutputsInput>(
  {
    cors: CALLABLE_CORS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (request) => {
    const ownerUid = requireOwner(request);
    const jobId = requiredString(request.data.jobId, "jobId", 128);
    const snapshot = await publicJobRef(ownerUid, jobId).get();
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "The processing job does not exist.");
    }
    const record = snapshot.data() as {
      status?: PublicStatus;
      outputs?: StoredOutput[];
    };
    if (record.status !== "completed") {
      throw new HttpsError("failed-precondition", "The processing outputs are not ready.");
    }

    const expectedPrefix = `users/${ownerUid}/jobs/${jobId}/outputs/`;
    const outputs = record.outputs ?? [];
    if (outputs.some((output) => !output.storagePath.startsWith(expectedPrefix))) {
      logger.error("A public output path escaped its job prefix.", { jobId, ownerUid });
      throw new HttpsError("internal", "The processing output record is invalid.");
    }

    const expiresAt = Date.now() + 6 * 60 * 60 * 1000;
    const bucket = getStorage().bucket();
    return {
      expiresAt,
      outputs: await Promise.all(outputs.map(async (output) => {
        const [url] = await bucket.file(output.storagePath).getSignedUrl({
          action: "read",
          version: "v4",
          expires: expiresAt,
        });
        return {
          key: output.key,
          url,
          contentType: output.contentType,
          sizeBytes: output.sizeBytes,
        };
      })),
    };
  },
);

export const queueUploadedSource = onObjectFinalized(
  {
    retry: true,
    timeoutSeconds: 120,
    memory: "256MiB",
    maxInstances: 5,
  },
  async (event) => {
    const object = event.data;
    const objectPath = object.name;
    if (!objectPath) return;

    const match = objectPath.match(
      /^users\/([^/]+)\/jobs\/([^/]+)\/input\/(source\.[A-Za-z0-9]{1,8})$/,
    );
    if (!match) return;

    const [, ownerUid, jobId] = match;
    const internalRef = internalJobRef(jobId);
    const snapshot = await internalRef.get();
    if (!snapshot.exists) {
      logger.warn("Ignoring an upload without a matching internal job.", {
        objectPath,
      });
      return;
    }

    const job = snapshot.data() as InternalJob;
    const actualSize = Number(object.size ?? 0);
    if (job.ownerUid !== ownerUid || job.inputPath !== objectPath) {
      logger.error("Uploaded object does not match its internal job.", { jobId });
      return;
    }
    const remoteObjectIsValid = job.sourceKind !== "remote" || (
      objectPath.endsWith("/input/source.m4a")
      && object.contentType === "audio/mp4"
      && object.metadata?.["stemulate-source"] === "remote-import"
      && object.metadata?.["stemulate-job-id"] === jobId
      && actualSize <= REMOTE_IMPORT_MAX_BYTES.value()
    );
    const uploadedObjectIsValid = job.sourceKind === "remote"
      ? remoteObjectIsValid
      : /^(audio|video)\//.test(object.contentType ?? "")
        && actualSize <= MAX_INPUT_BYTES.value()
        && actualSize === job.expectedSizeBytes
        && object.contentType === job.expectedContentType;
    if (
      !Number.isSafeInteger(actualSize)
      || actualSize <= 0
      || !uploadedObjectIsValid
    ) {
      await markFailed(
        jobId,
        ownerUid,
        "INVALID_UPLOAD",
        "The uploaded source failed server-side size or media validation.",
      );
      return;
    }

    // Prefer a stored plan without consulting mutable deployment parameters.
    // The fallback is used only when accepting a new source or migrating an
    // older queued single-workflow record.
    const configuredWorkflows = job.musicAiWorkflowOrder?.length
      ? workflowPlanForJob(job)
      : configuredMusicAiWorkflows();
    let workflowsToEnqueue: MusicAiWorkflow[] = [];
    await db.runTransaction(async (transaction) => {
      const freshSnapshot = await transaction.get(internalRef);
      if (!freshSnapshot.exists) return;
      const freshJob = freshSnapshot.data() as InternalJob;
      if (freshJob.ownerUid !== ownerUid || freshJob.inputPath !== objectPath) {
        throw new Error("Uploaded object no longer matches its internal job.");
      }
      if (freshJob.status === "queued") {
        // A prior trigger attempt may have committed state but failed to enqueue.
        workflowsToEnqueue = workflowPlanForJob(freshJob);
        return;
      }
      if (freshJob.status !== "awaiting_upload") return;

      workflowsToEnqueue = configuredWorkflows;
      const musicAiWorkflows = Object.fromEntries(
        configuredWorkflows.map((workflow) => [
          workflow.key,
          {
            ...(freshJob.musicAiWorkflows?.[workflow.key] ?? {}),
            slug: workflow.slug,
          },
        ]),
      );
      transaction.set(
        internalRef,
        {
          status: "queued",
          musicAiWorkflowOrder: configuredWorkflows.map(({ key }) => key),
          musicAiWorkflows,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      transaction.set(
        publicJobRef(ownerUid, jobId),
        {
          status: "queued",
          stage: "queued_for_analysis",
          uploadedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    if (workflowsToEnqueue.length === 0) return;
    const [inputUrl] = await getStorage()
      .bucket(object.bucket)
      .file(objectPath)
      .getSignedUrl({
        action: "read",
        version: "v4",
        expires: Date.now() + 24 * 60 * 60 * 1000,
      });
    await Promise.all(workflowsToEnqueue.map(({ key }) =>
      enqueueOnce(
        "submitMusicAiJob",
        { jobId, ownerUid, inputUrl, workflowKey: key } satisfies SubmitTaskData,
        `submit-${jobId}-${key}`,
      ),
    ));
  },
);

export const submitMusicAiJob = onTaskDispatched<SubmitTaskData>(
  {
    secrets: [MUSIC_AI_API_KEY],
    retryConfig: {
      maxAttempts: 5,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxDoublings: 3,
    },
    rateLimits: { maxConcurrentDispatches: 2 },
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async (request) => {
    const {
      jobId,
      ownerUid,
      inputUrl,
      workflowKey: requestedWorkflowKey,
    } = request.data;
    if (!jobId || !ownerUid || !inputUrl) {
      throw new Error("Malformed submit task.");
    }

    const internalRef = internalJobRef(jobId);
    let existingMusicAiJobId: string | undefined;
    let selectedWorkflow: MusicAiWorkflow | undefined;
    let shouldExit = false;
    let submissionIsInFlight = false;
    let priorSubmissionIsUncertain = false;
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(internalRef);
      if (!snapshot.exists) throw new Error("Internal job does not exist.");
      const job = snapshot.data() as InternalJob;
      if (job.ownerUid !== ownerUid) throw new Error("Task owner does not match job owner.");
      if (job.status === "failed" || job.status === "completed") {
        shouldExit = true;
        return;
      }
      const workflow = workflowForTask(job, requestedWorkflowKey);
      selectedWorkflow = workflow;
      const execution = workflowStateForJob(job, workflow);
      const disposition = musicAiSubmissionDisposition(
        {
          musicAiJobId: execution.musicAiJobId,
          submissionAttempted: Boolean(execution.submissionAttemptedAt),
          submissionLeaseUntilMs:
            execution.submissionLeaseUntil instanceof Timestamp
              ? execution.submissionLeaseUntil.toMillis()
              : undefined,
        },
        Date.now(),
      );
      if (disposition === "resume_polling") {
        existingMusicAiJobId = execution.musicAiJobId;
        return;
      }
      if (disposition === "in_flight") {
        submissionIsInFlight = true;
        return;
      }
      if (disposition === "uncertain") {
        priorSubmissionIsUncertain = true;
        return;
      }
      const plan = workflowPlanForJob(job);
      const musicAiWorkflows = {
        ...(job.musicAiWorkflows ?? {}),
        [workflow.key]: {
          ...execution,
          slug: workflow.slug,
          submissionAttemptedAt: Timestamp.fromMillis(Date.now()),
          submissionLeaseUntil: Timestamp.fromMillis(Date.now() + 150 * 1000),
        },
      };
      transaction.set(
        internalRef,
        {
          status: "processing",
          musicAiWorkflowOrder: plan.map(({ key }) => key),
          musicAiWorkflows,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      transaction.set(
        publicJobRef(ownerUid, jobId),
        {
          status: "processing",
          stage: "submitting",
          error: null,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    if (shouldExit) return;
    if (!selectedWorkflow) {
      // A transaction retry can only reach this branch for an invalid record.
      throw new Error("Music.ai workflow could not be resolved.");
    }
    const workflowKey = selectedWorkflow.key;
    if (submissionIsInFlight) {
      // Do not acknowledge a duplicate delivery while the first task still
      // owns the lease. A retry after that task finishes can safely resume from
      // the persisted Music.ai ID, or surface an expired ambiguous submission.
      throw new Error("A Music.ai submission lease is already active.");
    }
    if (existingMusicAiJobId) {
      await enqueueOnce(
        "pollMusicAiJob",
        { jobId, ownerUid, workflowKey, attempt: 0 } satisfies PollTaskData,
        `poll-${jobId}-${workflowKey}-0`,
        POLL_INITIAL_DELAY_SECONDS.value(),
      );
      return;
    }

    if (priorSubmissionIsUncertain) {
      await markFailed(
        jobId,
        ownerUid,
        "MUSIC_AI_SUBMISSION_UNCERTAIN",
        `The ${workflowKey} workflow may have reached Music.ai, so STEMulate refused to submit a duplicate paid job. Review Music.ai before retrying.`,
      );
      return;
    }

    let musicAiJob: MusicAiCreateResponse;
    try {
      musicAiJob = await createMusicAiJob(jobId, inputUrl, selectedWorkflow);
    } catch (error) {
      // A network failure after POST can be ambiguous. Do not blindly resubmit
      // and incur a duplicate Music.ai job; surface it for an intentional retry.
      const code = error instanceof MusicAiHttpError && !error.retryable
        ? "MUSIC_AI_REJECTED"
        : "MUSIC_AI_SUBMISSION_UNCERTAIN";
      // Music.ai may echo request parameters in an error body. Never log the
      // error message because the request includes a live signed input URL.
      logger.error("Music.ai submission failed.", {
        jobId,
        workflowKey,
        code,
        ...safeErrorFields(error),
      });
      await markFailed(
        jobId,
        ownerUid,
        code,
        code === "MUSIC_AI_SUBMISSION_UNCERTAIN"
          ? `The ${workflowKey} submission outcome is uncertain. Review Music.ai before retrying.`
          : `Music.ai rejected the configured ${workflowKey} workflow request.`,
      );
      return;
    }

    // Persist the paid remote job ID before any public/status write. If later
    // work fails, the task retry finds this ID and resumes polling instead of
    // submitting a second Music.ai job.
    let shouldPoll = false;
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(internalRef);
      if (!snapshot.exists) return;
      const job = snapshot.data() as InternalJob;
      if (job.ownerUid !== ownerUid) throw new Error("Task owner does not match job owner.");
      const workflow = workflowForTask(job, workflowKey);
      const nextExecution: InternalMusicAiWorkflow = {
        ...workflowStateForJob(job, workflow),
        slug: workflow.slug,
        musicAiJobId: musicAiJob.id,
      };
      delete nextExecution.submissionLeaseUntil;
      transaction.set(
        internalRef,
        {
          musicAiWorkflows: {
            ...(job.musicAiWorkflows ?? {}),
            [workflowKey]: nextExecution,
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      if (job.status === "failed" || job.status === "completed") return;
      shouldPoll = true;
      transaction.set(
        publicJobRef(ownerUid, jobId),
        {
          status: "processing",
          stage: "analyzing",
          submittedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    if (shouldPoll) {
      await enqueueOnce(
        "pollMusicAiJob",
        { jobId, ownerUid, workflowKey, attempt: 0 } satisfies PollTaskData,
        `poll-${jobId}-${workflowKey}-0`,
        POLL_INITIAL_DELAY_SECONDS.value(),
      );
    }
  },
);

function nextPollDelay(attempt: number): number {
  const growthSteps = Math.floor(attempt / 5);
  return Math.min(
    POLL_MAX_DELAY_SECONDS.value(),
    POLL_INITIAL_DELAY_SECONDS.value() * 2 ** growthSteps,
  );
}

async function queueOutputCopies(
  jobId: string,
  ownerUid: string,
  sources: ResultSource[],
  analysis: Record<string, string | number | boolean> = {},
): Promise<void> {
  const sourceMap = Object.fromEntries(sources.map((source) => [source.key, source]));
  const keys = sources.map((source) => source.key);
  const internalRef = internalJobRef(jobId);
  let shouldEnqueue = false;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(internalRef);
    if (!snapshot.exists) return;
    const job = snapshot.data() as InternalJob;
    if (job.ownerUid !== ownerUid) throw new Error("Output owner does not match job owner.");
    if (job.status === "failed" || job.status === "completed") return;
    shouldEnqueue = true;
    transaction.set(
      internalRef,
      {
        status: "processing",
        resultSources: sourceMap,
        expectedOutputKeys: keys,
        analysis,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.set(
      publicJobRef(ownerUid, jobId),
      {
        status: "processing",
        stage: "materializing_outputs",
        analysis,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  if (!shouldEnqueue) return;

  await Promise.all(
    keys.map((outputKey) => enqueueOnce(
      "copyMusicAiOutput",
      { jobId, ownerUid, outputKey, attempt: 0 } satisfies CopyTaskData,
      `copy-${jobId}-${outputKey}-0`,
    )),
  );
}

async function recordWorkflowSuccess(
  jobId: string,
  ownerUid: string,
  workflowKey: string,
  sources: ResultSource[],
  analysis: Record<string, string | number | boolean>,
): Promise<void> {
  const internalRef = internalJobRef(jobId);
  let mergedSources: ResultSource[] | undefined;
  let mergedAnalysis: Record<string, string | number | boolean> | undefined;
  let tooManyOutputs = false;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(internalRef);
    if (!snapshot.exists) return;
    const job = snapshot.data() as InternalJob;
    if (job.ownerUid !== ownerUid) throw new Error("Task owner does not match job owner.");
    if (job.status === "completed" || job.status === "failed") return;
    const workflow = workflowForTask(job, workflowKey);
    const nextWorkflows = {
      ...(job.musicAiWorkflows ?? {}),
      [workflowKey]: {
        ...workflowStateForJob(job, workflow),
        slug: workflow.slug,
        musicAiStatus: "SUCCEEDED" as const,
        resultSources: Object.fromEntries(
          sources.map((source) => [source.key, source]),
        ),
        analysis,
      },
    };
    transaction.set(
      internalRef,
      {
        musicAiWorkflows: nextWorkflows,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const plan = workflowPlanForJob({
      ...job,
      musicAiWorkflows: nextWorkflows,
    });
    if (!plan.every(({ key }) =>
      nextWorkflows[key]?.musicAiStatus === "SUCCEEDED",
    )) {
      return;
    }

    try {
      const merged = mergeMusicAiWorkflowResults(plan.map((plannedWorkflow) => {
        const result = nextWorkflows[plannedWorkflow.key];
        return {
          workflow: plannedWorkflow,
          sources: Object.values(result?.resultSources ?? {}),
          analysis: result?.analysis ?? {},
        };
      }));
      mergedSources = merged.sources;
      mergedAnalysis = merged.analysis;
    } catch {
      tooManyOutputs = true;
    }
  });

  if (tooManyOutputs) {
    await markFailed(
      jobId,
      ownerUid,
      "MUSIC_AI_TOO_MANY_OUTPUTS",
      "The configured Music.ai workflows returned too many output artifacts.",
    );
    return;
  }
  if (!mergedSources || !mergedAnalysis) return;
  if (mergedSources.length === 0) {
    await markFailed(
      jobId,
      ownerUid,
      "MUSIC_AI_NO_OUTPUTS",
      "The Music.ai workflows completed without downloadable output artifacts.",
    );
    return;
  }
  await queueOutputCopies(jobId, ownerUid, mergedSources, mergedAnalysis);
}

async function recordWorkflowPollState(
  jobId: string,
  ownerUid: string,
  workflowKey: string,
  attempt: number,
  stage: string,
  status?: MusicAiStatus,
): Promise<boolean> {
  const internalRef = internalJobRef(jobId);
  let active = false;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(internalRef);
    if (!snapshot.exists) return;
    const job = snapshot.data() as InternalJob;
    if (job.ownerUid !== ownerUid) throw new Error("Task owner does not match job owner.");
    if (job.status === "completed" || job.status === "failed") return;
    const workflow = workflowForTask(job, workflowKey);
    active = true;
    transaction.set(
      internalRef,
      {
        musicAiWorkflows: {
          ...(job.musicAiWorkflows ?? {}),
          [workflowKey]: {
            ...workflowStateForJob(job, workflow),
            slug: workflow.slug,
            pollAttempt: attempt,
            ...(status ? { musicAiStatus: status } : {}),
          },
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.set(
      publicJobRef(ownerUid, jobId),
      {
        status: "processing",
        stage,
        ...(status ? { musicAiStatus: status } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
  return active;
}

export const pollMusicAiJob = onTaskDispatched<PollTaskData>(
  {
    secrets: [MUSIC_AI_API_KEY],
    retryConfig: {
      maxAttempts: 8,
      minBackoffSeconds: 15,
      maxBackoffSeconds: 300,
      maxDoublings: 4,
    },
    rateLimits: { maxConcurrentDispatches: 5 },
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async (request) => {
    const {
      jobId,
      ownerUid,
      workflowKey: requestedWorkflowKey,
      attempt,
    } = request.data;
    if (
      !jobId
      || !ownerUid
      || !Number.isSafeInteger(attempt)
      || attempt < 0
    ) {
      throw new Error("Malformed poll task.");
    }

    const internalRef = internalJobRef(jobId);
    const snapshot = await internalRef.get();
    if (!snapshot.exists) return;
    const job = snapshot.data() as InternalJob;
    if (job.ownerUid !== ownerUid) throw new Error("Task owner does not match job owner.");
    if (job.status === "completed" || job.status === "failed") return;
    if (job.expectedOutputKeys?.length) {
      const sources = Object.values(job.resultSources ?? {});
      await queueOutputCopies(jobId, ownerUid, sources, job.analysis ?? {});
      return;
    }
    const workflow = workflowForTask(job, requestedWorkflowKey);
    const workflowKey = workflow.key;
    const execution = workflowStateForJob(job, workflow);
    if (execution.musicAiStatus === "SUCCEEDED") {
      await recordWorkflowSuccess(
        jobId,
        ownerUid,
        workflowKey,
        Object.values(execution.resultSources ?? {}),
        execution.analysis ?? {},
      );
      return;
    }
    if (!execution.musicAiJobId) throw new Error("Music.ai job ID is missing.");

    let remote: MusicAiJobResponse;
    try {
      remote = await getMusicAiJob(execution.musicAiJobId);
    } catch (error) {
      if (error instanceof MusicAiHttpError && !error.retryable) {
        await markFailed(
          jobId,
          ownerUid,
          "MUSIC_AI_POLL_REJECTED",
          `Music.ai rejected the ${workflowKey} status request (HTTP ${error.status}).`,
        );
        return;
      }
      logger.warn("Music.ai status poll failed; scheduling another poll.", {
        jobId,
        workflowKey,
        ...safeErrorFields(error),
      });
      const nextAttempt = attempt + 1;
      if (nextAttempt > MUSIC_AI_MAX_POLLS.value()) {
        await markFailed(
          jobId,
          ownerUid,
          "MUSIC_AI_POLL_UNAVAILABLE",
          `The ${workflowKey} workflow status remained unavailable for the configured polling window.`,
        );
        return;
      }
      const active = await recordWorkflowPollState(
        jobId,
        ownerUid,
        workflowKey,
        nextAttempt,
        "poll_retry",
      );
      if (!active) return;
      await enqueueOnce(
        "pollMusicAiJob",
        { jobId, ownerUid, workflowKey, attempt: nextAttempt } satisfies PollTaskData,
        `poll-${jobId}-${workflowKey}-${nextAttempt}`,
        nextPollDelay(nextAttempt),
      );
      return;
    }

    const active = await recordWorkflowPollState(
      jobId,
      ownerUid,
      workflowKey,
      attempt,
      "analyzing",
      // A SUCCEEDED marker is persisted only together with its extracted
      // result below. This prevents an at-least-once duplicate from observing
      // success before the output URLs are available and finalizing a partial
      // aggregate.
      remote.status === "SUCCEEDED" ? undefined : remote.status,
    );
    if (!active) return;

    if (remote.status === "FAILED") {
      await markFailed(
        jobId,
        ownerUid,
        "MUSIC_AI_JOB_FAILED",
        // Remote error text can echo workflow parameters, including the signed
        // source URL. Keep it out of both logs and the client-readable record.
        `Music.ai could not complete the ${workflowKey} workflow. Review the job in Music.ai for details.`,
      );
      return;
    }

    if (remote.status === "SUCCEEDED") {
      const sources = extractResultSources(remote.result);
      const analysis = extractScalarAnalysis(remote.result);
      await recordWorkflowSuccess(jobId, ownerUid, workflowKey, sources, analysis);
      return;
    }

    const nextAttempt = attempt + 1;
    if (nextAttempt > MUSIC_AI_MAX_POLLS.value()) {
      await markFailed(
        jobId,
        ownerUid,
        "MUSIC_AI_TIMEOUT",
        `The ${workflowKey} workflow did not finish within the configured poll window.`,
      );
      return;
    }

    await enqueueOnce(
      "pollMusicAiJob",
      { jobId, ownerUid, workflowKey, attempt: nextAttempt } satisfies PollTaskData,
      `poll-${jobId}-${workflowKey}-${nextAttempt}`,
      nextPollDelay(nextAttempt),
    );
  },
);

function extensionFor(url: string, contentType: string): string {
  const pathnameMatch = new URL(url).pathname.toLowerCase().match(
    /\.(wav|mp3|m4a|aac|flac|ogg|opus|aif|aiff|json|mid|midi|txt)$/,
  );
  if (pathnameMatch) return pathnameMatch[1];
  const byType: Record<string, string> = {
    "audio/aac": "aac",
    "audio/flac": "flac",
    "audio/m4a": "m4a",
    "audio/midi": "mid",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "application/json": "json",
    "text/plain": "txt",
  };
  return byType[contentType.split(";", 1)[0].trim().toLowerCase()] ?? "bin";
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateAddress(normalized.slice("::ffff:".length));
  }
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }
  if (isIP(normalized) === 6) {
    return normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized);
  }
  return true;
}

async function assertPublicOutputUrl(url: URL): Promise<void> {
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || !musicAiOutputHosts().has(hostname)
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname === "metadata.google.internal"
  ) {
    throw new Error("Music.ai output URL is not a public HTTPS resource.");
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Music.ai output URL resolved to a private network address.");
  }
}

async function fetchPublicOutput(initialUrl: string): Promise<Response> {
  let current = new URL(initialUrl);
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    await assertPublicOutputUrl(current);
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Music.ai output redirect omitted its destination.");
    current = new URL(location, current);
  }
  throw new Error("Music.ai output followed too many redirects.");
}

async function downloadOutput(
  source: ResultSource,
  destinationPath: string,
): Promise<StoredOutput> {
  const sourceUrl = new URL(source.url);
  if (sourceUrl.protocol !== "https:") throw new Error("Output URL must use HTTPS.");

  const response = await fetchPublicOutput(sourceUrl.toString());
  if (!response.ok || !response.body) {
    throw new Error(`Output download failed with HTTP ${response.status}.`);
  }

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const extension = extensionFor(source.url, contentType);
  const isAnalysisData = extension === "json"
    || extension === "txt"
    || /^(?:application\/json|text\/)/i.test(contentType);
  const maximumBytes = isAnalysisData
    ? Math.min(MAX_OUTPUT_BYTES.value(), MAX_ANALYSIS_OUTPUT_BYTES.value())
    : MAX_OUTPUT_BYTES.value();
  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength === null ? 0 : Number(contentLength);
  if (
    (contentLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 0))
    || declaredLength > maximumBytes
  ) {
    throw new Error("Music.ai output exceeds the configured size limit.");
  }

  const storagePath = `${destinationPath}/${source.key}.${extension}`;
  const destination = getStorage().bucket().file(storagePath);
  let sizeBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > maximumBytes) {
        callback(new Error("Music.ai output exceeded the configured size limit."));
      } else {
        callback(null, chunk);
      }
    },
  });

  await pipeline(
    Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
    limiter,
    destination.createWriteStream({
      metadata: {
        contentType,
        metadata: { source: "music.ai" },
      },
    }),
  );

  return { key: source.key, storagePath, contentType, sizeBytes };
}

export const copyMusicAiOutput = onTaskDispatched<CopyTaskData>(
  {
    retryConfig: {
      maxAttempts: 5,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxDoublings: 3,
    },
    rateLimits: { maxConcurrentDispatches: 3 },
    timeoutSeconds: 900,
    memory: "512MiB",
  },
  async (request) => {
    const { jobId, ownerUid, outputKey, attempt } = request.data;
    if (
      !jobId
      || !ownerUid
      || !outputKey
      || !Number.isSafeInteger(attempt)
      || attempt < 0
    ) {
      throw new Error("Malformed copy task.");
    }

    const internalRef = internalJobRef(jobId);
    const snapshot = await internalRef.get();
    if (!snapshot.exists) return;
    const job = snapshot.data() as InternalJob;
    if (job.ownerUid !== ownerUid) throw new Error("Task owner does not match job owner.");
    if (job.status === "failed") return;
    if (job.outputs?.[outputKey]) return;

    const source = job.resultSources?.[outputKey];
    if (!source) throw new Error("Music.ai output source is missing.");
    let output: StoredOutput;
    try {
      output = await downloadOutput(
        source,
        `users/${ownerUid}/jobs/${jobId}/outputs`,
      );
    } catch (error) {
      logger.warn("Music.ai output copy failed.", {
        jobId,
        outputKey,
        attempt,
        ...safeErrorFields(error),
      });
      const nextAttempt = attempt + 1;
      if (nextAttempt >= 5) {
        await markFailed(
          jobId,
          ownerUid,
          "MUSIC_AI_OUTPUT_UNAVAILABLE",
          `The ${outputKey} output could not be copied into private storage.`,
        );
        return;
      }
      await publicJobRef(ownerUid, jobId).set(
        {
          stage: "output_retry",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      await enqueueOnce(
        "copyMusicAiOutput",
        { jobId, ownerUid, outputKey, attempt: nextAttempt } satisfies CopyTaskData,
        `copy-${jobId}-${outputKey}-${nextAttempt}`,
        Math.min(300, 30 * 2 ** attempt),
      );
      return;
    }

    await db.runTransaction(async (transaction) => {
      const freshSnapshot = await transaction.get(internalRef);
      if (!freshSnapshot.exists) return;
      const freshJob = freshSnapshot.data() as InternalJob;
      if (freshJob.status === "failed") return;
      const outputs = { ...(freshJob.outputs ?? {}), [outputKey]: output };
      const expected = freshJob.expectedOutputKeys ?? [];
      const complete = expected.length > 0
        && expected.every((key) => Boolean(outputs[key]));
      const publicOutputs = Object.values(outputs).sort((a, b) =>
        a.key.localeCompare(b.key),
      );

      transaction.set(
        internalRef,
        {
          outputs,
          status: complete ? "completed" : "processing",
          ...(complete ? { completedAt: FieldValue.serverTimestamp() } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      transaction.set(
        publicJobRef(ownerUid, jobId),
        {
          outputs: publicOutputs,
          status: complete ? "completed" : "processing",
          stage: complete ? "completed" : "materializing_outputs",
          error: null,
          ...(complete ? { completedAt: FieldValue.serverTimestamp() } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
  },
);
