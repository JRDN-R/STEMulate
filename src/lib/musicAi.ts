import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { ref, uploadBytesResumable } from "firebase/storage";

import type {
  AnalysisData,
  ProcessingStage,
  RemoteSourceProvider,
  RemoteTrackResult,
} from "../types";
import { spotifyImportEnabled } from "./backendConfig";
import {
  firebaseBackendConfigured,
  getOwnerUser,
  getStemulateFirestore,
  getStemulateFunctions,
  getStemulateStorage,
} from "./firebase";
import {
  normalizeBeats,
  normalizeChords,
  normalizeSections,
} from "./musicAnalysis";
import { validateRemoteImportUrl } from "./remoteSources";
import { normalizeStemOutputs } from "./stems";

export const backendConfigured = firebaseBackendConfigured;

type StageCallback = (stage: ProcessingStage, detail: string) => void;

type PublicOutput = {
  key: string;
  storagePath: string;
  contentType?: string;
  sizeBytes?: number;
};

type PublicJob = {
  status?: "awaiting_upload" | "queued" | "processing" | "completed" | "failed";
  stage?: string;
  displayName?: string;
  sourceType?: "upload" | "remote";
  sourceProvider?: RemoteSourceProvider;
  analysis?: Record<string, unknown>;
  outputs?: PublicOutput[];
  error?: { message?: string; code?: string } | null;
};

type CreateJobResult = {
  jobId: string;
  inputPath: string;
  status: "awaiting_upload";
  maxInputBytes: number;
};

type CreateRemoteJobResult = {
  jobId: string;
  provider: RemoteSourceProvider;
  status: "queued_for_download";
};

export type CompletedJobResult = {
  analysis: AnalysisData;
  jobId: string;
  outputsExpireAt: number;
  displayName?: string;
  sourceProvider?: RemoteSourceProvider;
};

type PlaybackOutput = {
  key: string;
  url: string;
  contentType?: string;
  sizeBytes?: number;
};

type ActiveRemoteJob = {
  jobId?: string;
  ownerUid: string;
  provider: RemoteSourceProvider;
  clientRequestId: string;
  url: string;
  createdAt: number;
};

type CreatedRemoteJob = ActiveRemoteJob & { jobId: string };

type LatestCompletedJob = {
  jobId: string;
  ownerUid: string;
  expiresAt: number;
  updatedAt: number;
};

const ACTIVE_REMOTE_JOB_KEY = "stemulate.active-remote-job.v1";
const LATEST_COMPLETED_JOB_KEY = "stemulate.latest-completed-job.v1";
const MAX_REMOTE_ARTIFACT_BYTES = 16 * 1024 * 1024;

class TerminalJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalJobError";
  }
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

function artifactLimitError() {
  return new TerminalJobError("A Music.ai text artifact exceeded the 16 MiB safety limit.");
}

async function readBoundedText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      await response.body?.cancel().catch(() => undefined);
      throw new TerminalJobError("A Music.ai text artifact reported an invalid size.");
    }
    if (declaredBytes > MAX_REMOTE_ARTIFACT_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw artifactLimitError();
    }
  }

  if (!response.body) {
    throw new TerminalJobError("This browser cannot safely stream Music.ai text artifacts.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_REMOTE_ARTIFACT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw artifactLimitError();
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
}

function rememberRemoteJob(job: ActiveRemoteJob) {
  try {
    localStorage.setItem(ACTIVE_REMOTE_JOB_KEY, JSON.stringify(job));
  } catch {
    // Private browsing or storage policy may disable persistence; the live
    // Firestore listener still works for the current page session.
  }
}

function forgetRemoteJob() {
  try {
    localStorage.removeItem(ACTIVE_REMOTE_JOB_KEY);
  } catch {
    // Nothing else is required when persistence is unavailable.
  }
}

function recalledRemoteJob(): ActiveRemoteJob | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(ACTIVE_REMOTE_JOB_KEY) || "null") as Partial<ActiveRemoteJob> | null;
    if (
      !parsed
      || (parsed.jobId !== undefined && !/^[a-f0-9]{32}$/.test(parsed.jobId))
      || !parsed.ownerUid
      || (parsed.provider !== "youtube" && parsed.provider !== "spotify")
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.clientRequestId || "")
      || typeof parsed.url !== "string"
      || parsed.url.length > 2_048
      || !Number.isFinite(parsed.createdAt)
      || Date.now() - Number(parsed.createdAt) > 7 * 24 * 60 * 60 * 1000
    ) {
      forgetRemoteJob();
      return null;
    }
    return parsed as ActiveRemoteJob;
  } catch {
    forgetRemoteJob();
    return null;
  }
}

