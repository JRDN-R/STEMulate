import { CloudTasksClient, protos } from "@google-cloud/tasks";

import {
  PREVIEW_INVOKER_SERVICE_ACCOUNT,
  PREVIEW_QUEUE_ID,
  PREVIEW_SERVICE_URL,
  REGION,
} from "./config";
import {
  previewManifestPath,
} from "./preview-manifest";
import type { PreviewTaskOutput } from "./preview-outputs";

export interface PreviewTaskPayload {
  jobId: string;
  ownerUid: string;
  attempt: number;
  storageBucket: string;
  outputs: PreviewTaskOutput[];
  manifestPath: string;
}

const tasksClient = new CloudTasksClient();
function projectId(): string {
  const value = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (!value) throw new Error("Google Cloud project ID is unavailable.");
  return value;
}

export function previewServiceConfig() {
  const serviceUrl = new URL(PREVIEW_SERVICE_URL.value().replace(/\/+$/, ""));
  const queueId = PREVIEW_QUEUE_ID.value().trim();
  const serviceAccountEmail = PREVIEW_INVOKER_SERVICE_ACCOUNT.value().trim();
  if (
    serviceUrl.protocol !== "https:"
    || !serviceUrl.hostname.endsWith(".run.app")
    || serviceUrl.pathname !== "/"
    || serviceUrl.search
    || serviceUrl.hash
    || serviceUrl.username
    || serviceUrl.password
    || serviceUrl.hostname.startsWith("replace-with-")
  ) {
    throw new Error("PREVIEW_SERVICE_URL must be the private service's base run.app URL.");
  }
  if (!/^[a-z][a-z0-9-]{0,98}[a-z0-9]$/.test(queueId)) {
    throw new Error("PREVIEW_QUEUE_ID is invalid.");
  }
  if (
    serviceAccountEmail.startsWith("replace-with-")
    || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(
      serviceAccountEmail,
    )
  ) {
    throw new Error("PREVIEW_INVOKER_SERVICE_ACCOUNT is invalid.");
  }
  return {
    serviceUrl: serviceUrl.toString().replace(/\/$/, ""),
    queueId,
    serviceAccountEmail,
  };
}

function validatePayload(payload: PreviewTaskPayload): void {
  const outputPrefix = `users/${payload.ownerUid}/jobs/${payload.jobId}/outputs/`;
  const totalOutputBytes = payload.outputs.reduce(
    (total, output) => total + Number(output.sizeBytes ?? 0),
    0,
  );
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(payload.jobId)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.ownerUid)
    || !Number.isSafeInteger(payload.attempt)
    || payload.attempt < 1
    || payload.attempt > 99
    || !/^[A-Za-z0-9._-]{3,222}$/.test(payload.storageBucket)
    || payload.manifestPath !== previewManifestPath(
      payload.ownerUid,
      payload.jobId,
      payload.attempt,
    )
    || payload.outputs.length < 1
    || payload.outputs.length > 40
    || !Number.isSafeInteger(totalOutputBytes)
    || totalOutputBytes > 2 * 1024 * 1024 * 1024
    || new Set(
      payload.outputs.map(({ key, storagePath }) => `${key}\0${storagePath}`),
    ).size !== payload.outputs.length
    || payload.outputs.some((output) =>
      !/^[A-Za-z0-9_-]{1,128}$/.test(output.key)
      || !output.storagePath.startsWith(outputPrefix)
      || output.storagePath.slice(outputPrefix.length).includes("/")
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/.test(
        output.storagePath.slice(outputPrefix.length),
      )
      || output.storagePath.length > 1_024
      || (
        output.contentType !== undefined
        && (
          output.contentType !== output.contentType.trim()
          || output.contentType.length < 3
          || output.contentType.length > 128
          || !/^[\x20-\x7e]+$/.test(output.contentType)
          || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(
            output.contentType.split(";", 1)[0].trim(),
          )
        )
      )
      || (
        output.sizeBytes !== undefined
        && (
          !Number.isSafeInteger(output.sizeBytes)
          || output.sizeBytes <= 0
          || output.sizeBytes > 512 * 1024 * 1024
        )
      ),
    )
  ) {
    throw new Error("Preview task payload is invalid.");
  }
}

export async function enqueuePreviewTask(
  payload: PreviewTaskPayload,
  attempt: number,
): Promise<void> {
  validatePayload(payload);
  if (
    !Number.isSafeInteger(attempt)
    || attempt < 1
    || attempt > 99
    || payload.attempt !== attempt
  ) {
    throw new Error("Preview task attempt is invalid.");
  }
  const { serviceUrl, queueId, serviceAccountEmail } = previewServiceConfig();
  const project = projectId();
  const parent = tasksClient.queuePath(project, REGION, queueId);
  const taskName = tasksClient.taskPath(
    project,
    REGION,
    queueId,
    `preview-${payload.jobId}-v1-${attempt}`,
  );
  const task: protos.google.cloud.tasks.v2.ITask = {
    name: taskName,
    dispatchDeadline: { seconds: 1_800 },
    httpRequest: {
      httpMethod: protos.google.cloud.tasks.v2.HttpMethod.POST,
      url: `${serviceUrl}/tasks/preview`,
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify(payload), "utf8"),
      oidcToken: {
        serviceAccountEmail,
        audience: serviceUrl,
      },
    },
  };

  try {
    await tasksClient.createTask({ parent, task });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
    if (code === "6" || code === "ALREADY_EXISTS" || code === "already-exists") return;
    throw error;
  }
}
