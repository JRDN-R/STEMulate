/// <reference lib="webworker" />

import { parseAdtsFrames } from "./adts.ts";
import type { AudioStemId } from "./stems.ts";
import type { StemPreviewWindow } from "./stemPreviewManifest.ts";

type DecodeMessage = {
  type: "decode";
  requestId: number;
  generation: number;
  stemId: AudioStemId;
  source: {
    url: string;
    channels: number;
    sizeBytes: number;
  };
  window: StemPreviewWindow;
  codec: string;
  bitstream: "adts";
  sampleRate: number;
  packetFrames: number;
};

type ControlMessage =
  | { type: "cancel-request"; requestId: number }
  | { type: "cancel-generation"; generation: number };

type IncomingMessage = DecodeMessage | ControlMessage;

type AudioDataLike = {
  numberOfFrames: number;
  numberOfChannels: number;
  sampleRate: number;
  allocationSize(options: { planeIndex: number; format: "f32-planar" }): number;
  copyTo(
    destination: AllowSharedBufferSource,
    options: { planeIndex: number; format: "f32-planar" },
  ): void;
  close(): void;
};

type AudioDecoderLike = {
  configure(config: {
    codec: string;
    sampleRate: number;
    numberOfChannels: number;
  }): void;
  decode(chunk: unknown): void;
  flush(): Promise<void>;
  close(): void;
};

type AudioDecoderConstructor = {
  new (init: {
    output: (data: AudioDataLike) => void;
    error: (error: DOMException) => void;
  }): AudioDecoderLike;
  isConfigSupported(config: {
    codec: string;
    sampleRate: number;
    numberOfChannels: number;
  }): Promise<{ supported?: boolean }>;
};

type EncodedAudioChunkConstructor = new (init: {
  type: "key";
  timestamp: number;
  duration: number;
  data: AllowSharedBufferSource;
}) => unknown;

const workerScope = self as unknown as DedicatedWorkerGlobalScope & {
  AudioDecoder?: AudioDecoderConstructor;
  EncodedAudioChunk?: EncodedAudioChunkConstructor;
};

const controllers = new Map<number, {
  generation: number;
  controller: AbortController;
  decoder: AudioDecoderLike | null;
}>();

function unsupported(message: string): Error {
  const error = new Error(message);
  error.name = "StreamingAudioUnsupportedError";
  return error;
}

function postError(message: DecodeMessage, error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  workerScope.postMessage({
    type: "error",
    requestId: message.requestId,
    generation: message.generation,
    name: normalized.name,
    message: normalized.message,
  });
}

async function fetchByteWindow(
  message: DecodeMessage,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const { prerollByteStart, byteEndExclusive } = message.window;
  const response = await globalThis.fetch(message.source.url, {
    headers: { Range: `bytes=${prerollByteStart}-${byteEndExclusive - 1}` },
    cache: "force-cache",
    mode: "cors",
    signal,
  });
  if (response.status !== 206) {
    throw new Error(
      response.ok
        ? "The preview host did not honor byte-range streaming."
        : `Preview range request failed (${response.status} ${response.statusText}).`,
    );
  }
  const bytes = await response.arrayBuffer();
  const expected = byteEndExclusive - prerollByteStart;
  if (bytes.byteLength !== expected) {
    throw new Error(`Preview range returned ${bytes.byteLength} bytes; expected ${expected}.`);
  }
  return bytes;
}