function rememberLatestCompletedJob(job: LatestCompletedJob) {
  try {
    localStorage.setItem(LATEST_COMPLETED_JOB_KEY, JSON.stringify(job));
  } catch {
    // Playback still works until the current signed URLs expire.
  }
}

function forgetLatestCompletedJob() {
  try {
    localStorage.removeItem(LATEST_COMPLETED_JOB_KEY);
  } catch {
    // Nothing else is required when persistence is unavailable.
  }
}

function recalledLatestCompletedJob(): LatestCompletedJob | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LATEST_COMPLETED_JOB_KEY) || "null") as Partial<LatestCompletedJob> | null;
    if (
      !parsed
      || !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.jobId || "")
      || !parsed.ownerUid
      || !Number.isFinite(parsed.expiresAt)
      || !Number.isFinite(parsed.updatedAt)
      || Date.now() - Number(parsed.updatedAt) > 30 * 24 * 60 * 60 * 1000
    ) {
      forgetLatestCompletedJob();
      return null;
    }
    return parsed as LatestCompletedJob;
  } catch {
    forgetLatestCompletedJob();
    return null;
  }
}

async function resolveJson(value: unknown): Promise<unknown> {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const response = await fetch(trimmed);
      if (!response.ok) return null;
      const text = await readBoundedText(response);
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof TerminalJobError) throw error;
      return null;
    }
  }
  return value;
}

function findValue(record: Record<string, unknown>, aliases: string[]): unknown {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  const exact = Object.entries(record).find(([key]) =>
    normalizedAliases.includes(key.toLowerCase()),
  );
  if (exact) return exact[1];
  return Object.entries(record).find(([key]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    return normalizedAliases.some((alias) =>
      normalized === alias || normalized.includes(`_${alias}`) || normalized.includes(`${alias}_`),
    );
  })?.[1];
}

async function hydrateResult(result: Record<string, unknown>): Promise<AnalysisData> {
  const [rawBeats, rawChords, rawSections] = await Promise.all([
    resolveJson(findValue(result, ["beatmap", "beats", "beat_map"])),
    resolveJson(findValue(result, ["chordmap", "chords", "chord_map"])),
    resolveJson(findValue(result, ["sectionsmap", "sections", "sections_map"])),
  ]);

  const bpmValue = findValue(result, ["bpm", "tempo"]);
  const keyValue = findValue(result, ["key", "rootkey", "root_key"]);
  return {
    bpm: Number(bpmValue) || 0,
    key: typeof keyValue === "string" && keyValue.trim() ? keyValue : "Unknown",
    beats: normalizeBeats(rawBeats),
    chords: normalizeChords(rawChords),
    sections: normalizeSections(rawSections),
    stems: normalizeStemOutputs(result),
  };
}

function inferredContentType(file: File): string {
  if (file.type && /^(audio|video)\//i.test(file.type)) return file.type;
  const extension = file.name.toLowerCase().split(".").pop();
  const byExtension: Record<string, string> = {
    aac: "audio/aac",
    aif: "audio/aiff",
    aiff: "audio/aiff",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    wav: "audio/wav",
    m4v: "video/x-m4v",
    mov: "video/quicktime",
    mp4: "video/mp4",
  };
  return extension ? byExtension[extension] || "application/octet-stream" : "application/octet-stream";
}

function uploadSource(
  inputPath: string,
  file: File,
  contentType: string,
  onStage: StageCallback,
  signal?: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const task = uploadBytesResumable(
      ref(getStemulateStorage(), inputPath),
      file,
      { contentType },
    );
    const abort = () => task.cancel();
    signal?.addEventListener("abort", abort, { once: true });
    task.on(
      "state_changed",
      (snapshot) => {
        const percent = snapshot.totalBytes
          ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)
          : 0;
        onStage("upload", `Uploading securely · ${percent}%`);
      },
      (error) => {
        signal?.removeEventListener("abort", abort);
        reject(signal?.aborted ? abortError() : error);
      },
      () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      },
    );
  });
}

