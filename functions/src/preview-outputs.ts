export interface PreviewSourceOutput {
  key: string;
  storagePath: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface PreviewTaskOutput {
  key: string;
  storagePath: string;
  contentType?: string;
  sizeBytes?: number;
}

const MAX_TASK_OUTPUTS = 40;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;

function validContentType(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length < 3
    || value.length > 128
    || !/^[\x20-\x7e]+$/.test(value)
  ) return false;
  const mediaType = value.split(";", 1)[0].trim();
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType);
}

/**
 * Copies the complete, bounded original-output snapshot into the private task.
 * The worker compares it with both public and internal job records before it
 * selects no more than fourteen canonical audio stems. Nothing here changes or
 * replaces the original export artifacts.
 */
export function preparePreviewOutputs(
  ownerUid: string,
  jobId: string,
  outputs: readonly PreviewSourceOutput[],
): PreviewTaskOutput[] {
  const expectedPrefix = `users/${ownerUid}/jobs/${jobId}/outputs/`;
  if (outputs.length < 1 || outputs.length > MAX_TASK_OUTPUTS) {
    throw new Error("Preview source output count is invalid.");
  }
  const prepared = outputs.map((output): PreviewTaskOutput => {
    const fileName = output.storagePath.startsWith(expectedPrefix)
      ? output.storagePath.slice(expectedPrefix.length)
      : "";
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(output.key)
      || !/^[A-Za-z0-9._-]{1,180}$/.test(fileName)
      || output.contentType === undefined
      || !validContentType(output.contentType)
      || !Number.isSafeInteger(output.sizeBytes)
      || Number(output.sizeBytes) <= 0
      || Number(output.sizeBytes) > MAX_SOURCE_BYTES
    ) {
      throw new Error("Preview source output record is invalid.");
    }
    return {
      key: output.key,
      storagePath: `${expectedPrefix}${fileName}`,
      contentType: output.contentType,
      sizeBytes: Number(output.sizeBytes),
    };
  });
  prepared.sort((left, right) => left.key.localeCompare(right.key));
  const totalBytes = prepared.reduce(
    (total, output) => total + Number(output.sizeBytes),
    0,
  );
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_SOURCE_BYTES) {
    throw new Error("Preview source outputs exceed the aggregate size limit.");
  }
  if (
    new Set(prepared.map(({ key, storagePath }) => `${key}\0${storagePath}`)).size
    !== prepared.length
  ) {
    throw new Error("Preview source output records must be unique.");
  }
  return prepared;
}
