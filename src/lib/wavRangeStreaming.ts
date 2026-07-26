import {
  AUDIO_STEM_IDS,
  type AudioStemId,
  type StemSources,
} from "./stems.ts";
import type {
  StreamingStemDeck,
  StemPreviewSource,
  StemPreviewWindow,
  WavRangeStreamingDeck,
} from "./stemPreviewManifest.ts";
import {
  STEM_WAV_RANGE_BITSTREAM,
  STEM_WAV_RANGE_CODEC,
  STEM_WAV_RANGE_DECK_VERSION,
} from "./stemPreviewManifest.ts";
import {
  StreamingAudioUnsupportedError,
  type DecodedPreviewWindow,
  type PreviewDecodeRequest,
  type PreviewWindowDecoder,
} from "./streamingAudioDecoder.ts";

const DEFAULT_MAX_HEADER_BYTES = 128 * 1024;
const ABSOLUTE_MAX_HEADER_BYTES = 256 * 1024;
const DEFAULT_WINDOW_SECONDS = 4;
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 192_000;
const PCM_FORMAT = 0x0001;
const IEEE_FLOAT_FORMAT = 0x0003;
const EXTENSIBLE_FORMAT = 0xfffe;

const PCM_SUBFORMAT_GUID = new Uint8Array([
  0x01, 0x00, 0x00, 0x00,
  0x00, 0x00,
  0x10, 0x00,
  0x80, 0x00,
  0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]);
const FLOAT_SUBFORMAT_GUID = new Uint8Array([
  0x03, 0x00, 0x00, 0x00,
  0x00, 0x00,
  0x10, 0x00,
  0x80, 0x00,
  0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]);

export type WavSampleEncoding =
  | "pcm-s16"
  | "pcm-s24"
  | "pcm-s32"
  | "ieee-f32";

export type WavRangeStemMetadata = {
  url: string;
  sizeBytes: number;
  channels: 1 | 2;
  sampleRate: number;
  encoding: WavSampleEncoding;
  bitsPerSample: 16 | 24 | 32;
  validBitsPerSample: 16 | 24 | 32;
  blockAlign: number;
  durationFrames: number;
  dataByteStart: number;
  dataByteEndExclusive: number;
  extensible: boolean;
};

export type WavRangeStemMetadataMap =
  Partial<Record<AudioStemId, WavRangeStemMetadata>>;

export type RangeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ProbeWavRangeDeckOptions = {
  signal?: AbortSignal;
  fetch?: RangeFetch;
  /**
   * Header reads are intentionally bounded. Files that put `fmt ` or `data`
   * beyond this limit are rejected instead of being silently downloaded.
   */
  maxHeaderBytes?: number;
  /** Common frame-window duration used by every selected stem. */
  windowSeconds?: number;
};

export type WavRangeProbeResult = {
  deck: WavRangeStreamingDeck;
  metadata: WavRangeStemMetadataMap;
};

type ParsedContentRange = {
  start: number;
  endInclusive: number;
  totalSize: number;
};

type FetchedRange = {
  bytes: ArrayBuffer;
  /** Available only when the bucket exposes Content-Range through CORS. */
  totalSize: number | null;
};

function defaultRangeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Calling through globalThis preserves the Window receiver Safari expects.
  return globalThis.fetch(input, init);
}

function abortError(): DOMException {
  return new DOMException("The WAV range operation was cancelled.", "AbortError");
}

