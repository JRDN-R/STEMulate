import {
  AUDIO_STEM_IDS,
  type AudioStemId,
} from "./stems.ts";

export const STEM_PREVIEW_MANIFEST_VERSION = 1 as const;
export const STEM_PREVIEW_CODEC = "mp4a.40.2" as const;
export const STEM_PREVIEW_BITSTREAM = "adts" as const;
export const STEM_WAV_RANGE_DECK_VERSION = 1 as const;
export const STEM_WAV_RANGE_CODEC = "audio/wav" as const;
export const STEM_WAV_RANGE_BITSTREAM = "pcm-range" as const;

export type StemPreviewWindow = {
  startFrame: number;
  frameCount: number;
  /** First encoded byte required to decode this window. */
  prerollByteStart: number;
  /** First encoded byte that contributes samples to this window. */
  byteStart: number;
  byteEndExclusive: number;
};

export type StemPreviewSource = {
  /** Short-lived, CORS-enabled playback URL. Originals use a separate URL. */
  url: string;
  channels: number;
  sizeBytes: number;
  windows: StemPreviewWindow[];
};

/**
 * Versioned playback-only manifest returned by the preview callable.
 *
 * Time is represented as integer PCM frames so every stem shares exact
 * boundaries without accumulating floating-point drift.
 */
export type StemPreviewManifestV1 = {
  version: typeof STEM_PREVIEW_MANIFEST_VERSION;
  codec: typeof STEM_PREVIEW_CODEC;
  bitstream: typeof STEM_PREVIEW_BITSTREAM;
  sampleRate: number;
  packetFrames: number;
  durationFrames: number;
  stems: Partial<Record<AudioStemId, StemPreviewSource>>;
};

export type StemPreviewManifest = StemPreviewManifestV1;
export type WavRangeStreamingDeck = {
  version: typeof STEM_WAV_RANGE_DECK_VERSION;
  codec: typeof STEM_WAV_RANGE_CODEC;
  bitstream: typeof STEM_WAV_RANGE_BITSTREAM;
  sampleRate: number;
  /** PCM-WAV byte ranges are aligned to individual PCM frames. */
  packetFrames: 1;
  durationFrames: number;
  stems: Partial<Record<AudioStemId, StemPreviewSource>>;
};
export type StreamingStemDeck = StemPreviewManifest | WavRangeStreamingDeck;

const STEM_ID_SET = new Set<string>(AUDIO_STEM_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertFiniteInteger(
  value: unknown,
  path: string,
  minimum: number,
): asserts value is number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
  ) {
    throw new TypeError(`${path} must be an integer of at least ${minimum}.`);
  }
}