function stageFor(job: PublicJob): [ProcessingStage, string] {
  switch (job.stage) {
    case "queued_for_download":
      return job.sourceProvider === "spotify"
        ? ["download", "Matching Spotify metadata to YouTube Music with spotDL"]
        : ["download", "Queued for an authorized yt-dlp download"];
    case "downloading":
      return job.sourceProvider === "spotify"
        ? ["download", "Downloading the spotDL match from YouTube Music"]
        : ["download", "Downloading the authorized YouTube track with yt-dlp"];
    case "download_retry":
      return ["download", "The source is taking longer than expected · trying again"];
    case "normalizing":
      return ["download", "Preparing the downloaded audio for Music.ai"];
    case "transcoding":
      return ["download", "Preparing the downloaded audio for Music.ai"];
    case "uploading_source":
      return ["download", "Securing the downloaded audio in private storage"];
    case "materializing_outputs":
      return ["split", "Securing the separated stems and analysis"];
    case "output_retry":
      return ["split", "The stems are still arriving · checking again"];
    case "completed":
      return ["split", "Loading the secured Music.ai outputs"];
    case "submitting":
      return ["analyze", "Starting the Music.ai workflow"];
    case "poll_retry":
      return ["analyze", "Music.ai is still working · checking again"];
    case "analyzing":
      return ["analyze", "Analyzing beats, chords, and sections"];
    case "queued_for_analysis":
      return ["analyze", "Queued for Music.ai"];
    default:
      if (job.sourceType === "remote" && job.status === "awaiting_upload") {
        return ["download", "Waiting for the private download worker"];
      }
      return job.status === "processing"
        ? ["split", "Separating the mix"]
        : ["analyze", "Waiting for Music.ai"];
  }
}

async function materializeResult(
  jobId: string,
  job: PublicJob,
): Promise<{ analysis: AnalysisData; expiresAt: number }> {
  const result: Record<string, unknown> = { ...(job.analysis || {}) };
  const getOutputs = httpsCallable<
    { jobId: string },
    { expiresAt: number; outputs: PlaybackOutput[] }
  >(getStemulateFunctions(), "getProcessingOutputs");
  const response = await getOutputs({ jobId });
  const expiresAt = Number(response.data.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("The backend returned invalid playback-link expiry data.");
  }
  await Promise.all((response.data.outputs || []).map(async (output) => {
    if (!output?.key || !output.url) return;
    const contentType = String(output.contentType || "").toLowerCase();
    if (Number(output.sizeBytes) > MAX_REMOTE_ARTIFACT_BYTES && (contentType.includes("json") || contentType.startsWith("text/"))) {
      throw artifactLimitError();
    }
    result[output.key] = contentType.includes("json") || contentType.startsWith("text/") || new URL(output.url).pathname.endsWith(".json")
      ? await resolveJson(output.url)
      : output.url;
  }));
  return {
    analysis: await hydrateResult(result),
    expiresAt,
  };
}

function waitForJob(
  ownerUid: string,
  jobId: string,
  onStage: StageCallback,
  signal?: AbortSignal,
): Promise<CompletedJobResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastStage = "";
    let unsubscribe: () => void = () => undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(abortError()));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });

    unsubscribe = onSnapshot(
      doc(getStemulateFirestore(), `users/${ownerUid}/jobs/${jobId}`),
      (snapshot) => {
        if (!snapshot.exists()) {
          if (!snapshot.metadata.fromCache) {
            finish(() => reject(new TerminalJobError("The saved processing job no longer exists.")));
          }
          return;
        }
        const job = snapshot.data() as PublicJob;
        const stageKey = `${job.status}:${job.stage}`;
        if (stageKey !== lastStage) {
          lastStage = stageKey;
          const [stage, detail] = stageFor(job);
          onStage(stage, detail);
        }
        if (job.status === "failed") {
          finish(() => reject(new TerminalJobError(
            job.error?.message || "Music.ai could not process this track.",
          )));
          return;
        }
        if (job.status === "completed") {
          void materializeResult(jobId, job).then(
            (materialized) => finish(() => {
              rememberLatestCompletedJob({
                jobId,
                ownerUid,
                expiresAt: materialized.expiresAt,
                updatedAt: Date.now(),
              });
              onStage("ready", "Your practice deck is ready");
              resolve({
                analysis: materialized.analysis,
                jobId,
                outputsExpireAt: materialized.expiresAt,
                displayName: job.displayName,
                sourceProvider: job.sourceProvider,
              });
            }),
            (error) => finish(() => reject(error)),
          );
        }
      },
      (error) => finish(() => reject(error)),
    );
  });
}

