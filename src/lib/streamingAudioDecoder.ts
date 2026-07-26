import type { AudioStemId } from "./stems.ts";
import type {
  StreamingStemDeck,
  StemPreviewSource,
  StemPreviewWindow,
} from "./stemPreviewManifest.ts";

export class StreamingAudioUnsupportedError extends Error {
  constructor(message = "Streamed stem playback is not supported by this browser.") {
    super(message);
    this.name = "StreamingAudioUnsupportedError";
  }
}

export type PreviewDecodeRequest = {
  generation: number;
  stemId: AudioStemId;
  source: StemPreviewSource;
  window: StemPreviewWindow;
  codec: StreamingStemDeck["codec"];
  bitstream: StreamingStemDeck["bitstream"];
  sampleRate: number;
  packetFrames: number;
};

export type DecodedPreviewWindow = {
  stemId: AudioStemId;
  startFrame: number;
  frameCount: number;
  sampleRate: number;
  channels: Float32Array<ArrayBuffer>[];
};

/**
 * Injectable seam used by StreamingStemTransport. Production work is
 * performed in a module worker; tests can supply deterministic PCM windows.
 */
export interface PreviewWindowDecoder {
  decode(
    request: PreviewDecodeRequest,
    signal?: AbortSignal,
  ): Promise<DecodedPreviewWindow>;
  cancelGeneration(generation: number): void;
  dispose(): void;
}

type DecodeWorkerRequest = Omit<PreviewDecodeRequest, "source" | "window"> & {
  type: "decode";
  requestId: number;
  source: {
    url: string;
    channels: number;
    sizeBytes: number;
  };
  window: StemPreviewWindow;
};

type WorkerOutboundMessage =
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

type PendingRequest = {
  generation: number;
  resolve: (value: DecodedPreviewWindow) => void;
  reject: (reason: unknown) => void;
  removeAbortListener: () => void;
};

function abortError(): DOMException {
  return new DOMException("The preview decode was cancelled.", "AbortError");
}

export type WorkerPreviewWindowDecoderOptions = {
  workerFactory?: () => Worker;
};

/**
 * Range-fetches and decodes AAC windows away from the UI thread.
 */
export class WorkerPreviewWindowDecoder implements PreviewWindowDecoder {
  private readonly worker: Worker;

  private requestId = 0;

  private pending = new Map<number, PendingRequest>();

  private disposed = false;

  constructor(options: WorkerPreviewWindowDecoderOptions = {}) {
    if (typeof Worker === "undefined") {
      throw new StreamingAudioUnsupportedError("Web Workers are unavailable.");
    }
    this.worker = options.workerFactory?.() ?? new Worker(
      new URL("./streamingAudioDecode.worker.ts", import.meta.url),
      { type: "module", name: "stem-preview-decoder" },
    );
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleWorkerError);
  }

  decode(
    request: PreviewDecodeRequest,
    signal?: AbortSignal,
  ): Promise<DecodedPreviewWindow> {
    if (this.disposed) return Promise.reject(new Error("Preview decoder is disposed."));
    if (signal?.aborted) return Promise.reject(abortError());
    if (request.codec !== "mp4a.40.2" || request.bitstream !== "adts") {
      return Promise.reject(
        new StreamingAudioUnsupportedError(
          "The AAC preview decoder cannot decode this streaming deck.",
        ),
      );
    }
    const requestId = ++this.requestId;
    const message: DecodeWorkerRequest = {
      type: "decode",
      requestId,
      generation: request.generation,
      stemId: request.stemId,
      source: {
        url: request.source.url,
        channels: request.source.channels,
        sizeBytes: request.source.sizeBytes,
      },
      window: request.window,
      codec: request.codec,
      bitstream: request.bitstream,
      sampleRate: request.sampleRate,
      packetFrames: request.packetFrames,
    };

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

  private readonly handleMessage = (event: MessageEvent<WorkerOutboundMessage>) => {
    const message = event.data;
    if (!message || (message.type !== "decoded" && message.type !== "error")) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    pending.removeAbortListener();

    if (message.type === "error") {
      const error = message.name === "StreamingAudioUnsupportedError"
        ? new StreamingAudioUnsupportedError(message.message)
        : message.name === "AbortError"
          ? abortError()
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
    const error = new Error("The preview decoding worker stopped unexpectedly.");
    for (const pending of this.pending.values()) {
      pending.removeAbortListener();
      pending.reject(error);
    }
    this.pending.clear();
  };
}
