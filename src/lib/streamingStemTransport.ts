import {
  createPanController,
  resolveStemMix,
} from "./audioMixer.ts";
import {
  AUDIO_STEM_IDS,
  type AudioStemId,
  type StemState,
} from "./stems.ts";
import {
  previewDurationSeconds,
  validateStreamingStemDeck,
  type StemPreviewWindow,
  type StreamingStemDeck,
} from "./stemPreviewManifest.ts";
import {
  WorkerPreviewWindowDecoder,
  type PreviewWindowDecoder,
} from "./streamingAudioDecoder.ts";

const DEFAULT_PREBUFFER_SECONDS = 8;
const DEFAULT_SCHEDULE_HORIZON_SECONDS = 10;
const DEFAULT_SCHEDULE_AHEAD_SECONDS = 0.025;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 200;
const DEFAULT_MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MIN_LOOP_SECONDS = 0.01;
const CLOCK_EPSILON_SECONDS = 1 / 48_000;

export type StreamingStemTransportStatus =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "buffering"
  | "ended"
  | "error"
  | "disposed";

export type StreamingStemLoop = {
  enabled: boolean;
  start: number;
  end: number;
};

export type StreamingLoadProgress = {
  phase: "validating" | "buffering" | "ready";
  windowsReady: number;
  totalWindows: number;
  bufferedThrough: number;
};

export type StreamingBufferedRange = {
  start: number;
  end: number;
};

export type StreamingStemLoadResult = {
  duration: number;
  loadedStemIds: AudioStemId[];
};

export type StreamingStemTransportSnapshot = StreamingStemLoadResult & {
  status: StreamingStemTransportStatus;
  currentTime: number;
  playbackRate: number;
  loop: StreamingStemLoop;
  loadProgress: StreamingLoadProgress | null;
  buffered: StreamingBufferedRange[];
  decodedBytes: number;
  maxDecodedBytes: number;
  error: Error | null;
  contextState: AudioContextState | "interrupted" | "uninitialized";
};

export type StreamingStemLoadOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: StreamingLoadProgress) => void;
};

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export type StreamingStemTransportOptions = {
  context?: AudioContext;
  contextFactory?: () => AudioContext;
  decoder?: PreviewWindowDecoder;
  decoderFactory?: () => PreviewWindowDecoder;
  prebufferSeconds?: number;
  scheduleHorizonSeconds?: number;
  scheduleAheadSeconds?: number;
  maintenanceIntervalMs?: number;
  maxDecodedBytes?: number;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

type PanController = ReturnType<typeof createPanController>;

type ChannelNodes = {
  gain: GainNode;
  pan: PanController;
};

type CachedWindow = {
  index: number;
  startFrame: number;
  frameCount: number;
  buffers: Map<AudioStemId, AudioBuffer>;
  bytes: number;
  lastUsed: number;
  scheduledReferences: number;
};

type ScheduledSource = {
  source: AudioBufferSourceNode;
  generation: number;
  windowIndex: number;
};

type SnapshotListener = (snapshot: StreamingStemTransportSnapshot) => void;
type EndedListener = () => void;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function abortError(reason?: unknown): DOMException {
  if (reason instanceof DOMException && reason.name === "AbortError") return reason;
  return new DOMException("The streaming stem operation was cancelled.", "AbortError");
}

function defaultContextFactory(): AudioContext {
  const scope = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };
  const Context = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Context) throw new Error("Web Audio is not supported by this browser.");
  try {
    return new Context({ latencyHint: "interactive" });
  } catch {
    return new Context();
  }
}

function normalizeLoop(
  loop: StreamingStemLoop,
  duration: number,
): StreamingStemLoop {
  const start = clamp(finiteOr(loop.start, 0), 0, duration);
  const end = clamp(finiteOr(loop.end, start), start, duration);
  return {
    enabled: Boolean(loop.enabled) && end - start >= MIN_LOOP_SECONDS,
    start,
    end,
  };
}

function positionInsideLoop(
  position: number,
  loop: StreamingStemLoop,
): number {
  if (!loop.enabled || position < loop.end) return position;
  const length = loop.end - loop.start;
  return loop.start + ((((position - loop.start) % length) + length) % length);
}

function setParam(
  parameter: AudioParam,
  value: number,
  context: BaseAudioContext,
): void {
  parameter.cancelScheduledValues(context.currentTime);
  if (typeof parameter.setTargetAtTime === "function") {
    parameter.setTargetAtTime(value, context.currentTime, 0.008);
  } else {
    parameter.setValueAtTime(value, context.currentTime);
  }
}

/**
 * Bounded-memory, shared-clock playback for compressed stem preview windows.
 *
 * A window is admitted to the common cache only after every stem has decoded.
 * Every source for a segment is then started at the same AudioContext time.
 * A late or failed stem therefore buffers the entire deck instead of allowing
 * individual tracks to drift or advance independently.
 */
export class StreamingStemTransport {
  private context: AudioContext | null;