export async function analyzeFile(
  file: File,
  onStage: StageCallback,
  signal?: AbortSignal,
): Promise<AnalysisData> {
  if (!backendConfigured) {
    throw new Error("The secure Firebase backend is not configured yet.");
  }
  const owner = getOwnerUser();
  if (!owner) {
    throw new Error("Sign in as the owner from Settings before starting Music.ai processing.");
  }
  const contentType = inferredContentType(file);
  if (!/^(audio|video)\//i.test(contentType)) {
    throw new Error("Choose a supported audio or video file.");
  }

  onStage("upload", "Creating a private upload slot");
  const createJob = httpsCallable<
    { displayName: string; fileName: string; contentType: string; sizeBytes: number },
    CreateJobResult
  >(getStemulateFunctions(), "createProcessingJob");
  const response = await createJob({
    displayName: file.name.replace(/\.[^.]+$/, ""),
    fileName: file.name,
    contentType,
    sizeBytes: file.size,
  });
  const job = response.data;
  if (!job?.jobId || !job.inputPath) {
    throw new Error("The backend did not return a valid upload job.");
  }

  await uploadSource(job.inputPath, file, contentType, onStage, signal);
  onStage("analyze", "Upload complete · waiting for analysis");
  return (await waitForJob(owner.uid, job.jobId, onStage, signal)).analysis;
}

export async function analyzeRemoteTrack(
  url: string,
  onStage: StageCallback,
  signal?: AbortSignal,
): Promise<RemoteTrackResult> {
  if (!backendConfigured) {
    throw new Error("Remote imports require the secure Firebase backend.");
  }
  const owner = getOwnerUser();
  if (!owner) {
    throw new Error("Sign in as the owner from Menu before importing a track link.");
  }
  if (signal?.aborted) throw abortError();

  const normalizedUrl = url.trim();
  const validation = validateRemoteImportUrl(normalizedUrl, spotifyImportEnabled);
  if (!validation.ok) {
    throw new Error(validation.reason === "spotify-disabled"
      ? "Spotify importing is disabled on this deployment. Use a YouTube video URL."
      : spotifyImportEnabled
        ? "Enter a valid YouTube or Spotify track URL."
        : "Enter a valid YouTube video URL.");
  }
  let active = recalledRemoteJob();
  if (active && active.ownerUid !== owner.uid) {
    forgetRemoteJob();
    active = null;
  }
  if (active && active.url !== normalizedUrl) {
    throw new Error("Another remote import is still active. Reopen STEMulate to resume it before starting a different track.");
  }
  if (!active) {
    active = {
      ownerUid: owner.uid,
      provider: validation.provider,
      clientRequestId: crypto.randomUUID(),
      url: normalizedUrl,
      createdAt: Date.now(),
    };
    // Persist before the callable. If its response is lost after Firestore
    // commits, the same request ID is replayed instead of creating a second job.
    rememberRemoteJob(active);
  }

  const created = await ensureRemoteJob(active, onStage, signal);
  return finishRemoteJob(created, onStage, signal);
}

function isTerminalCreateError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
  return [
    "functions/invalid-argument",
    "functions/failed-precondition",
    "functions/resource-exhausted",
    "functions/already-exists",
  ].includes(code);
}

async function ensureRemoteJob(
  active: ActiveRemoteJob,
  onStage: StageCallback,
  signal?: AbortSignal,
): Promise<CreatedRemoteJob> {
  if (active.jobId) return active as CreatedRemoteJob;
  if (signal?.aborted) throw abortError();

  onStage("download", "Creating a private single-track import");
  const createRemoteJob = httpsCallable<
    { url: string; clientRequestId: string; rightsConfirmed: true },
    CreateRemoteJobResult
  >(getStemulateFunctions(), "createRemoteProcessingJob");
  let response;
  try {
    response = await createRemoteJob({
      url: active.url,
      clientRequestId: active.clientRequestId,
      rightsConfirmed: true,
    });
  } catch (error) {
    if (isTerminalCreateError(error)) forgetRemoteJob();
    throw error;
  }
  if (signal?.aborted) throw abortError();

  const job = response.data;
  if (!job?.jobId || (job.provider !== "youtube" && job.provider !== "spotify")) {
    forgetRemoteJob();
    throw new TerminalJobError("The backend did not return a valid remote import job.");
  }
  const created: CreatedRemoteJob = {
    ...active,
    jobId: job.jobId,
    provider: job.provider,
  };
  rememberRemoteJob(created);
  onStage(
    "download",
    job.provider === "spotify"
      ? "Matching Spotify metadata to YouTube Music with spotDL"
      : "Queued for an authorized yt-dlp download",
  );
  return created;
}