function assertSafeInteger(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer of at least ${minimum}.`);
  }
}

function parseContentRange(value: string): ParsedContentRange {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
  if (!match) throw new Error("The audio host exposed an invalid Content-Range header.");
  const start = Number(match[1]);
  const endInclusive = Number(match[2]);
  const totalSize = Number(match[3]);
  assertSafeInteger(start, "Content-Range start");
  assertSafeInteger(endInclusive, "Content-Range end");
  assertSafeInteger(totalSize, "Content-Range total", 1);
  if (endInclusive < start || endInclusive >= totalSize) {
    throw new Error("The audio host returned an invalid Content-Range interval.");
  }
  return { start, endInclusive, totalSize };
}

/**
 * Fetches one exact byte interval and validates the server's range semantics.
 * `allowEndOfFile` is used only for the bounded header probe.
 */
export async function fetchExactWavByteRange(
  url: string,
  byteStart: number,
  byteEndExclusive: number,
  options: {
    signal?: AbortSignal;
    fetch?: RangeFetch;
    allowEndOfFile?: boolean;
  } = {},
): Promise<FetchedRange> {
  assertSafeInteger(byteStart, "byteStart");
  assertSafeInteger(byteEndExclusive, "byteEndExclusive", 1);
  if (byteEndExclusive <= byteStart) {
    throw new TypeError("The requested byte range must be non-empty.");
  }
  if (options.signal?.aborted) throw abortError();
  const fetcher = options.fetch ?? defaultRangeFetch;
  const response = await fetcher(url, {
    headers: {
      Range: `bytes=${byteStart}-${byteEndExclusive - 1}`,
    },
    cache: "force-cache",
    mode: "cors",
    signal: options.signal,
  });
  if (response.status !== 206) {
    throw new Error(
      response.ok
        ? "The audio host did not honor byte-range streaming (expected HTTP 206)."
        : `Audio range request failed (${response.status} ${response.statusText}).`,
    );
  }

  const exposedContentRange = response.headers.get("Content-Range");
  const contentRange = exposedContentRange
    ? parseContentRange(exposedContentRange)
    : null;
  if (contentRange && contentRange.start !== byteStart) {
    throw new Error(`Audio range started at byte ${contentRange.start}; expected ${byteStart}.`);
  }
  const requestedLength = byteEndExclusive - byteStart;
  const expectedLength = contentRange
    ? contentRange.endInclusive - contentRange.start + 1
    : null;
  if (contentRange) {
    const requestedEndInclusive = byteEndExclusive - 1;
    const expectedEndInclusive = options.allowEndOfFile
      ? Math.min(requestedEndInclusive, contentRange.totalSize - 1)
      : requestedEndInclusive;
    if (contentRange.endInclusive !== expectedEndInclusive) {
      throw new Error(
        `Audio range ended at byte ${contentRange.endInclusive}; `
        + `expected ${expectedEndInclusive}.`,
      );
    }
  }
  const contentLength = response.headers.get("Content-Length");
  const parsedContentLength = contentLength !== null && /^\d+$/.test(contentLength)
    ? Number(contentLength)
    : null;
  if (contentLength !== null && parsedContentLength === null) {
    throw new Error("The audio host returned an invalid Content-Length header.");
  }
  if (expectedLength !== null && parsedContentLength !== null
    && parsedContentLength !== expectedLength) {
    throw new Error("The audio host returned a contradictory Content-Length header.");
  }
  const bytes = await response.arrayBuffer();
  if (
    (expectedLength !== null && bytes.byteLength !== expectedLength)
    || (!options.allowEndOfFile && bytes.byteLength !== requestedLength)
    || (options.allowEndOfFile && (
      bytes.byteLength < 1
      || bytes.byteLength > requestedLength
    ))
    || (parsedContentLength !== null && bytes.byteLength !== parsedContentLength)
  ) {
    throw new Error(
      `Audio range returned an unexpected ${bytes.byteLength} byte response.`,
    );
  }
  return { bytes, totalSize: contentRange?.totalSize ?? null };
}

function fourCc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function guidEquals(
  bytes: Uint8Array,
  offset: number,
  expected: Uint8Array,
): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function popCount(value: number): number {
  let remaining = value >>> 0;
  let count = 0;
  while (remaining) {
    count += remaining & 1;
    remaining >>>= 1;
  }
  return count;
}

type ParsedFmt = Pick<
  WavRangeStemMetadata,
  | "channels"
  | "sampleRate"
  | "encoding"
  | "bitsPerSample"
  | "validBitsPerSample"
  | "blockAlign"
  | "extensible"
>;

function parseFmtChunk(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  chunkSize: number,
): ParsedFmt {
  if (chunkSize < 16) throw new TypeError("The WAV fmt chunk is truncated.");
  const formatTag = view.getUint16(offset, true);
  const channels = view.getUint16(offset + 2, true);
  const sampleRate = view.getUint32(offset + 4, true);
  const byteRate = view.getUint32(offset + 8, true);
  const blockAlign = view.getUint16(offset + 12, true);
  const bitsPerSample = view.getUint16(offset + 14, true);

  if (channels !== 1 && channels !== 2) {
    throw new TypeError(`WAV channel count ${channels} is unsupported; use mono or stereo.`);
  }
  if (sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new TypeError(`WAV sample rate ${sampleRate} is unsupported.`);
  }
  if (bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32) {
    throw new TypeError(`WAV container width ${bitsPerSample} is unsupported.`);
  }

  let effectiveFormat = formatTag;
  let validBitsPerSample = bitsPerSample;
  let extensible = false;
  if (formatTag === EXTENSIBLE_FORMAT) {
    extensible = true;
    if (chunkSize < 40) {
      throw new TypeError("The WAVE_FORMAT_EXTENSIBLE fmt chunk is truncated.");
    }
    const extensionSize = view.getUint16(offset + 16, true);
    if (extensionSize < 22 || 18 + extensionSize > chunkSize) {
      throw new TypeError("The WAVE_FORMAT_EXTENSIBLE extension is invalid.");
    }
    validBitsPerSample = view.getUint16(offset + 18, true);
    const channelMask = view.getUint32(offset + 20, true);
    if (
      validBitsPerSample !== 16
      && validBitsPerSample !== 24
      && validBitsPerSample !== 32
    ) {
      throw new TypeError(
        `WAV valid-bit width ${validBitsPerSample} is unsupported.`,
      );
    }
    if (validBitsPerSample > bitsPerSample) {
      throw new TypeError("WAV valid bits cannot exceed the container width.");
    }
    if (
      channelMask !== 0
      && (
        popCount(channelMask) !== channels
        || (channels === 1 && channelMask !== 0x1 && channelMask !== 0x4)
        || (channels === 2 && channelMask !== 0x3)
      )
    ) {
      throw new TypeError("The WAVE_FORMAT_EXTENSIBLE channel mask is unsupported.");
    }
    const guidOffset = offset + 24;
    if (guidEquals(bytes, guidOffset, PCM_SUBFORMAT_GUID)) {
      effectiveFormat = PCM_FORMAT;
    } else if (guidEquals(bytes, guidOffset, FLOAT_SUBFORMAT_GUID)) {
      effectiveFormat = IEEE_FLOAT_FORMAT;
    } else {
      throw new TypeError("The WAVE_FORMAT_EXTENSIBLE SubFormat is unsupported.");
    }
  }

  if (effectiveFormat !== PCM_FORMAT && effectiveFormat !== IEEE_FLOAT_FORMAT) {
    throw new TypeError(`WAV format code 0x${formatTag.toString(16)} is unsupported.`);
  }
  if (effectiveFormat === IEEE_FLOAT_FORMAT) {
    if (bitsPerSample !== 32 || validBitsPerSample !== 32) {
      throw new TypeError("IEEE-float WAV audio must use 32-bit samples.");
    }
  }

  const bytesPerSample = bitsPerSample / 8;
  const expectedBlockAlign = channels * bytesPerSample;
  if (blockAlign !== expectedBlockAlign) {
    throw new TypeError(
      `WAV block alignment ${blockAlign} does not match ${expectedBlockAlign}.`,
    );
  }
  if (byteRate !== sampleRate * blockAlign) {
    throw new TypeError("WAV byte rate does not match its sample format.");
  }

  const encoding: WavSampleEncoding = effectiveFormat === IEEE_FLOAT_FORMAT
    ? "ieee-f32"
    : bitsPerSample === 16
      ? "pcm-s16"
      : bitsPerSample === 24
        ? "pcm-s24"
        : "pcm-s32";
  return {
    channels: channels as 1 | 2,
    sampleRate,
    encoding,
    bitsPerSample: bitsPerSample as 16 | 24 | 32,
    validBitsPerSample: validBitsPerSample as 16 | 24 | 32,
    blockAlign,
    extensible,
  };
}

/**
 * Parses a bounded RIFF/WAVE header. Only uncompressed PCM integer and
 * IEEE-float samples are accepted; compressed WAV formats are never sent to
 * the PCM decoder.
 */
export function parsePcmWavHeader(
  input: ArrayBuffer | ArrayBufferView,
  url: string,
  exposedSizeBytes?: number | null,
): WavRangeStemMetadata {
  if (exposedSizeBytes !== undefined && exposedSizeBytes !== null) {
    assertSafeInteger(exposedSizeBytes, "WAV file size", 1);
  }
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteLength < 12) throw new TypeError("The WAV header is truncated.");
  if (fourCc(bytes, 0) === "RF64") {
    throw new TypeError("RF64 WAV files are not supported for browser range playback.");
  }
  if (fourCc(bytes, 0) !== "RIFF" || fourCc(bytes, 8) !== "WAVE") {
    throw new TypeError("The source is not a RIFF/WAVE file.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffEnd = view.getUint32(4, true) + 8;
  if (riffEnd < 12 || (exposedSizeBytes != null && riffEnd > exposedSizeBytes)) {
    throw new TypeError("The WAV RIFF size exceeds the source file.");
  }
  const sizeBytes = exposedSizeBytes ?? riffEnd;

  let fmt: ParsedFmt | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength && offset + 8 <= riffEnd) {
    const id = fourCc(bytes, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + chunkSize;
    if (!Number.isSafeInteger(payloadEnd) || payloadEnd > riffEnd) {
      throw new TypeError(`The WAV ${id} chunk exceeds the RIFF container.`);
    }

    if (id === "data") {
      if (!fmt) {
        throw new TypeError("The WAV fmt chunk must appear before the data chunk.");
      }
      if (chunkSize === 0 || chunkSize % fmt.blockAlign !== 0) {
        throw new TypeError("The WAV data chunk is not frame-aligned.");
      }
      if (payloadEnd > sizeBytes) {
        throw new TypeError("The WAV data chunk exceeds the source file.");
      }
      return {
        url,
        sizeBytes,
        ...fmt,
        durationFrames: chunkSize / fmt.blockAlign,
        dataByteStart: payloadStart,
        dataByteEndExclusive: payloadEnd,
      };
    }

    if (payloadEnd > bytes.byteLength) {
      throw new TypeError(
        "The WAV fmt/data header lies beyond the bounded header-read limit.",
      );
    }
    if (id === "fmt ") {
      if (fmt) throw new TypeError("The WAV file contains multiple fmt chunks.");
      fmt = parseFmtChunk(bytes, view, payloadStart, chunkSize);
    }
    offset = payloadEnd + (chunkSize & 1);
  }
  throw new TypeError(
    "The WAV fmt/data header was not found within the bounded header-read limit.",
  );
}

async function probeOneWav(
  id: AudioStemId,
  url: string,
  options: Required<Pick<ProbeWavRangeDeckOptions, "maxHeaderBytes">>
    & Pick<ProbeWavRangeDeckOptions, "fetch" | "signal">,
): Promise<[AudioStemId, WavRangeStemMetadata]> {
  const range = await fetchExactWavByteRange(
    url,
    0,
    options.maxHeaderBytes,
    {
      allowEndOfFile: true,
      fetch: options.fetch,
      signal: options.signal,
    },
  );
  if (range.bytes.byteLength > options.maxHeaderBytes) {
    throw new Error("The WAV header response exceeded the configured byte limit.");
  }
  return [id, parsePcmWavHeader(range.bytes, url, range.totalSize)];
}

/**
 * Probes the selected original WAV URLs and builds a synchronized range deck.
 * No complete stem is downloaded or decoded.
 */
export async function probeWavRangeStreamingDeck(
  sources: StemSources,
  options: ProbeWavRangeDeckOptions = {},
): Promise<WavRangeProbeResult> {
  if (options.signal?.aborted) throw abortError();
  const unknownId = Object.keys(sources).find(
    (id) => !(AUDIO_STEM_IDS as readonly string[]).includes(id),
  );
  if (unknownId) throw new TypeError(`Unsupported stem id "${unknownId}".`);
  const entries = AUDIO_STEM_IDS.flatMap((id) => {
    const value = sources[id];
    return typeof value === "string" && value.trim()
      ? [[id, value.trim()] as const]
      : [];
  });
  if (entries.length === 0) {
    throw new TypeError("At least one WAV stem URL is required.");
  }

  const maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  assertSafeInteger(maxHeaderBytes, "maxHeaderBytes", 44);
  if (maxHeaderBytes > ABSOLUTE_MAX_HEADER_BYTES) {
    throw new TypeError(
      `maxHeaderBytes cannot exceed ${ABSOLUTE_MAX_HEADER_BYTES}.`,
    );
  }
  const windowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  if (!Number.isFinite(windowSeconds) || windowSeconds < 0.25 || windowSeconds > 10) {
    throw new TypeError("windowSeconds must be between 0.25 and 10.");
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  let probed: [AudioStemId, WavRangeStemMetadata][];
  try {
    probed = await Promise.all(entries.map(([id, url]) => (
      probeOneWav(id, url, {
        maxHeaderBytes,
        fetch: options.fetch,
        signal: controller.signal,
      })
    )));
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
  }

  const reference = probed[0][1];
  for (const [id, metadata] of probed.slice(1)) {
    if (metadata.sampleRate !== reference.sampleRate) {
      throw new TypeError(
        `${id} uses ${metadata.sampleRate} Hz; every streamed stem must use `
        + `${reference.sampleRate} Hz.`,
      );
    }
  }
  // Music.ai stems can differ by a handful of tail samples. They still share
  // one exact frame clock from zero, so stream only their common safe duration
  // instead of rejecting the deck and falling back to full-file decoding.
  const commonDurationFrames = Math.min(
    ...probed.map(([, metadata]) => metadata.durationFrames),
  );

  const windowFrames = Math.max(
    1,
    Math.floor(reference.sampleRate * windowSeconds),
  );
  const commonWindows: Array<Pick<StemPreviewWindow, "startFrame" | "frameCount">> = [];
  for (
    let startFrame = 0;
    startFrame < commonDurationFrames;
    startFrame += windowFrames
  ) {
    commonWindows.push({
      startFrame,
      frameCount: Math.min(windowFrames, commonDurationFrames - startFrame),
    });
  }

  const metadata: WavRangeStemMetadataMap = {};
  const stems: Partial<Record<AudioStemId, StemPreviewSource>> = {};
  for (const [id, item] of probed) {
    metadata[id] = { ...item };
    stems[id] = {
      url: item.url,
      channels: item.channels,
      sizeBytes: item.sizeBytes,
      windows: commonWindows.map(({ startFrame, frameCount }) => {
        const byteStart = item.dataByteStart + startFrame * item.blockAlign;
        const byteEndExclusive = byteStart + frameCount * item.blockAlign;
        return {
          startFrame,
          frameCount,
          prerollByteStart: byteStart,
          byteStart,
          byteEndExclusive,
        };
      }),
    };
  }

  const deck: WavRangeStreamingDeck = {
    version: STEM_WAV_RANGE_DECK_VERSION,
    codec: STEM_WAV_RANGE_CODEC,
    bitstream: STEM_WAV_RANGE_BITSTREAM,
    sampleRate: reference.sampleRate,
    packetFrames: 1,
    durationFrames: commonDurationFrames,
    stems,
  };
  return { deck, metadata };
}

function metadataForRequest(
  metadata: WavRangeStemMetadataMap,
  request: PreviewDecodeRequest,
): WavRangeStemMetadata {
  if (
    request.codec !== STEM_WAV_RANGE_CODEC
    || request.bitstream !== STEM_WAV_RANGE_BITSTREAM
  ) {
    throw new StreamingAudioUnsupportedError(
      "The WAV range decoder only accepts PCM-WAV range decks.",
    );
  }
  const item = metadata[request.stemId];
  if (!item) throw new Error(`No WAV metadata is registered for ${request.stemId}.`);
  if (
    item.url !== request.source.url
    || item.sizeBytes !== request.source.sizeBytes
    || item.channels !== request.source.channels
    || item.sampleRate !== request.sampleRate
  ) {
    throw new Error(`The ${request.stemId} WAV source changed after it was probed.`);
  }
  const expectedStart = item.dataByteStart
    + request.window.startFrame * item.blockAlign;
  const expectedEnd = expectedStart + request.window.frameCount * item.blockAlign;
  if (
    request.window.prerollByteStart !== expectedStart
    || request.window.byteStart !== expectedStart
    || request.window.byteEndExclusive !== expectedEnd
    || expectedEnd > item.dataByteEndExclusive
  ) {
    throw new Error(`The ${request.stemId} WAV window is not frame-aligned.`);
  }
  return item;
}

function readSigned24(view: DataView, offset: number): number {
  const unsigned = (
    view.getUint8(offset)
    | (view.getUint8(offset + 1) << 8)
    | (view.getUint8(offset + 2) << 16)
  );
  return (unsigned & 0x800000) ? unsigned | 0xff000000 : unsigned;
}

/**
 * Converts one validated interleaved PCM range to planar Float32 samples.
 */
export function decodePcmWavRange(
  input: ArrayBuffer | ArrayBufferView,
  metadata: WavRangeStemMetadata,
  frameCount: number,
): Float32Array<ArrayBuffer>[] {
  assertSafeInteger(frameCount, "frameCount", 1);
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const expectedBytes = frameCount * metadata.blockAlign;
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(
      `WAV range contains ${bytes.byteLength} bytes; expected ${expectedBytes}.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = Array.from(
    { length: metadata.channels },
    () => new Float32Array(frameCount),
  );
  const bytesPerSample = metadata.bitsPerSample / 8;
  const paddingBits = metadata.bitsPerSample - metadata.validBitsPerSample;
  const integerScale = 2 ** (metadata.validBitsPerSample - 1);
  let offset = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < metadata.channels; channel += 1) {
      let sample: number;
      if (metadata.encoding === "ieee-f32") {
        sample = view.getFloat32(offset, true);
        if (!Number.isFinite(sample)) {
          throw new TypeError("The IEEE-float WAV range contains a non-finite sample.");
        }
      } else {
        const containerValue = metadata.bitsPerSample === 16
          ? view.getInt16(offset, true)
          : metadata.bitsPerSample === 24
            ? readSigned24(view, offset)
            : view.getInt32(offset, true);
        const validValue = paddingBits === 0
          ? containerValue
          : containerValue >> paddingBits;
        sample = validValue / integerScale;
      }
      channels[channel][frame] = sample;
      offset += bytesPerSample;
    }
  }
  return channels;
}