  private readonly ownsContext: boolean;

  private readonly contextFactory: () => AudioContext;

  private decoder: PreviewWindowDecoder | null;

  private readonly ownsDecoder: boolean;

  private readonly decoderFactory: () => PreviewWindowDecoder;

  private readonly prebufferSeconds: number;

  private readonly scheduleHorizonSeconds: number;

  private readonly scheduleAheadSeconds: number;

  private readonly maintenanceIntervalMs: number;

  private readonly maxDecodedBytes: number;

  private readonly setTimer: (callback: () => void, delay: number) => TimerHandle;

  private readonly clearTimer: (handle: TimerHandle) => void;

  private timer: TimerHandle | null = null;

  private masterGain: GainNode | null = null;

  private masterLimiter: DynamicsCompressorNode | null = null;

  private manifest: StreamingStemDeck | null = null;

  private windows: StemPreviewWindow[] = [];

  private loadedStemIds: AudioStemId[] = [];

  private channels = new Map<AudioStemId, ChannelNodes>();

  private cache = new Map<number, CachedWindow>();

  private decodedBytesValue = 0;

  private cacheAccess = 0;

  private pendingWindows = new Map<number, Promise<CachedWindow>>();

  private decodeController: AbortController | null = null;

  private decodeGeneration = 0;

  private sourceGeneration = 0;

  private liveSources = new Set<ScheduledSource>();

  private anchorPosition = 0;

  private anchorContextTime = 0;

  private scheduleCursorPosition = 0;

  private scheduleCursorContextTime = 0;

  private playbackRateValue = 1;

  private loopValue: StreamingStemLoop = { enabled: false, start: 0, end: 0 };

  private durationSeconds = 0;

  private playIntent = false;

  private reachedTerminalCursor = false;

  private statusValue: StreamingStemTransportStatus = "idle";

  private progressValue: StreamingLoadProgress | null = null;

  private errorValue: Error | null = null;

  private latestMix: readonly StemState[] | null = null;

  private listeners = new Set<SnapshotListener>();

  private endedListeners = new Set<EndedListener>();

  private disposed = false;

  private readonly handleContextStateChange = () => this.emit();