function readWindow(
  value: unknown,
  path: string,
  sizeBytes: number,
): StemPreviewWindow {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object.`);
  const {
    startFrame,
    frameCount,
    prerollByteStart,
    byteStart,
    byteEndExclusive,
  } = value;
  assertFiniteInteger(startFrame, `${path}.startFrame`, 0);
  assertFiniteInteger(frameCount, `${path}.frameCount`, 1);
  assertFiniteInteger(prerollByteStart, `${path}.prerollByteStart`, 0);
  assertFiniteInteger(byteStart, `${path}.byteStart`, 0);
  assertFiniteInteger(byteEndExclusive, `${path}.byteEndExclusive`, 1);
  if (prerollByteStart > byteStart) {
    throw new TypeError(`${path}.prerollByteStart cannot exceed byteStart.`);
  }
  if (byteEndExclusive <= byteStart) {
    throw new TypeError(`${path} must contain a non-empty byte range.`);
  }
  if (byteEndExclusive > sizeBytes) {
    throw new TypeError(`${path}.byteEndExclusive exceeds the stem size.`);
  }
  return {
    startFrame,
    frameCount,
    prerollByteStart,
    byteStart,
    byteEndExclusive,
  };
}

function readStem(
  value: unknown,
  id: AudioStemId,
  durationFrames: number,
): StemPreviewSource {
  const path = `manifest.stems.${id}`;
  if (!isRecord(value)) throw new TypeError(`${path} must be an object.`);
  const { url, channels, sizeBytes, windows } = value;
  if (typeof url !== "string" || !url.trim()) {
    throw new TypeError(`${path}.url must be a non-empty string.`);
  }
  assertFiniteInteger(channels, `${path}.channels`, 1);
  if (channels > 8) throw new TypeError(`${path}.channels cannot exceed 8.`);
  assertFiniteInteger(sizeBytes, `${path}.sizeBytes`, 1);
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new TypeError(`${path}.windows must contain at least one window.`);
  }

  const result = windows.map((window, index) => (
    readWindow(window, `${path}.windows[${index}]`, sizeBytes)
  ));
  let nextFrame = 0;
  let previousByteEnd = 0;
  result.forEach((window, index) => {
    if (window.startFrame !== nextFrame) {
      throw new TypeError(
        `${path}.windows[${index}] must start at frame ${nextFrame}.`,
      );
    }
    if (window.byteStart < previousByteEnd) {
      throw new TypeError(`${path}.windows byte ranges cannot overlap.`);
    }
    nextFrame += window.frameCount;
    previousByteEnd = window.byteEndExclusive;
  });
  if (nextFrame !== durationFrames) {
    throw new TypeError(
      `${path}.windows cover ${nextFrame} frames; expected ${durationFrames}.`,
    );
  }

  return {
    url,
    channels,
    sizeBytes,
    windows: result,
  };
}

/**
 * Validates untrusted callable/Firestore data and returns a detached manifest.
 */
function validateDeck(
  value: unknown,
  format: "aac" | "wav",
): StreamingStemDeck {
  if (!isRecord(value)) throw new TypeError("Preview manifest must be an object.");
  const expectedVersion = format === "aac"
    ? STEM_PREVIEW_MANIFEST_VERSION
    : STEM_WAV_RANGE_DECK_VERSION;
  const expectedCodec = format === "aac"
    ? STEM_PREVIEW_CODEC
    : STEM_WAV_RANGE_CODEC;
  const expectedBitstream = format === "aac"
    ? STEM_PREVIEW_BITSTREAM
    : STEM_WAV_RANGE_BITSTREAM;
  if (value.version !== expectedVersion) {
    throw new TypeError(
      `Unsupported preview manifest version ${String(value.version)}.`,
    );
  }
  if (value.codec !== expectedCodec) {
    throw new TypeError(`Unsupported preview codec ${String(value.codec)}.`);
  }
  if (value.bitstream !== expectedBitstream) {
    throw new TypeError(`Unsupported preview bitstream ${String(value.bitstream)}.`);
  }
  assertFiniteInteger(value.sampleRate, "manifest.sampleRate", 8_000);
  if (value.sampleRate > 192_000) {
    throw new TypeError("manifest.sampleRate cannot exceed 192000.");
  }
  assertFiniteInteger(value.packetFrames, "manifest.packetFrames", 1);
  if (
    format === "aac"
    && (value.sampleRate !== 48_000 || value.packetFrames !== 1_024)
  ) {
    throw new TypeError("AAC previews must use 48 kHz, 1,024-frame packets.");
  }
  if (format === "wav" && value.packetFrames !== 1) {
    throw new TypeError("PCM-WAV range decks must use packetFrames 1.");
  }
  assertFiniteInteger(value.durationFrames, "manifest.durationFrames", 1);
  if (
    format === "aac"
    && value.durationFrames % value.packetFrames !== 0
  ) {
    throw new TypeError("AAC preview duration must align to complete packets.");
  }
  if (!isRecord(value.stems)) {
    throw new TypeError("manifest.stems must be an object.");
  }

  const unknownId = Object.keys(value.stems).find((id) => !STEM_ID_SET.has(id));
  if (unknownId) {
    throw new TypeError(`manifest.stems contains unsupported stem "${unknownId}".`);
  }

  const stems: Partial<Record<AudioStemId, StemPreviewSource>> = {};
  for (const id of AUDIO_STEM_IDS) {
    const stem = value.stems[id];
    if (stem !== undefined) {
      stems[id] = readStem(stem, id, value.durationFrames);
    }
  }
  const loadedIds = AUDIO_STEM_IDS.filter((id) => Boolean(stems[id]));
  if (loadedIds.length === 0) {
    throw new TypeError("manifest.stems must contain at least one audio stem.");
  }

  const reference = stems[loadedIds[0]]!.windows;
  for (const id of loadedIds) {
    const source = stems[id]!;
    if (source.channels > 2) {
      throw new TypeError("Streaming decks support only mono or stereo stems.");
    }
    let previousByteEnd: number | null = null;
    source.windows.forEach((window, index) => {
      if (previousByteEnd !== null && window.byteStart !== previousByteEnd) {
        throw new TypeError("Streaming window byte ranges must be contiguous.");
      }
      if (format === "wav") {
        if (window.prerollByteStart !== window.byteStart) {
          throw new TypeError("PCM-WAV windows cannot contain encoded preroll.");
        }
      } else if (
        window.prerollByteStart >= window.byteStart
        || window.byteStart - window.prerollByteStart < 7
        || window.byteStart - window.prerollByteStart > 8_191
        || (index === 0 && window.prerollByteStart !== 0)
      ) {
        throw new TypeError("AAC windows must contain exactly one bounded preroll packet.");
      }
      previousByteEnd = window.byteEndExclusive;
    });
    if (
      format === "aac"
      && source.windows.at(-1)?.byteEndExclusive !== source.sizeBytes
    ) {
      throw new TypeError("AAC windows must end at the encoded object size.");
    }
  }
  for (const id of loadedIds.slice(1)) {
    const windows = stems[id]!.windows;
    if (windows.length !== reference.length) {
      throw new TypeError("Every preview stem must use the same frame windows.");
    }
    windows.forEach((window, index) => {
      const expected = reference[index];
      if (
        window.startFrame !== expected.startFrame
        || window.frameCount !== expected.frameCount
      ) {
        throw new TypeError("Every preview stem must use the same frame windows.");
      }
    });
  }

  const result = {
    version: expectedVersion,
    codec: expectedCodec,
    bitstream: expectedBitstream,
    sampleRate: value.sampleRate,
    packetFrames: value.packetFrames,
    durationFrames: value.durationFrames,
    stems,
  };
  return result as StreamingStemDeck;
}

export function validateStemPreviewManifest(
  value: unknown,
): StemPreviewManifest {
  return validateDeck(value, "aac") as StemPreviewManifest;
}

export function validateStreamingStemDeck(
  value: unknown,
): StreamingStemDeck {
  if (
    isRecord(value)
    && value.codec === STEM_WAV_RANGE_CODEC
    && value.bitstream === STEM_WAV_RANGE_BITSTREAM
  ) {
    return validateDeck(value, "wav");
  }
  return validateDeck(value, "aac");
}

export function previewDurationSeconds(manifest: StreamingStemDeck): number {
  return manifest.durationFrames / manifest.sampleRate;
}

export function previewWindowSeconds(
  manifest: StreamingStemDeck,
  window: StemPreviewWindow,
): { start: number; duration: number } {
  return {
    start: window.startFrame / manifest.sampleRate,
    duration: window.frameCount / manifest.sampleRate,
  };
}