async function finishRemoteJob(
  active: CreatedRemoteJob,
  onStage: StageCallback,
  signal?: AbortSignal,
): Promise<RemoteTrackResult> {
  let completed: CompletedJobResult;
  try {
    completed = await waitForJob(active.ownerUid, active.jobId, onStage, signal);
  } catch (error) {
    if (error instanceof TerminalJobError) forgetRemoteJob();
    throw error;
  }
  forgetRemoteJob();
  const provider = completed.sourceProvider || active.provider;
  const defaultTitle = provider === "spotify" ? "Spotify import" : "YouTube import";
  const title = completed.displayName?.trim() || defaultTitle;
  const source = provider === "spotify"
    ? "Spotify track · spotDL → YouTube Music · Music.ai"
    : "YouTube track · yt-dlp · Music.ai";

  return { analysis: completed.analysis, title, source, provider };
}

export async function resumeRemoteTrack(
  onStage: StageCallback,
  signal?: AbortSignal,
): Promise<RemoteTrackResult | null> {
  if (!backendConfigured) return null;
  const owner = getOwnerUser();
  const active = recalledRemoteJob();
  if (!owner || !active) return null;
  if (active.ownerUid !== owner.uid) {
    forgetRemoteJob();
    return null;
  }

  onStage("download", "Reconnecting to your private import job");
  const created = await ensureRemoteJob(active, onStage, signal);
  return finishRemoteJob(created, onStage, signal);
}

export function hasPendingRemoteTrack(): boolean {
  const owner = getOwnerUser();
  const active = recalledRemoteJob();
  if (!owner || !active) return false;
  if (active.ownerUid !== owner.uid) {
    forgetRemoteJob();
    return false;
  }
  return true;
}

export function cancelPendingRemoteTrack(): void {
  forgetRemoteJob();
}

export async function loadProcessingJob(jobId: string): Promise<CompletedJobResult> {
  if (!backendConfigured) {
    throw new Error("The secure Firebase backend is not configured yet.");
  }
  const owner = getOwnerUser();
  if (!owner) {
    throw new Error("Sign in before opening a saved song.");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
    throw new Error("The saved song identifier is invalid.");
  }

  const snapshot = await getDoc(
    doc(getStemulateFirestore(), `users/${owner.uid}/jobs/${jobId}`),
  );
  if (!snapshot.exists()) {
    throw new TerminalJobError("The saved song no longer exists.");
  }
  const job = snapshot.data() as PublicJob;
  if (job.status === "failed") {
    throw new TerminalJobError(job.error?.message || "Music.ai could not process this track.");
  }
  if (job.status !== "completed") {
    throw new TerminalJobError("This song is still processing.");
  }

  const materialized = await materializeResult(jobId, job);
  rememberLatestCompletedJob({
    jobId,
    ownerUid: owner.uid,
    expiresAt: materialized.expiresAt,
    updatedAt: Date.now(),
  });
  return {
    analysis: materialized.analysis,
    jobId,
    outputsExpireAt: materialized.expiresAt,
    displayName: job.displayName,
    sourceProvider: job.sourceProvider,
  };
}

export async function refreshLatestOutputs(
  force = false,
): Promise<CompletedJobResult | null> {
  if (!backendConfigured) return null;
  const owner = getOwnerUser();
  const latest = recalledLatestCompletedJob();
  if (!owner || !latest) return null;
  if (latest.ownerUid !== owner.uid) {
    forgetLatestCompletedJob();
    return null;
  }
  if (!force && latest.expiresAt - Date.now() > 60 * 60 * 1000) return null;

  const snapshot = await getDoc(
    doc(getStemulateFirestore(), `users/${owner.uid}/jobs/${latest.jobId}`),
  );
  if (!snapshot.exists()) {
    forgetLatestCompletedJob();
    return null;
  }
  const job = snapshot.data() as PublicJob;
  if (job.status !== "completed") return null;
  const materialized = await materializeResult(latest.jobId, job);
  rememberLatestCompletedJob({
    jobId: latest.jobId,
    ownerUid: owner.uid,
    expiresAt: materialized.expiresAt,
    updatedAt: Date.now(),
  });
  return {
    analysis: materialized.analysis,
    jobId: latest.jobId,
    outputsExpireAt: materialized.expiresAt,
    displayName: job.displayName,
    sourceProvider: job.sourceProvider,
  };
}
