export const PREVIEW_MANIFEST_VERSION = 1 as const;
export const PREVIEW_CODEC = "mp4a.40.2" as const;
export const PREVIEW_BITSTREAM = "adts" as const;
export const PREVIEW_SAMPLE_RATE = 48_000 as const;
export const PREVIEW_PACKET_FRAMES = 1_024 as const;
export const PREVIEW_MANIFEST_FILE = "manifest.json";
export const MAX_PREVIEW_MANIFEST_BYTES = 524_288;

export const PREVIEW_STEM_IDS = [
  "vocals",
  "drums",
  "kick",
  "snare",
  "toms",
  "hi_hat",
  "cymbals",
  "bass",
  "guitars",
  "piano",
  "keys",
  "strings",
  "wind",
  "other",
] as const;

export type PreviewStemId = (typeof PREVIEW_STEM_IDS)[number];

export interface PreviewWindowV1 {
  startFrame: number;
  frameCount: number;
  prerollByteStart: number;
  byteStart: number;
  byteEndExclusive: number;
}

export interface PreviewStemV1 {
  storagePath: string;
  channels: 1 | 2;
  sizeBytes: number;
  windows: PreviewWindowV1[];
}

export interface PreviewManifestV1 {
  version: typeof PREVIEW_MANIFEST_VERSION;
  codec: typeof PREVIEW_CODEC;
  bitstream: typeof PREVIEW_BITSTREAM;
  sampleRate: typeof PREVIEW_SAMPLE_RATE;
  packetFrames: typeof PREVIEW_PACKET_FRAMES;
  durationFrames: number;
  stems: Partial<Record<PreviewStemId, PreviewStemV1>>;
}

const STEM_ID_SET = new Set<string>(PREVIEW_STEM_IDS);
const MAX_WINDOWS_PER_STEM = 4_096;
const MAX_PREVIEW_BYTES_PER_STEM = 67_108_864;
const MAX_PREVIEW_DURATION_FRAMES =
  20 * 60 * PREVIEW_SAMPLE_RATE + PREVIEW_PACKET_FRAMES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return Number(value);
}

function nonnegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a nonnegative safe integer.`);
  }
  return Number(value);
}

export function previewStreamPrefix(
  ownerUid: string,
  jobId: string,
  attempt: number,
): string {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(ownerUid)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)
    || !Number.isSafeInteger(attempt)
    || attempt < 1
    || attempt > 99
  ) {
    throw new Error("Preview owner, job ID, or attempt is invalid.");
  }
  return `users/${ownerUid}/jobs/${jobId}/streams/v1/attempt-${attempt}/`;
}

export function previewManifestPath(
  ownerUid: string,
  jobId: string,
  attempt: number,
): string {
  return `${previewStreamPrefix(ownerUid, jobId, attempt)}${PREVIEW_MANIFEST_FILE}`;
}

/**
 * Validates untrusted worker output and returns a newly allocated, typed
 * manifest. The byte windows must cover each ADTS object exactly, with no
 * gaps or overlaps, and every stem must cover the shared decoded timeline.
 */
export function validatePreviewManifestV1(
  value: unknown,
  ownerUid: string,
  jobId: string,
  attempt: number,
): PreviewManifestV1 {
  if (!isRecord(value)) throw new Error("Preview manifest must be an object.");
  if (value.version !== PREVIEW_MANIFEST_VERSION) {
    throw new Error("Unsupported preview manifest version.");
  }
  if (
    value.codec !== PREVIEW_CODEC
    || value.bitstream !== PREVIEW_BITSTREAM
    || value.sampleRate !== PREVIEW_SAMPLE_RATE
    || value.packetFrames !== PREVIEW_PACKET_FRAMES
  ) {
    throw new Error("Preview manifest audio format is invalid.");
  }

  const durationFrames = positiveSafeInteger(
    value.durationFrames,
    "durationFrames",
  );
  if (
    durationFrames > MAX_PREVIEW_DURATION_FRAMES
    || durationFrames % PREVIEW_PACKET_FRAMES !== 0
  ) {
    throw new Error("Preview duration does not align to AAC packets.");
  }
  if (!isRecord(value.stems)) throw new Error("Preview stems must be an object.");
  const entries = Object.entries(value.stems);
  if (entries.length < 1 || entries.length > PREVIEW_STEM_IDS.length) {
    throw new Error("Preview manifest must contain one to fourteen stems.");
  }

  const prefix = previewStreamPrefix(ownerUid, jobId, attempt);
  const stems: Partial<Record<PreviewStemId, PreviewStemV1>> = {};
  for (const [stemId, rawStem] of entries) {
    if (!STEM_ID_SET.has(stemId) || !isRecord(rawStem)) {
      throw new Error("Preview manifest contains an invalid stem.");
    }
    const typedStemId = stemId as PreviewStemId;
    const expectedPath = `${prefix}${typedStemId}.aac`;
    if (rawStem.storagePath !== expectedPath) {
      throw new Error("Preview stem escaped its versioned storage path.");
    }
    if (rawStem.channels !== 1 && rawStem.channels !== 2) {
      throw new Error("Preview stem channels must be mono or stereo.");
    }
    const sizeBytes = positiveSafeInteger(rawStem.sizeBytes, "sizeBytes");
    if (sizeBytes > MAX_PREVIEW_BYTES_PER_STEM) {
      throw new Error("Preview stem exceeds the size limit.");
    }
    if (
      !Array.isArray(rawStem.windows)
      || rawStem.windows.length < 1
      || rawStem.windows.length > MAX_WINDOWS_PER_STEM
    ) {
      throw new Error("Preview stem windows are invalid.");
    }

    let nextFrame = 0;
    let nextByte: number | null = null;
    const windows = rawStem.windows.map((rawWindow, index): PreviewWindowV1 => {
      if (!isRecord(rawWindow)) {
        throw new Error(`Preview window ${index} is invalid.`);
      }
      const startFrame = nonnegativeSafeInteger(
        rawWindow.startFrame,
        "startFrame",
      );
      const frameCount = positiveSafeInteger(rawWindow.frameCount, "frameCount");
      const prerollByteStart = nonnegativeSafeInteger(
        rawWindow.prerollByteStart,
        "prerollByteStart",
      );
      const byteStart = nonnegativeSafeInteger(rawWindow.byteStart, "byteStart");
      const byteEndExclusive = positiveSafeInteger(
        rawWindow.byteEndExclusive,
        "byteEndExclusive",
      );
      if (
        startFrame !== nextFrame
        || (nextByte !== null && byteStart !== nextByte)
        || startFrame % PREVIEW_PACKET_FRAMES !== 0
        || frameCount % PREVIEW_PACKET_FRAMES !== 0
        || startFrame + frameCount > durationFrames
        || (
          index === 0
            ? (
              prerollByteStart !== 0
              || byteStart <= prerollByteStart
              || byteStart - prerollByteStart < 7
              || byteStart - prerollByteStart > 8_191
            )
            : (
              prerollByteStart >= byteStart
              || byteStart - prerollByteStart < 7
              || byteStart - prerollByteStart > 8_191
            )
        )
        || byteEndExclusive <= byteStart
        || byteEndExclusive > sizeBytes
      ) {
        throw new Error("Preview windows must be contiguous and in bounds.");
      }
      nextFrame = startFrame + frameCount;
      nextByte = byteEndExclusive;
      return {
        startFrame,
        frameCount,
        prerollByteStart,
        byteStart,
        byteEndExclusive,
      };
    });
    if (nextFrame !== durationFrames || nextByte !== sizeBytes) {
      throw new Error("Preview windows must cover the complete stem.");
    }

    stems[typedStemId] = {
      storagePath: expectedPath,
      channels: rawStem.channels,
      sizeBytes,
      windows,
    };
  }

  const stemValues = PREVIEW_STEM_IDS
    .map((stemId) => stems[stemId])
    .filter((stem): stem is PreviewStemV1 => Boolean(stem));
  const referenceWindows = stemValues[0].windows;
  for (const stem of stemValues.slice(1)) {
    if (
      stem.windows.length !== referenceWindows.length
      || stem.windows.some((window, index) =>
        window.startFrame !== referenceWindows[index].startFrame
        || window.frameCount !== referenceWindows[index].frameCount,
      )
    ) {
      throw new Error("Every preview stem must use the same frame windows.");
    }
  }

  return {
    version: PREVIEW_MANIFEST_VERSION,
    codec: PREVIEW_CODEC,
    bitstream: PREVIEW_BITSTREAM,
    sampleRate: PREVIEW_SAMPLE_RATE,
    packetFrames: PREVIEW_PACKET_FRAMES,
    durationFrames,
    stems,
  };
}