type ActiveInlineDecode = {
  generation: number;
  controller: AbortController;
};

export type FetchWavRangeWindowDecoderOptions = {
  fetch?: RangeFetch;
};

/**
 * Injectable decoder useful for deterministic tests and environments without
 * workers. Production UI code should prefer WorkerWavRangeWindowDecoder.
 */
export class FetchWavRangeWindowDecoder implements PreviewWindowDecoder {
  private readonly metadata: WavRangeStemMetadataMap;

  private readonly fetcher: RangeFetch;

  private readonly active = new Set<ActiveInlineDecode>();

  private disposed = false;

  constructor(
    metadata: WavRangeStemMetadataMap,
    options: FetchWavRangeWindowDecoderOptions = {},
  ) {
    this.metadata = metadata;
    this.fetcher = options.fetch ?? defaultRangeFetch;
  }

  async decode(
    request: PreviewDecodeRequest,
    signal?: AbortSignal,
  ): Promise<DecodedPreviewWindow> {
    if (this.disposed) throw new Error("WAV range decoder is disposed.");
    if (signal?.aborted) throw abortError();
    const item = metadataForRequest(this.metadata, request);
    const active = {
      generation: request.generation,
      controller: new AbortController(),
    };
    const forwardAbort = () => active.controller.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    this.active.add(active);
    try {
      const fetched = await fetchExactWavByteRange(
        item.url,
        request.window.byteStart,
        request.window.byteEndExclusive,
        {
          fetch: this.fetcher,
          signal: active.controller.signal,
        },
      );
      if (fetched.totalSize !== null && fetched.totalSize !== item.sizeBytes) {
        throw new Error(`The ${request.stemId} WAV size changed after it was probed.`);
      }
      return {
        stemId: request.stemId,
        startFrame: request.window.startFrame,
        frameCount: request.window.frameCount,
        sampleRate: request.sampleRate,
        channels: decodePcmWavRange(
          fetched.bytes,
          item,
          request.window.frameCount,
        ),
      };
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
      this.active.delete(active);
    }
  }

