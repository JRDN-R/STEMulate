import {
  MAX_OUTPUT_FILES,
  MUSIC_AI_API_BASE_URL,
  MUSIC_AI_API_KEY,
  MUSIC_AI_INPUT_PARAM,
  MUSIC_AI_WORKFLOW_SLUG,
  MUSIC_AI_WORKFLOW_SLUGS,
  musicAiOutputHosts,
} from "./config";

export type MusicAiStatus = "QUEUED" | "STARTED" | "SUCCEEDED" | "FAILED";

export interface MusicAiCreateResponse {
  id: string;
}

export interface MusicAiJobResponse {
  id: string;
  status: MusicAiStatus;
  result?: unknown;
  error?: unknown;
}

export interface ResultSource {
  key: string;
  url: string;
}

export interface MusicAiWorkflow {
  key: string;
  slug: string;
}

export interface MusicAiWorkflowResult {
  workflow: MusicAiWorkflow;
  sources: ResultSource[];
  analysis: Record<string, string | number | boolean>;
}

export type MusicAiSubmissionDisposition =
  | "submit"
  | "resume_polling"
  | "in_flight"
  | "uncertain";

export function musicAiSubmissionDisposition(
  checkpoint: {
    musicAiJobId?: string;
    submissionAttempted: boolean;
    submissionLeaseUntilMs?: number;
  },
  nowMs: number,
): MusicAiSubmissionDisposition {
  if (checkpoint.musicAiJobId) return "resume_polling";
  if (!checkpoint.submissionAttempted) return "submit";
  if (
    checkpoint.submissionLeaseUntilMs !== undefined
    && checkpoint.submissionLeaseUntilMs > nowMs
  ) {
    return "in_flight";
  }
  return "uncertain";
}

export class MusicAiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MusicAiHttpError";
  }

  get retryable(): boolean {
    return this.status === 408
      || this.status === 409
      || this.status === 425
      || this.status === 429
      || this.status >= 500;
  }
}

