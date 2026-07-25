import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";

import type { RemoteSourceProvider } from "../types";
import {
  getStemulateFirestore,
  getStemulateFunctions,
} from "./firebase";

export type SongLibraryStatus =
  | "awaiting_upload"
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export type SongLibraryItem = {
  id: string;
  title: string;
  status: SongLibraryStatus;
  stage: string;
  key: string | null;
  bpm: number | null;
  sourceType: "upload" | "remote";
  sourceProvider: RemoteSourceProvider | null;
  sourceFileName: string | null;
  outputCount: number;
  canOpen: boolean;
  createdAt: number | null;
  updatedAt: number | null;
  errorMessage: string | null;
};

export type SongLibrarySubscription = {
  unsubscribe: Unsubscribe;
};

const MAX_LIBRARY_ITEMS = 100;
const VALID_OWNER_UID = /^[A-Za-z0-9_-]{1,128}$/;
const VALID_JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function timestampMillis(value: unknown): number | null {
  if (!value || typeof value !== "object" || !("toMillis" in value)) return null;
  const toMillis = (value as { toMillis?: unknown }).toMillis;
  if (typeof toMillis !== "function") return null;
  const milliseconds = Number(toMillis.call(value));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function knownStatus(value: unknown): SongLibraryStatus {
  return value === "awaiting_upload"
    || value === "queued"
    || value === "processing"
    || value === "completed"
    || value === "failed"
    ? value
    : "processing";
}

function libraryItemFromSnapshot(
  snapshot: QueryDocumentSnapshot<DocumentData>,
): SongLibraryItem {
  const data = snapshot.data();
  const analysis = data.analysis && typeof data.analysis === "object"
    ? data.analysis as Record<string, unknown>
    : {};
  const outputs = Array.isArray(data.outputs) ? data.outputs : [];
  const status = knownStatus(data.status);
  const sourceFileName = optionalString(data.sourceFileName);
  const displayName = optionalString(data.displayName);
  const error = data.error && typeof data.error === "object"
    ? data.error as Record<string, unknown>
    : {};
  const sourceProvider = data.sourceProvider === "youtube" || data.sourceProvider === "spotify"
    ? data.sourceProvider
    : null;

  return {
    id: snapshot.id,
    title: displayName || sourceFileName?.replace(/\.[^.]+$/, "") || "Untitled track",
    status,
    stage: optionalString(data.stage) || status,
    key: optionalString(analysis.key ?? analysis.rootKey ?? analysis.root_key),
    bpm: optionalNumber(analysis.bpm ?? analysis.tempo),
    sourceType: data.sourceType === "remote" ? "remote" : "upload",
    sourceProvider,
    sourceFileName,
    outputCount: outputs.length,
    canOpen: status === "completed" && outputs.length > 0,
    createdAt: timestampMillis(data.createdAt),
    updatedAt: timestampMillis(data.updatedAt),
    errorMessage: optionalString(error.message),
  };
}

export function subscribeSongLibrary(
  ownerUid: string,
  onItems: (items: SongLibraryItem[]) => void,
  onError: (error: Error) => void,
): SongLibrarySubscription {
  if (!VALID_OWNER_UID.test(ownerUid)) {
    throw new Error("The signed-in user identifier is invalid.");
  }
  const jobs = query(
    collection(getStemulateFirestore(), "users", ownerUid, "jobs"),
    orderBy("createdAt", "desc"),
    limit(MAX_LIBRARY_ITEMS),
  );
  const unsubscribe = onSnapshot(
    jobs,
    (snapshot) => onItems(snapshot.docs.map(libraryItemFromSnapshot)),
    (error) => onError(error),
  );
  return { unsubscribe };
}

export async function renameSongLibraryItem(
  jobId: string,
  nextTitle: string,
): Promise<string> {
  const displayName = nextTitle.trim();
  if (!VALID_JOB_ID.test(jobId)) {
    throw new Error("The saved song identifier is invalid.");
  }
  if (!displayName || displayName.length > 120 || /[\u0000-\u001f\u007f]/.test(displayName)) {
    throw new Error("Use a title between 1 and 120 characters.");
  }
  const renameJob = httpsCallable<
    { jobId: string; displayName: string },
    { jobId: string; displayName: string }
  >(getStemulateFunctions(), "renameProcessingJob");
  const response = await renameJob({ jobId, displayName });
  if (response.data.jobId !== jobId || response.data.displayName !== displayName) {
    throw new Error("The backend returned an invalid rename result.");
  }
  return response.data.displayName;
}