  cancelGeneration(generation: number): void {
    for (const active of this.active) {
      if (active.generation === generation) active.controller.abort();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const active of this.active) active.controller.abort();
    this.active.clear();
  }
}

type WorkerDecodeRequest = {
  type: "decode";
  requestId: number;
  request: PreviewDecodeRequest;
  metadata: WavRangeStemMetadata;
};

type WorkerControlRequest =
  | { type: "cancel-request"; requestId: number }
  | { type: "cancel-generation"; generation: number };

export type WavRangeWorkerIncomingMessage =
  | WorkerDecodeRequest
  | WorkerControlRequest;

export type WavRangeWorkerOutboundMessage =
  | {
    type: "decoded";
    requestId: number;
    generation: number;
    stemId: AudioStemId;
    startFrame: number;
    frameCount: number;
    sampleRate: number;
    channels: ArrayBuffer[];
  }
  | {
    type: "error";
    requestId: number;
    generation: number;
    name: string;
    message: string;
  };

type PendingWorkerDecode = {
  generation: number;
  resolve: (value: DecodedPreviewWindow) => void;
  reject: (reason: unknown) => void;
  removeAbortListener: () => void;
};

export type WorkerWavRangeWindowDecoderOptions = {
  workerFactory?: () => Worker;
};

/** Range-fetches and converts WAV windows away from the browser UI thread. */
export class WorkerWavRangeWindowDecoder implements PreviewWindowDecoder {
  private readonly metadata: WavRangeStemMetadataMap;

