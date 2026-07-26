/// <reference lib="webworker" />

import {
  decodePcmWavRange,
  fetchExactWavByteRange,
  type WavRangeWorkerIncomingMessage,
  type WavRangeWorkerOutboundMessage,
} from "./wavRangeStreaming.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

const controllers = new Map<number, {
  generation: number;
  controller: AbortController;
}>();

function postError(
  requestId: number,
  generation: number,
  error: unknown,
): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const message: WavRangeWorkerOutboundMessage = {
    type: "error",
    requestId,
    generation,
    name: normalized.name,
    message: normalized.message,
  };
  workerScope.postMessage(message);
}

workerScope.addEventListener(
  "message",
  (event: MessageEvent<WavRangeWorkerIncomingMessage>) => {
    const message = event.data;
    if (message.type === "cancel-request") {
      controllers.get(message.requestId)?.controller.abort();
      controllers.delete(message.requestId);
      return;
    }
    if (message.type === "cancel-generation") {
      for (const [requestId, active] of controllers) {
        if (active.generation !== message.generation) continue;
        active.controller.abort();
        controllers.delete(requestId);
      }
      return;
    }

    const active = {
      generation: message.request.generation,
      controller: new AbortController(),
    };
    controllers.set(message.requestId, active);
    void fetchExactWavByteRange(
      message.metadata.url,
      message.request.window.byteStart,
      message.request.window.byteEndExclusive,
      {
        signal: active.controller.signal,
        fetch: (input, init) => globalThis.fetch(input, init),
      },
    ).then((fetched) => {
      if (
        fetched.totalSize !== null
        && fetched.totalSize !== message.metadata.sizeBytes
      ) {
        throw new Error(
          `The ${message.request.stemId} WAV size changed after it was probed.`,
        );
      }
      const channels = decodePcmWavRange(
        fetched.bytes,
        message.metadata,
        message.request.window.frameCount,
      );
      const buffers = channels.map((channel) => channel.buffer);
      const result: WavRangeWorkerOutboundMessage = {
        type: "decoded",
        requestId: message.requestId,
        generation: message.request.generation,
        stemId: message.request.stemId,
        startFrame: message.request.window.startFrame,
        frameCount: message.request.window.frameCount,
        sampleRate: message.request.sampleRate,
        channels: buffers,
      };
      workerScope.postMessage(result, buffers);
    }).catch((error) => {
      postError(message.requestId, message.request.generation, error);
    }).finally(() => {
      const current = controllers.get(message.requestId);
      if (current === active) controllers.delete(message.requestId);
    });
  },
);