async function decode(message: DecodeMessage): Promise<void> {
  const AudioDecoderClass = workerScope.AudioDecoder;
  const EncodedAudioChunkClass = workerScope.EncodedAudioChunk;
  if (!AudioDecoderClass || !EncodedAudioChunkClass) {
    throw unsupported("Safari 26 or another browser with WebCodecs AudioDecoder is required.");
  }
  if (message.bitstream !== "adts") {
    throw unsupported(`Unsupported preview bitstream ${message.bitstream}.`);
  }

  const config = {
    codec: message.codec,
    sampleRate: message.sampleRate,
    numberOfChannels: message.source.channels,
  };
  const support = await AudioDecoderClass.isConfigSupported(config);
  if (!support.supported) {
    throw unsupported(`This browser cannot decode ${message.codec} preview audio.`);
  }

  const active = controllers.get(message.requestId);
  if (!active || active.controller.signal.aborted) {
    throw new DOMException("Cancelled", "AbortError");
  }
  const encoded = await fetchByteWindow(message, active.controller.signal);
  const frames = parseAdtsFrames(encoded, {
    baseOffset: message.window.prerollByteStart,
  });
  if (
    frames.some((frame) => (
      frame.sampleRate !== message.sampleRate
      || frame.channels !== message.source.channels
      || frame.sampleCount !== message.packetFrames
    ))
    || frames.reduce((total, frame) => total + frame.sampleCount, 0)
      !== message.window.frameCount + message.packetFrames
  ) {
    throw new Error("Preview ADTS headers do not match the manifest.");
  }

  const output: Float32Array[][] = [];
  let decoderError: DOMException | null = null;
  let outputError: Error | null = null;
  const decoder = new AudioDecoderClass({
    output: (audioData) => {
      try {
        if (
          audioData.sampleRate !== message.sampleRate
          || audioData.numberOfChannels !== message.source.channels
        ) {
          throw new Error("Decoded preview format changed unexpectedly.");
        }
        const planes: Float32Array[] = [];
        for (let channel = 0; channel < audioData.numberOfChannels; channel += 1) {
          const allocation = audioData.allocationSize({
            planeIndex: channel,
            format: "f32-planar",
          });
          const plane = new Float32Array(allocation / Float32Array.BYTES_PER_ELEMENT);
          audioData.copyTo(plane, {
            planeIndex: channel,
            format: "f32-planar",
          });
          planes.push(plane.subarray(0, audioData.numberOfFrames));
        }
        output.push(planes);
      } catch (error) {
        outputError = error instanceof Error ? error : new Error(String(error));
      } finally {
        audioData.close();
      }
    },
    error: (error) => {
      decoderError = error;
    },
  });
  active.decoder = decoder;
  decoder.configure(config);

  // Every range begins with one prior packet. It primes AAC's MDCT overlap
  // state (and, for window zero, consumes FFmpeg's encoder-delay packet).
  let timestampFrames = 0;
  for (const frame of frames) {
    if (active.controller.signal.aborted) {
      throw new DOMException("Cancelled", "AbortError");
    }
    decoder.decode(new EncodedAudioChunkClass({
      type: "key",
      timestamp: Math.round((timestampFrames * 1_000_000) / message.sampleRate),
      duration: Math.round((frame.sampleCount * 1_000_000) / message.sampleRate),
      data: frame.data,
    }));
    timestampFrames += frame.sampleCount;
  }
  await decoder.flush();
  if (decoderError) throw decoderError;
  if (outputError) throw outputError;
  if (active.controller.signal.aborted) {
    throw new DOMException("Cancelled", "AbortError");
  }

  const decodedFrames = output.reduce(
    (total, chunk) => total + (chunk[0]?.length ?? 0),
    0,
  );
  const requiredDecodedFrames = message.window.frameCount + message.packetFrames;
  if (decodedFrames < requiredDecodedFrames) {
    throw new Error(
      `Preview decoder produced ${decodedFrames} frames; expected ${requiredDecodedFrames}.`,
    );
  }
  const channelBuffers: ArrayBuffer[] = [];
  for (let channel = 0; channel < message.source.channels; channel += 1) {
    const plane = new Float32Array(message.window.frameCount);
    let writeOffset = 0;
    let skipFrames = message.packetFrames;
    for (const chunk of output) {
      const source = chunk[channel];
      if (!source || writeOffset >= plane.length) break;
      const sourceOffset = Math.min(skipFrames, source.length);
      skipFrames -= sourceOffset;
      if (sourceOffset >= source.length) continue;
      const count = Math.min(
        source.length - sourceOffset,
        plane.length - writeOffset,
      );
      plane.set(source.subarray(sourceOffset, sourceOffset + count), writeOffset);
      writeOffset += count;
    }
    if (skipFrames !== 0 || writeOffset !== plane.length) {
      throw new Error("Preview decoder could not trim the AAC preroll packet.");
    }
    channelBuffers.push(plane.buffer);
  }
  workerScope.postMessage({
    type: "decoded",
    requestId: message.requestId,
    generation: message.generation,
    stemId: message.stemId,
    startFrame: message.window.startFrame,
    frameCount: message.window.frameCount,
    sampleRate: message.sampleRate,
    channels: channelBuffers,
  }, channelBuffers);
}

workerScope.addEventListener("message", (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;
  if (message.type === "cancel-request") {
    const active = controllers.get(message.requestId);
    active?.controller.abort();
    active?.decoder?.close();
    controllers.delete(message.requestId);
    return;
  }
  if (message.type === "cancel-generation") {
    for (const [requestId, active] of controllers) {
      if (active.generation !== message.generation) continue;
      active.controller.abort();
      active.decoder?.close();
      controllers.delete(requestId);
    }
    return;
  }

  const active = {
    generation: message.generation,
    controller: new AbortController(),
    decoder: null,
  };
  controllers.set(message.requestId, active);
  void decode(message).catch((error) => postError(message, error)).finally(() => {
    const current = controllers.get(message.requestId);
    if (current === active) {
      current.decoder?.close();
      controllers.delete(message.requestId);
    }
  });
});