const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength)
      || declaredLength < 0
      || declaredLength > MAX_API_RESPONSE_BYTES
    ) {
      await response.body?.cancel();
      throw new Error("Music.ai returned an invalid or oversized API response.");
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sizeBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sizeBytes += value.byteLength;
      if (sizeBytes > MAX_API_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Music.ai returned an oversized API response.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function apiUrl(path: string): string {
  const configured = new URL(MUSIC_AI_API_BASE_URL.value().replace(/\/+$/, ""));
  if (
    configured.protocol !== "https:"
    || configured.hostname !== "api.music.ai"
    || configured.pathname.replace(/\/+$/, "") !== "/v1"
  ) {
    throw new Error("MUSIC_AI_API_BASE_URL must be https://api.music.ai/v1.");
  }
  return `${configured.toString().replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      Authorization: MUSIC_AI_API_KEY.value(),
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });

  const bodyText = await readBoundedResponseText(response);
  let body: unknown;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = { message: bodyText.slice(0, 500) };
  }

  if (!response.ok) {
    const detail = typeof body === "object" && body !== null && "message" in body
      ? String((body as { message: unknown }).message).slice(0, 500)
      : `HTTP ${response.status}`;
    throw new MusicAiHttpError(response.status, detail);
  }

  return body as T;
}

function validateCreate(response: MusicAiCreateResponse): MusicAiCreateResponse {
  if (!response || typeof response.id !== "string" || !response.id) {
    throw new Error("Music.ai returned a response without a job ID.");
  }
  return response;
}

function validateJob(response: MusicAiJobResponse): MusicAiJobResponse {
  validateCreate(response);
  if (!["QUEUED", "STARTED", "SUCCEEDED", "FAILED"].includes(response.status)) {
    throw new Error("Music.ai returned an unrecognized job status.");
  }
  return response;
}

const WORKFLOW_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const WORKFLOW_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Parses the multi-workflow setting without exposing it to the browser.
 *
 * Named entries are strongly recommended because their stable keys survive
 * reordering and provide deterministic collision names. Bare slugs remain
 * accepted as workflow_1, workflow_2, ... for a small configuration.
 */
export function parseMusicAiWorkflows(
  multiple: string,
  legacySingle: string,
): MusicAiWorkflow[] {
  const configured = multiple.trim();
  const rawEntries = configured
    ? configured.split(",").map((entry) => entry.trim()).filter(Boolean)
    : [];
  const workflows = rawEntries.length
    ? rawEntries.map((entry, index) => {
      const separator = entry.indexOf("=");
      if (separator < 0) {
        return { key: `workflow_${index + 1}`, slug: entry };
      }
      return {
        key: entry.slice(0, separator).trim(),
        slug: entry.slice(separator + 1).trim(),
      };
    })
    : [{ key: "primary", slug: legacySingle.trim() }];

  if (
    workflows.length === 0
    || workflows.length > 8
    || workflows.some(({ key, slug }) =>
      !WORKFLOW_KEY_PATTERN.test(key)
      || !WORKFLOW_SLUG_PATTERN.test(slug)
      || slug.startsWith("replace-with-"),
    )
  ) {
    throw new Error(
      "Configure one to eight Music.ai workflows as comma-separated key=slug entries.",
    );
  }

  const keys = new Set(workflows.map(({ key }) => key));
  const slugs = new Set(workflows.map(({ slug }) => slug));
  if (keys.size !== workflows.length || slugs.size !== workflows.length) {
    throw new Error("Music.ai workflow keys and slugs must be unique.");
  }
  return workflows;
}

export function configuredMusicAiWorkflows(): MusicAiWorkflow[] {
  return parseMusicAiWorkflows(
    MUSIC_AI_WORKFLOW_SLUGS.value(),
    MUSIC_AI_WORKFLOW_SLUG.value(),
  );
}

export async function submitMusicAiJob(
  stemulateJobId: string,
  inputUrl: string,
  workflowConfig?: MusicAiWorkflow,
): Promise<MusicAiCreateResponse> {
  const selectedWorkflow = workflowConfig ?? configuredMusicAiWorkflows()[0];
  const inputParam = MUSIC_AI_INPUT_PARAM.value().trim();

  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(inputParam)) {
    throw new Error("MUSIC_AI_INPUT_PARAM must be a simple parameter name.");
  }

  const response = await request<MusicAiCreateResponse>("job", {
    method: "POST",
    body: JSON.stringify({
      name: `STEMulate ${stemulateJobId} (${selectedWorkflow.key})`,
      workflow: selectedWorkflow.slug,
      params: { [inputParam]: inputUrl },
      metadata: {
        stemulateJobId,
        stemulateWorkflowKey: selectedWorkflow.key,
      },
    }),
  });

  return validateCreate(response);
}

export async function getMusicAiJob(jobId: string): Promise<MusicAiJobResponse> {
  return validateJob(
    await request<MusicAiJobResponse>(`job/${encodeURIComponent(jobId)}`, {
      method: "GET",
    }),
  );
}

function safeKeyPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "output";
}

export function extractResultSources(result: unknown): ResultSource[] {
  const candidates: Array<{ path: string[]; url: string }> = [];

  const visit = (value: unknown, path: string[], depth: number): void => {
    if (depth > 8 || candidates.length > MAX_OUTPUT_FILES.value()) return;
    if (typeof value === "string") {
      try {
        const url = new URL(value);
        if (
          url.protocol === "https:"
          && !url.username
          && !url.password
          && !url.port
          && musicAiOutputHosts().has(url.hostname.toLowerCase())
        ) {
          candidates.push({ path, url: url.toString() });
        }
      } catch {
        // Inline strings are metadata, not downloadable output artifacts.
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)], depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => {
        visit(item, [...path, key], depth + 1);
      });
    }
  };

  visit(result, [], 0);

  if (candidates.length > MAX_OUTPUT_FILES.value()) {
    throw new Error("Music.ai returned more output artifacts than configured.");
  }

  const used = new Set<string>();
  return candidates.map(({ path, url }, index) => {
    const base = safeKeyPart(path.map(safeKeyPart).join("__") || `output_${index + 1}`);
    let key = base;
    let suffix = 2;
    while (used.has(key)) key = `${base.slice(0, 43)}_${suffix++}`;
    used.add(key);
    return { key, url };
  });
}

function collisionKey(workflowKey: string, outputKey: string): string {
  return safeKeyPart(`${workflowKey}__${outputKey}`);
}

/**
 * Combines independent workflow results into the existing flat output contract.
 * The first occurrence keeps its original key for frontend compatibility; only
 * collisions are namespaced with the stable workflow key.
 */
export function mergeMusicAiWorkflowResults(
  results: MusicAiWorkflowResult[],
): {
    sources: ResultSource[];
    analysis: Record<string, string | number | boolean>;
  } {
  const sources: ResultSource[] = [];
  const sourceKeys = new Set<string>();
  const analysis: Record<string, string | number | boolean> = {};

  for (const result of results) {
    for (const source of result.sources) {
      let key = source.key;
      if (sourceKeys.has(key)) key = collisionKey(result.workflow.key, source.key);
      let suffix = 2;
      const base = key;
      while (sourceKeys.has(key)) {
        key = `${base.slice(0, 43)}_${suffix++}`;
      }
      sourceKeys.add(key);
      sources.push({ key, url: source.url });
    }

    for (const [rawKey, value] of Object.entries(result.analysis)) {
      const key = safeKeyPart(rawKey).toLowerCase();
      if (!(key in analysis)) {
        analysis[key] = value;
      } else if (analysis[key] !== value) {
        let alternate = safeKeyPart(`${result.workflow.key}_${key}`).toLowerCase();
        let suffix = 2;
        const base = alternate;
        while (alternate in analysis) {
          alternate = `${base.slice(0, 43)}_${suffix++}`;
        }
        analysis[alternate] = value;
      }
    }
  }

  if (sources.length > MAX_OUTPUT_FILES.value()) {
    throw new Error("Music.ai workflows returned more output artifacts than configured.");
  }
  return { sources, analysis };
}

const ANALYSIS_KEYS = new Set([
  "bpm",
  "tempo",
  "key",
  "rootkey",
  "root_key",
  "duration",
]);

/** Keep small scalar analysis values in Firestore while large maps remain files. */
export function extractScalarAnalysis(result: unknown): Record<string, string | number | boolean> {
  const analysis: Record<string, string | number | boolean> = {};

  const visit = (value: unknown, path: string[], depth: number): void => {
    if (depth > 8 || Object.keys(analysis).length >= 24) return;
    if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => visit(item, [...path, key], depth + 1));
      return;
    }
    if (!["string", "number", "boolean"].includes(typeof value)) return;
    const leaf = path.at(-1)?.toLowerCase().replace(/[^a-z0-9_]+/g, "_") ?? "";
    if (!ANALYSIS_KEYS.has(leaf)) return;
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return;
    const key = leaf === "rootkey" || leaf === "root_key" ? "key" : leaf;
    analysis[key] = value as string | number | boolean;
  };

  visit(result, [], 0);
  return analysis;
}