  constructor(options: StreamingStemTransportOptions = {}) {
    this.context = options.context ?? null;
    this.ownsContext = !options.context;
    this.contextFactory = options.contextFactory ?? defaultContextFactory;
    this.decoder = options.decoder ?? null;
    this.ownsDecoder = !options.decoder;
    this.decoderFactory = options.decoderFactory
      ?? (() => new WorkerPreviewWindowDecoder());
    this.prebufferSeconds = Math.max(
      0.1,
      finiteOr(options.prebufferSeconds ?? DEFAULT_PREBUFFER_SECONDS, DEFAULT_PREBUFFER_SECONDS),
    );
    this.scheduleHorizonSeconds = Math.max(
      0.1,
      finiteOr(
        options.scheduleHorizonSeconds ?? DEFAULT_SCHEDULE_HORIZON_SECONDS,
        DEFAULT_SCHEDULE_HORIZON_SECONDS,
      ),
    );
    this.scheduleAheadSeconds = Math.max(
      0,
      finiteOr(
        options.scheduleAheadSeconds ?? DEFAULT_SCHEDULE_AHEAD_SECONDS,
        DEFAULT_SCHEDULE_AHEAD_SECONDS,
      ),
    );
    this.maintenanceIntervalMs = Math.max(
      25,
      finiteOr(
        options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS,
        DEFAULT_MAINTENANCE_INTERVAL_MS,
      ),
    );
    this.maxDecodedBytes = Math.max(
      1,
      finiteOr(options.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES, DEFAULT_MAX_DECODED_BYTES),
    );
    this.setTimer = options.setTimer ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle));
    if (this.context) this.attachContext(this.context);
  }

  getAudioContext(): AudioContext {
    this.assertUsable();
    return this.ensureContext();
  }

  getOutputNode(): AudioNode {
    const context = this.getAudioContext();
    return this.ensureMasterGain(context);
  }

  getCurrentTime(): number {
    if (
      !this.context
      || (this.statusValue !== "playing" && this.statusValue !== "buffering")
    ) {
      return this.anchorPosition;
    }
    const clockTime = Math.min(
      this.context.currentTime,
      this.scheduleCursorContextTime,
    );
    return this.positionAtContextTime(clockTime);
  }

  getSnapshot(): StreamingStemTransportSnapshot {
    return {
      status: this.statusValue,
      currentTime: this.getCurrentTime(),
      duration: this.durationSeconds,
      playbackRate: this.playbackRateValue,
      loop: { ...this.loopValue },
      loadedStemIds: [...this.loadedStemIds],
      loadProgress: this.progressValue ? { ...this.progressValue } : null,
      buffered: this.bufferedRanges(),
      decodedBytes: this.decodedBytesValue,
      maxDecodedBytes: this.maxDecodedBytes,
      error: this.errorValue,
      contextState: this.contextState(),
    };
  }

  subscribe(listener: SnapshotListener): () => void {
    this.assertUsable();
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  onEnded(listener: EndedListener): () => void {
    this.assertUsable();
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  async unlock(): Promise<void> {
    this.assertUsable();
    const context = this.ensureContext();
    if (context.state !== "running") await context.resume();
    this.emit();
  }

  async load(
    deck: StreamingStemDeck | unknown,
    options: StreamingStemLoadOptions = {},
  ): Promise<StreamingStemLoadResult> {
    this.assertUsable();
    this.resetDeck();
    this.statusValue = "loading";
    this.progressValue = {
      phase: "validating",
      windowsReady: 0,
      totalWindows: 0,
      bufferedThrough: 0,
    };
    this.errorValue = null;
    this.emit();

    try {
      const manifest = validateStreamingStemDeck(deck);
      this.manifest = manifest;
      this.durationSeconds = previewDurationSeconds(manifest);
      this.loadedStemIds = AUDIO_STEM_IDS.filter((id) => Boolean(manifest.stems[id]));
      this.windows = manifest.stems[this.loadedStemIds[0]]!.windows;
      this.loopValue = normalizeLoop(this.loopValue, this.durationSeconds);
      this.ensureContext();
      this.ensureDecoder();
      this.createChannels();
      this.applyMix();
      const generation = this.beginDecodeGeneration(options.signal);
      await this.prebufferPosition(0, generation, options);
      if (generation !== this.decodeGeneration || this.decodeController?.signal.aborted) {
        throw abortError(this.decodeController?.signal.reason);
      }
      this.anchorPosition = 0;
      this.anchorContextTime = this.context?.currentTime ?? 0;
      this.statusValue = "ready";
      this.progressValue = {
        phase: "ready",
        windowsReady: this.cache.size,
        totalWindows: this.windows.length,
        bufferedThrough: this.bufferedThrough(0),
      };
      this.emit();
      return {
        duration: this.durationSeconds,
        loadedStemIds: [...this.loadedStemIds],
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        this.statusValue = "idle";
        this.progressValue = null;
        this.emit();
        throw error;
      }
      this.errorValue = error instanceof Error ? error : new Error(String(error));
      this.statusValue = "error";
      this.progressValue = null;
      this.emit();
      throw this.errorValue;
    }
  }

  async play(): Promise<void> {
    this.assertUsable();
    if (!this.manifest || !this.loadedStemIds.length) {
      throw new Error("Load a streaming stem deck before starting playback.");
    }
    if (this.playIntent && this.statusValue === "playing") return;

    const context = this.ensureContext();
    const resume = context.state === "running" ? Promise.resolve() : context.resume();
    this.playIntent = true;
    if (this.anchorPosition >= this.durationSeconds - CLOCK_EPSILON_SECONDS) {
      this.anchorPosition = this.loopValue.enabled ? this.loopValue.start : 0;
    }
    const generation = this.beginDecodeGeneration();
    const position = this.anchorPosition;
    const index = this.windowIndexAt(position);
    if (!this.cache.has(index)) {
      this.statusValue = "buffering";
      this.emit();
      await Promise.all([
        resume,
        this.prebufferPosition(position, generation),
      ]);
    } else {
      await resume;
      void this.prebufferPosition(position, generation).catch(
        (error) => this.handleBackgroundError(error, generation),
      );
    }
    if (!this.playIntent || generation !== this.decodeGeneration) return;
    this.startGeneration(position, context.currentTime + this.scheduleAheadSeconds);
    this.statusValue = "playing";
    this.errorValue = null;
    this.armMaintenance();
    this.emit();
  }

  /**
   * Explicitly fills the bounded common cache around a deck position. `load`
   * and playback call this automatically; exposing it also lets a UI prewarm
   * the location under a scrubber before the user releases it.
   */
  async prebuffer(
    position = this.getCurrentTime(),
    options: StreamingStemLoadOptions = {},
  ): Promise<void> {
    this.assertUsable();
    if (!this.manifest) {
      throw new Error("Load a streaming stem deck before prebuffering.");
    }
    const target = clamp(finiteOr(position, 0), 0, this.durationSeconds);
    const generation = this.beginDecodeGeneration(options.signal);
    await this.prebufferPosition(target, generation, options);
    if (generation !== this.decodeGeneration || this.decodeController?.signal.aborted) {
      throw abortError(this.decodeController?.signal.reason);
    }
    this.emit();
  }

  pause(): void {
    this.assertUsable();
    if (!this.playIntent && this.statusValue !== "buffering") return;
    const position = this.getCurrentTime();
    this.playIntent = false;
    this.cancelDecodeGeneration();
    this.stopSources(this.context?.currentTime ?? 0);
    this.anchorPosition = position;
    this.anchorContextTime = this.context?.currentTime ?? 0;
    this.statusValue = "paused";
    this.disarmMaintenance();
    this.emit();
  }

  seek(seconds: number): void {
    this.assertUsable();
    const position = positionInsideLoop(
      clamp(finiteOr(seconds, 0), 0, this.durationSeconds),
      this.loopValue,
    );
    const shouldResume = this.playIntent;
    this.cancelDecodeGeneration();
    this.stopSources(this.context?.currentTime ?? 0);
    this.anchorPosition = position;
    this.anchorContextTime = this.context?.currentTime ?? 0;
    if (!shouldResume) {
      this.statusValue = "paused";
      this.emit();
      return;
    }
    const generation = this.beginDecodeGeneration();
    if (this.cache.has(this.windowIndexAt(position))) {
      this.startGeneration(
        position,
        (this.context?.currentTime ?? 0) + this.scheduleAheadSeconds,
      );
      this.statusValue = "playing";
      void this.prebufferPosition(position, generation).then(() => {
        if (generation === this.decodeGeneration && this.playIntent) {
          this.scheduleAvailable();
          this.emit();
        }
      }).catch((error) => this.handleBackgroundError(error, generation));
    } else {
      this.statusValue = "buffering";
      void this.prebufferPosition(position, generation).then(() => {
        if (!this.playIntent || generation !== this.decodeGeneration) return;
        this.startGeneration(
          position,
          (this.context?.currentTime ?? 0) + this.scheduleAheadSeconds,
        );
        this.statusValue = "playing";
        this.emit();
      }).catch((error) => this.handleBackgroundError(error, generation));
    }
    this.armMaintenance();
    this.emit();
  }

  setPlaybackRate(rate: number): void {
    this.assertUsable();
    const next = clamp(finiteOr(rate, 1), 0.25, 4);
    if (next === this.playbackRateValue) return;
    if (this.playIntent && this.context) {
      const when = this.context.currentTime + this.scheduleAheadSeconds;
      // The old generation keeps playing until the scheduled handoff. Sample
      // its old-rate clock at that exact time so the replacement generation
      // neither repeats nor skips the scheduling lead.
      const positionAtHandoff = this.positionAtContextTime(
        Math.min(when, this.scheduleCursorContextTime),
      );
      this.playbackRateValue = next;
      const generation = this.beginDecodeGeneration();
      this.startGeneration(
        positionAtHandoff,
        when,
      );
      this.statusValue = "playing";
      void this.prebufferPosition(positionAtHandoff, generation).then(() => {
        if (generation === this.decodeGeneration && this.playIntent) {
          this.scheduleAvailable();
          this.emit();
        }
      }).catch((error) => this.handleBackgroundError(error, generation));
    } else {
      const position = this.getCurrentTime();
      this.playbackRateValue = next;
      this.anchorPosition = position;
      this.anchorContextTime = this.context?.currentTime ?? 0;
    }
    this.emit();
  }

  setLoop(loop: StreamingStemLoop): void {
    this.assertUsable();
    const next = normalizeLoop(loop, this.durationSeconds);
    const unchanged = next.enabled === this.loopValue.enabled
      && next.start === this.loopValue.start
      && next.end === this.loopValue.end;
    if (unchanged) return;
    if (this.playIntent && this.context) {
      const when = this.context.currentTime + this.scheduleAheadSeconds;
      // Continue along the old loop until the shared source handoff, then
      // normalize that exact media position into the replacement loop.
      const positionAtHandoff = this.positionAtContextTime(
        Math.min(when, this.scheduleCursorContextTime),
      );
      this.loopValue = next;
      const position = positionInsideLoop(positionAtHandoff, next);
      const generation = this.beginDecodeGeneration();
      this.startGeneration(
        position,
        when,
      );
      this.statusValue = "playing";
      void this.prebufferPosition(position, generation).then(() => {
        if (generation === this.decodeGeneration && this.playIntent) {
          this.scheduleAvailable();
          this.emit();
        }
      }).catch((error) => this.handleBackgroundError(error, generation));
    } else {
      const position = positionInsideLoop(this.getCurrentTime(), next);
      this.loopValue = next;
      this.anchorPosition = position;
      this.anchorContextTime = this.context?.currentTime ?? 0;
    }
    this.emit();
  }

  setMix(stems: readonly StemState[]): void {
    this.assertUsable();
    this.latestMix = stems;
    this.applyMix();
    this.emit();
  }

  setMasterGain(gain: number): void {
    this.assertUsable();
    const context = this.ensureContext();
    const master = this.ensureMasterGain(context);
    setParam(master.gain, clamp(finiteOr(gain, 1), 0, 1), context);
  }

  unload(): void {
    this.assertUsable();
    this.resetDeck();
    this.statusValue = "idle";
    this.errorValue = null;
    this.progressValue = null;
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.resetDeck();
    this.disposed = true;
    this.statusValue = "disposed";
    this.context?.removeEventListener("statechange", this.handleContextStateChange);
    this.masterGain?.disconnect();
    this.masterGain = null;
    this.masterLimiter?.disconnect();
    this.masterLimiter = null;
    if (this.ownsDecoder) this.decoder?.dispose();
    this.decoder = null;
    const context = this.context;
    this.context = null;
    if (this.ownsContext && context && context.state !== "closed") void context.close();
    this.emit();
    this.listeners.clear();
    this.endedListeners.clear();
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("StreamingStemTransport has been disposed.");
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = this.contextFactory();
      this.attachContext(this.context);
    }
    if (this.context.state === "closed") {
      throw new Error("The Web Audio context is closed.");
    }
    return this.context;
  }

  private attachContext(context: AudioContext): void {
    context.addEventListener("statechange", this.handleContextStateChange);
    this.ensureMasterGain(context);
  }

  private ensureMasterGain(context: AudioContext): GainNode {
    if (!this.masterGain) {
      this.masterGain = context.createGain();
      this.masterGain.gain.value = 1;
      if (typeof context.createDynamicsCompressor === "function") {
        this.masterLimiter = context.createDynamicsCompressor();
        this.masterLimiter.threshold.value = -3;
        this.masterLimiter.knee.value = 3;
        this.masterLimiter.ratio.value = 20;
        this.masterLimiter.attack.value = 0.003;
        this.masterLimiter.release.value = 0.1;
        this.masterGain.connect(this.masterLimiter).connect(context.destination);
      } else {
        this.masterGain.connect(context.destination);
      }
    }
    return this.masterGain;
  }

  private ensureDecoder(): PreviewWindowDecoder {
    if (!this.decoder) this.decoder = this.decoderFactory();
    return this.decoder;
  }

  private contextState(): StreamingStemTransportSnapshot["contextState"] {
    if (!this.context) return "uninitialized";
    return this.context.state as StreamingStemTransportSnapshot["contextState"];
  }

  private createChannels(): void {
    this.disconnectChannels();
    const context = this.ensureContext();
    const master = this.ensureMasterGain(context);
    for (const id of this.loadedStemIds) {
      const gain = context.createGain();
      const pan = createPanController(context);
      gain.connect(pan.node);
      pan.node.connect(master);
      this.channels.set(id, { gain, pan });
    }
  }

  private disconnectChannels(): void {
    for (const channel of this.channels.values()) {
      channel.gain.disconnect();
      channel.pan.node.disconnect();
    }
    this.channels.clear();
  }

  private applyMix(): void {
    if (!this.context || !this.latestMix) return;
    const mix = resolveStemMix(this.latestMix);
    for (const [id, channel] of this.channels) {
      const values = mix[id] ?? { gain: 1, pan: 0 };
      setParam(channel.gain.gain, values.gain, this.context);
      channel.pan.set(values.pan, this.context);
    }
  }

  private beginDecodeGeneration(externalSignal?: AbortSignal): number {
    this.cancelDecodeGeneration();
    const controller = new AbortController();
    if (externalSignal?.aborted) controller.abort(externalSignal.reason);
    else externalSignal?.addEventListener(
      "abort",
      () => controller.abort(externalSignal.reason),
      { once: true, signal: controller.signal },
    );
    this.decodeController = controller;
    this.decodeGeneration += 1;
    return this.decodeGeneration;
  }

  private cancelDecodeGeneration(): void {
    const generation = this.decodeGeneration;
    this.decodeController?.abort();
    this.decodeController = null;
    if (generation > 0) this.decoder?.cancelGeneration(generation);
    this.pendingWindows.clear();
  }

  private async prebufferPosition(
    position: number,
    generation: number,
    options: StreamingStemLoadOptions = {},
  ): Promise<void> {
    if (!this.manifest) return;
    const firstIndex = this.windowIndexAt(position);
    const targetFrame = Math.min(
      this.manifest.durationFrames,
      Math.floor((position + this.prebufferSeconds) * this.manifest.sampleRate),
    );
    const protectedIndices = new Set<number>();
    for (let index = firstIndex; index < this.windows.length; index += 1) {
      const window = this.windows[index];
      if (!this.cache.has(index) && !this.hasCacheCapacityFor(window, protectedIndices)) {
        // Cache pressure is normal during sustained all-stem playback: the
        // currently scheduled common windows cannot be evicted yet. Stop
        // prebuffering here and let the maintenance loop retry after those
        // sources end instead of turning a healthy deck into a fatal error.
        break;
      }
      protectedIndices.add(index);
      await this.ensureWindow(index, generation, protectedIndices);
      if (generation !== this.decodeGeneration) throw abortError();
      const progress = {
        phase: "buffering" as const,
        windowsReady: this.cache.size,
        totalWindows: this.windows.length,
        bufferedThrough: this.bufferedThrough(position),
      };
      this.progressValue = progress;
      options.onProgress?.(progress);
      this.emit();
      if (window.startFrame + window.frameCount >= targetFrame) break;
    }
  }

  private hasCacheCapacityFor(
    window: StemPreviewWindow,
    protectedIndices: Set<number>,
  ): boolean {
    if (!this.manifest) return false;
    const channelCount = this.loadedStemIds.reduce(
      (total, id) => total + (this.manifest?.stems[id]?.channels ?? 0),
      0,
    );
    const requiredBytes = (
      window.frameCount
      * channelCount
      * Float32Array.BYTES_PER_ELEMENT
    );
    if (requiredBytes > this.maxDecodedBytes) {
      throw new Error(
        "A single synchronized preview window exceeds the decoded-audio memory limit.",
      );
    }
    let retainedBytes = this.decodedBytesValue;
    const reclaimable = [...this.cache.values()]
      .filter((entry) => (
        entry.scheduledReferences === 0
        && !protectedIndices.has(entry.index)
      ))
      .sort((left, right) => left.lastUsed - right.lastUsed);
    for (const entry of reclaimable) {
      if (retainedBytes + requiredBytes <= this.maxDecodedBytes) break;
      retainedBytes -= entry.bytes;
    }
    return retainedBytes + requiredBytes <= this.maxDecodedBytes;
  }

  private ensureWindow(
    index: number,
    generation: number,
    protectedIndices = new Set<number>([index]),
  ): Promise<CachedWindow> {
    const cached = this.cache.get(index);
    if (cached) {
      cached.lastUsed = ++this.cacheAccess;
      return Promise.resolve(cached);
    }
    const existing = this.pendingWindows.get(index);
    if (existing) return existing;
    if (!this.manifest) return Promise.reject(new Error("No preview manifest is loaded."));

    const manifest = this.manifest;
    const decoder = this.ensureDecoder();
    const signal = this.decodeController?.signal;
    const window = this.windows[index];
    const task = Promise.all(this.loadedStemIds.map(async (id) => {
      const source = manifest.stems[id]!;
      return decoder.decode({
        generation,
        stemId: id,
        source,
        window: source.windows[index],
        codec: manifest.codec,
        bitstream: manifest.bitstream,
        sampleRate: manifest.sampleRate,
        packetFrames: manifest.packetFrames,
      }, signal);
    })).then((decoded) => {
      if (
        generation !== this.decodeGeneration
        || signal?.aborted
        || !this.manifest
      ) {
        throw abortError(signal?.reason);
      }

      const context = this.ensureContext();
      const buffers = new Map<AudioStemId, AudioBuffer>();
      let bytes = 0;
      for (const result of decoded) {
        const source = manifest.stems[result.stemId]!;
        if (
          result.startFrame !== window.startFrame
          || result.frameCount !== window.frameCount
          || result.sampleRate !== manifest.sampleRate
          || result.channels.length !== source.channels
          || result.channels.some((channel) => channel.length < window.frameCount)
        ) {
          throw new Error(`Decoded ${result.stemId} window does not match the manifest.`);
        }
        const buffer = context.createBuffer(
          source.channels,
          window.frameCount,
          manifest.sampleRate,
        );
        result.channels.forEach((channel, channelIndex) => {
          buffer.copyToChannel(
            channel.subarray(0, window.frameCount),
            channelIndex,
          );
          bytes += window.frameCount * Float32Array.BYTES_PER_ELEMENT;
        });
        buffers.set(result.stemId, buffer);
      }

      this.evictFor(bytes, protectedIndices);
      if (bytes > this.maxDecodedBytes) {
        throw new Error(
          "A single synchronized preview window exceeds the decoded-audio memory limit.",
        );
      }
      const entry: CachedWindow = {
        index,
        startFrame: window.startFrame,
        frameCount: window.frameCount,
        buffers,
        bytes,
        lastUsed: ++this.cacheAccess,
        scheduledReferences: 0,
      };
      this.cache.set(index, entry);
      this.decodedBytesValue += bytes;
      return entry;
    }).finally(() => {
      if (this.pendingWindows.get(index) === task) this.pendingWindows.delete(index);
    });
    this.pendingWindows.set(index, task);
    return task;
  }

  private evictFor(additionalBytes: number, protectedIndices: Set<number>): void {
    if (additionalBytes > this.maxDecodedBytes) return;
    const candidates = [...this.cache.values()]
      .filter((entry) => (
        entry.scheduledReferences === 0
        && !protectedIndices.has(entry.index)
      ))
      .sort((left, right) => left.lastUsed - right.lastUsed);
    for (const entry of candidates) {
      if (this.decodedBytesValue + additionalBytes <= this.maxDecodedBytes) break;
      this.cache.delete(entry.index);
      this.decodedBytesValue -= entry.bytes;
    }
    if (this.decodedBytesValue + additionalBytes > this.maxDecodedBytes) {
      throw new Error(
        "The prebuffer target exceeds the decoded-audio memory limit. "
        + "Use shorter preview windows or a smaller prebuffer.",
      );
    }
  }

  private startGeneration(position: number, when: number): void {
    const oldSources = [...this.liveSources];
    const generation = ++this.sourceGeneration;
    for (const handle of oldSources) {
      try {
        handle.source.stop(when);
      } catch {
        // A source may already have ended between snapshot and handoff.
      }
    }
    this.anchorPosition = positionInsideLoop(position, this.loopValue);
    this.anchorContextTime = when;
    this.scheduleCursorPosition = this.anchorPosition;
    this.scheduleCursorContextTime = when;
    this.reachedTerminalCursor = false;
    this.scheduleAvailable(generation);
  }

  private scheduleAvailable(generation = this.sourceGeneration): void {
    if (!this.context || !this.manifest || generation !== this.sourceGeneration) return;
    const horizon = this.context.currentTime + this.scheduleHorizonSeconds;
    let guard = 0;
    while (
      this.scheduleCursorContextTime < horizon
      && !this.reachedTerminalCursor
      && guard < 128
    ) {
      guard += 1;
      const position = positionInsideLoop(this.scheduleCursorPosition, this.loopValue);
      const index = this.windowIndexAt(position);
      const entry = this.cache.get(index);
      if (!entry) break;
      entry.lastUsed = ++this.cacheAccess;

      const windowStart = entry.startFrame / this.manifest.sampleRate;
      const windowEnd = (
        entry.startFrame + entry.frameCount
      ) / this.manifest.sampleRate;
      const boundary = this.loopValue.enabled
        ? Math.min(windowEnd, this.loopValue.end)
        : Math.min(windowEnd, this.durationSeconds);
      const mediaDuration = boundary - position;
      if (mediaDuration <= CLOCK_EPSILON_SECONDS) {
        if (this.loopValue.enabled && position >= this.loopValue.end - CLOCK_EPSILON_SECONDS) {
          this.scheduleCursorPosition = this.loopValue.start;
          continue;
        }
        if (position >= this.durationSeconds - CLOCK_EPSILON_SECONDS) {
          this.reachedTerminalCursor = true;
          break;
        }
        this.scheduleCursorPosition = windowEnd;
        continue;
      }

      const offset = position - windowStart;
      const segmentSources: ScheduledSource[] = [];
      for (const id of this.loadedStemIds) {
        const buffer = entry.buffers.get(id);
        const channel = this.channels.get(id);
        if (!buffer || !channel) {
          throw new Error("A common preview window is missing a loaded stem.");
        }
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.setValueAtTime(
          this.playbackRateValue,
          this.scheduleCursorContextTime,
        );
        source.connect(channel.gain);
        const handle = { source, generation, windowIndex: index };
        source.onended = () => this.handleSourceEnded(handle);
        this.liveSources.add(handle);
        segmentSources.push(handle);
      }
      entry.scheduledReferences += segmentSources.length;
      try {
        for (const handle of segmentSources) {
          handle.source.start(
            this.scheduleCursorContextTime,
            offset,
            mediaDuration,
          );
        }
      } catch (error) {
        for (const handle of segmentSources) {
          this.liveSources.delete(handle);
          entry.scheduledReferences = Math.max(0, entry.scheduledReferences - 1);
          try {
            handle.source.stop();
          } catch {
            // Ignore secondary cleanup failures.
          }
          handle.source.disconnect();
        }
        throw error;
      }

      this.scheduleCursorContextTime += mediaDuration / this.playbackRateValue;
      this.scheduleCursorPosition = boundary;
      if (
        this.loopValue.enabled
        && boundary >= this.loopValue.end - CLOCK_EPSILON_SECONDS
      ) {
        this.scheduleCursorPosition = this.loopValue.start;
      } else if (
        !this.loopValue.enabled
        && boundary >= this.durationSeconds - CLOCK_EPSILON_SECONDS
      ) {
        this.reachedTerminalCursor = true;
      }
    }
  }

  private handleSourceEnded(handle: ScheduledSource): void {
    if (!this.liveSources.delete(handle)) return;
    handle.source.disconnect();
    const entry = this.cache.get(handle.windowIndex);
    if (entry) entry.scheduledReferences = Math.max(0, entry.scheduledReferences - 1);
    if (handle.generation === this.sourceGeneration) this.maintain();
  }

  private stopSources(when: number): void {
    this.sourceGeneration += 1;
    for (const handle of this.liveSources) {
      try {
        handle.source.stop(when);
      } catch {
        // Already-ended sources are harmless.
      }
      handle.source.disconnect();
      const entry = this.cache.get(handle.windowIndex);
      if (entry) entry.scheduledReferences = Math.max(0, entry.scheduledReferences - 1);
    }
    this.liveSources.clear();
    this.scheduleCursorContextTime = when;
  }

  private maintain(): void {
    if (!this.playIntent || !this.context || !this.manifest) return;
    this.scheduleAvailable();
    const position = this.getCurrentTime();
    const generation = this.decodeGeneration;
    const targetIndex = this.windowIndexAt(this.scheduleCursorPosition);
    if (
      !this.reachedTerminalCursor
      && !this.cache.has(targetIndex)
      && !this.pendingWindows.has(targetIndex)
    ) {
      void this.prebufferPosition(
        this.scheduleCursorPosition,
        generation,
      ).then(() => {
        if (generation !== this.decodeGeneration || !this.playIntent) return;
        if (
          this.context
          && this.context.currentTime >= this.scheduleCursorContextTime - CLOCK_EPSILON_SECONDS
        ) {
          this.startGeneration(
            this.scheduleCursorPosition,
            this.context.currentTime + this.scheduleAheadSeconds,
          );
          this.statusValue = "playing";
        } else {
          this.scheduleAvailable();
        }
        this.emit();
      }).catch((error) => this.handleBackgroundError(error, generation));
    }

    if (
      this.reachedTerminalCursor
      && this.context.currentTime >= this.scheduleCursorContextTime - CLOCK_EPSILON_SECONDS
    ) {
      this.playIntent = false;
      this.anchorPosition = this.durationSeconds;
      this.anchorContextTime = this.context.currentTime;
      this.statusValue = "ended";
      this.disarmMaintenance();
      this.endedListeners.forEach((listener) => listener());
      this.emit();
      return;
    }
    if (
      !this.reachedTerminalCursor
      && this.context.currentTime >= this.scheduleCursorContextTime - CLOCK_EPSILON_SECONDS
    ) {
      this.anchorPosition = this.scheduleCursorPosition;
      this.anchorContextTime = this.scheduleCursorContextTime;
      this.statusValue = "buffering";
    } else {
      this.statusValue = "playing";
    }
    // `position` is intentionally sampled before status changes so the deck
    // freezes at its common boundary if all scheduled sources run out.
    void position;
    this.emit();
    this.armMaintenance();
  }

  private armMaintenance(): void {
    if (this.timer !== null || !this.playIntent) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.maintain();
    }, this.maintenanceIntervalMs);
  }

  private disarmMaintenance(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private handleBackgroundError(error: unknown, generation: number): void {
    if (generation !== this.decodeGeneration) return;
    if (error instanceof DOMException && error.name === "AbortError") return;
    this.errorValue = error instanceof Error ? error : new Error(String(error));
    this.playIntent = false;
    this.stopSources(this.context?.currentTime ?? 0);
    this.statusValue = "error";
    this.disarmMaintenance();
    this.emit();
  }

  private positionAtContextTime(contextTime: number): number {
    const elapsed = Math.max(0, contextTime - this.anchorContextTime);
    const raw = this.anchorPosition + elapsed * this.playbackRateValue;
    return clamp(positionInsideLoop(raw, this.loopValue), 0, this.durationSeconds);
  }

  private windowIndexAt(position: number): number {
    if (!this.manifest || !this.windows.length) return 0;
    const frame = Math.min(
      this.manifest.durationFrames - 1,
      Math.max(0, Math.floor(position * this.manifest.sampleRate)),
    );
    let low = 0;
    let high = this.windows.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const window = this.windows[middle];
      if (frame < window.startFrame) high = middle - 1;
      else if (frame >= window.startFrame + window.frameCount) low = middle + 1;
      else return middle;
    }
    return clamp(low, 0, this.windows.length - 1);
  }

  private bufferedThrough(position: number): number {
    if (!this.manifest || !this.windows.length) return 0;
    let index = this.windowIndexAt(position);
    let end = position;
    while (index < this.windows.length && this.cache.has(index)) {
      const window = this.windows[index];
      end = (window.startFrame + window.frameCount) / this.manifest.sampleRate;
      index += 1;
    }
    return end;
  }

  private bufferedRanges(): StreamingBufferedRange[] {
    if (!this.manifest) return [];
    const indices = [...this.cache.keys()].sort((left, right) => left - right);
    const ranges: StreamingBufferedRange[] = [];
    for (const index of indices) {
      const window = this.windows[index];
      const start = window.startFrame / this.manifest.sampleRate;
      const end = (window.startFrame + window.frameCount) / this.manifest.sampleRate;
      const previous = ranges.at(-1);
      if (previous && Math.abs(previous.end - start) <= CLOCK_EPSILON_SECONDS) {
        previous.end = end;
      } else {
        ranges.push({ start, end });
      }
    }
    return ranges;
  }

  private resetDeck(): void {
    this.playIntent = false;
    this.disarmMaintenance();
    this.cancelDecodeGeneration();
    this.stopSources(this.context?.currentTime ?? 0);
    this.disconnectChannels();
    this.cache.clear();
    this.decodedBytesValue = 0;
    this.pendingWindows.clear();
    this.manifest = null;
    this.windows = [];
    this.loadedStemIds = [];
    this.durationSeconds = 0;
    this.anchorPosition = 0;
    this.anchorContextTime = this.context?.currentTime ?? 0;
    this.scheduleCursorPosition = 0;
    this.scheduleCursorContextTime = this.anchorContextTime;
    this.reachedTerminalCursor = false;
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