  private readonly worker: Worker;

  private requestId = 0;

  private readonly pending = new Map<number, PendingWorkerDecode>();

  private disposed = false;

  constructor(
    metadata: WavRangeStemMetadataMap,
    options: WorkerWavRangeWindowDecoderOptions = {},
  ) {
    if (typeof Worker === "undefined") {
      throw new StreamingAudioUnsupportedError("Web Workers are unavailable.");
    }
    this.metadata = metadata;
    this.worker = options.workerFactory?.() ?? new Worker(
      new URL("./wavRangeDecode.worker.ts", import.meta.url),
      { type: "module", name: "wav-range-decoder" },
    );
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleWorkerError);
  }

  decode(
    request: PreviewDecodeRequest,
    signal?: AbortSignal,
  ): Promise<DecodedPreviewWindow> {
    if (this.disposed) return Promise.reject(new Error("WAV range decoder is disposed."));
    if (signal?.aborted) return Promise.reject(abortError());
    const metadata = metadataForRequest(this.metadata, request);
    const requestId = ++this.requestId;
    return new Promise<DecodedPreviewWindow>((resolve, reject) => {
      const abort = () => {
        if (!this.pending.delete(requestId)) return;
        this.worker.postMessage({ type: "cancel-request", requestId });
        reject(abortError());
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(requestId, {
        generation: request.generation,
        resolve,
        reject,
        removeAbortListener: () => signal?.removeEventListener("abort", abort),
      });
      const message: WorkerDecodeRequest = {
        type: "decode",
        requestId,
        request,
        metadata,
      };
      this.worker.postMessage(message);
    });
  }

  cancelGeneration(generation: number): void {
    if (this.disposed) return;
    this.worker.postMessage({ type: "cancel-generation", generation });
    for (const [requestId, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      this.pending.delete(requestId);
      pending.removeAbortListener();
      pending.reject(abortError());
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleWorkerError);
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      pending.removeAbortListener();
      pending.reject(abortError());
    }
    this.pending.clear();
  }

  private readonly handleMessage = (
    event: MessageEvent<WavRangeWorkerOutboundMessage>,
  ) => {
    const message = event.data;
    if (!message || (message.type !== "decoded" && message.type !== "error")) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    pending.removeAbortListener();
    if (message.type === "error") {
      const error = message.name === "AbortError"
        ? abortError()
        : message.name === "StreamingAudioUnsupportedError"
          ? new StreamingAudioUnsupportedError(message.message)
          : new Error(message.message);
      if (error.name !== message.name) {
        Object.defineProperty(error, "name", { value: message.name });
      }
      pending.reject(error);
      return;
    }
    pending.resolve({
      stemId: message.stemId,
      startFrame: message.startFrame,
      frameCount: message.frameCount,
      sampleRate: message.sampleRate,
      channels: message.channels.map((buffer) => new Float32Array(buffer)),
    });
  };

  private readonly handleWorkerError = () => {
    const error = new Error("The WAV range worker stopped unexpectedly.");
    for (const pending of this.pending.values()) {
      pending.removeAbortListener();
      pending.reject(error);
    }
    this.pending.clear();
  };
}

/**
 * Narrowing helper for callers that can receive either preview deck type.
 */
export function isWavRangeStreamingDeck(
  deck: StreamingStemDeck,
): deck is WavRangeStreamingDeck {
  return (
    deck.codec === STEM_WAV_RANGE_CODEC
    && deck.bitstream === STEM_WAV_RANGE_BITSTREAM
  );
}
