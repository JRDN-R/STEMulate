import { CloudTasksClient, protos } from "@google-cloud/tasks";

import {
  DOWNLOADER_INVOKER_SERVICE_ACCOUNT,
  DOWNLOADER_QUEUE_ID,
  DOWNLOADER_SERVICE_URL,
  REGION,
} from "./config";

export interface DownloadTaskPayload {
  jobId: string;
  ownerUid: string;
  storageBucket: string;
  inputPath: string;
  uploadUrl: string;
}

const tasksClient = new CloudTasksClient();

function projectId(): string {
  const value = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (!value) throw new Error("Google Cloud project ID is unavailable.");
  return value;
}

export function downloaderConfig() {
  const serviceUrl = new URL(DOWNLOADER_SERVICE_URL.value().replace(/\/+$/, ""));
  const queueId = DOWNLOADER_QUEUE_ID.value().trim();
  const serviceAccountEmail = DOWNLOADER_INVOKER_SERVICE_ACCOUNT.value().trim();
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
    throw new Error("DOWNLOADER_SERVICE_URL must be the private service's base run.app URL.");
  }
  if (!/^[a-z][a-z0-9-]{0,98}[a-z0-9]$/.test(queueId)) {
    throw new Error("DOWNLOADER_QUEUE_ID is invalid.");
  }
  if (
    serviceAccountEmail.startsWith("replace-with-")
    || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(serviceAccountEmail)
  ) {
    throw new Error("DOWNLOADER_INVOKER_SERVICE_ACCOUNT is invalid.");
  }
  return {
    serviceUrl: serviceUrl.toString().replace(/\/$/, ""),
    queueId,
    serviceAccountEmail,
  };
}

export async function enqueueDownloadTask(payload: DownloadTaskPayload): Promise<void> {
  if (
    !/^[a-f0-9]{32}$/.test(payload.jobId)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.ownerUid)
    || !/^[A-Za-z0-9._-]{3,222}$/.test(payload.storageBucket)
    || payload.inputPath !== `users/${payload.ownerUid}/jobs/${payload.jobId}/input/source.m4a`
    || payload.uploadUrl.length > 16_384
  ) {
    throw new Error("Remote download task payload is invalid.");
  }
  const { serviceUrl, queueId, serviceAccountEmail } = downloaderConfig();
  const project = projectId();
  const parent = tasksClient.queuePath(project, REGION, queueId);
  const taskName = tasksClient.taskPath(project, REGION, queueId, `download-${payload.jobId}`);
  const task: protos.google.cloud.tasks.v2.ITask = {
    name: taskName,
    dispatchDeadline: { seconds: 1_500 },
    httpRequest: {
      httpMethod: protos.google.cloud.tasks.v2.HttpMethod.POST,
      url: `${serviceUrl}/tasks/download`,
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
