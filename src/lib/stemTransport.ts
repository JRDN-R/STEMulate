import {
  createPanController,
  resolveStemMix,
} from "./audioMixer.ts";
import {
  AUDIO_STEM_IDS,
  type AudioStemId,
  type StemSources,
  type StemState,
} from "./stems.ts";

const MIN_LOOP_SECONDS = 0.01;
const DEFAULT_SCHEDULE_AHEAD_SECONDS = 0.008;
const DEFAULT_PARAMETER_RAMP_SECONDS = 0.008;
const DEFAULT_MAX_DECODED_BYTES = 320 * 1024 * 1024;
const END_EPSILON_SECONDS = 1 / 48_000;

export type StemTransportStatus =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "error"
  | "disposed";

export type StemLoop = {
  enabled: boolean;
  start: number;
  end: number;
};

export type StemLoadPhase = "fetching" | "decoding" | "ready";

export type StemLoadProgress = {
  id: AudioStemId;
  index: number;
  total: number;
  phase: StemLoadPhase;
};

export type StemLoadResult = {
  duration: number;
  loadedStemIds: AudioStemId[];
};

export type StemTransportSnapshot = StemLoadResult & {
  status: StemTransportStatus;
  currentTime: number;
  playbackRate: number;
  loop: StemLoop;
  loadProgress: StemLoadProgress | null;
  error: Error | null;
  contextState: AudioContextState | "interrupted" | "uninitialized";
};

export type StemLoadOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: StemLoadProgress) => void;
};

export type StemTransportOptions = {
  /**
   * Supplying a context is useful when the application already owns one.
   * StemTransport will not close an injected context when disposed.
   */
  context?: AudioContext;
  contextFactory?: () => AudioContext;
  fetcher?: typeof fetch;
  scheduleAheadSeconds?: number;
  parameterRampSeconds?: number;
  /**
   * Maximum retained PCM memory for the selected stems. Full-buffer playback
   * provides the shared sample clock, but a bounded deck is safer than letting
   * iOS WebKit terminate the whole tab for an oversized selection.
   */
  maxDecodedBytes?: number;
};

type PanController = ReturnType<typeof createPanController>;

type ChannelNodes = {
  gain: GainNode;
  pan: PanController;
};

type SourceHandle = {
  node: AudioBufferSourceNode;
  generation: number;
};

type SnapshotListener = (snapshot: StemTransportSnapshot) => void;
type EndedListener = () => void;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function normalizedLoop(loop: StemLoop, duration: number): StemLoop {
  const upperBound = duration > 0 ? duration : Number.POSITIVE_INFINITY;
  const start = clamp(finiteOr(loop.start, 0), 0, upperBound);
  const end = clamp(finiteOr(loop.end, start), start, upperBound);
  return {
    enabled: Boolean(loop.enabled) && end - start >= MIN_LOOP_SECONDS,
    start,
    end,
  };
}

function positionInsideLoop(position: number, loop: StemLoop): number {
  if (!loop.enabled || position < loop.end) return position;
  const length = loop.end - loop.start;
  return loop.start + ((position - loop.start) % length + length) % length;
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
    // Older WebKit accepts no AudioContextOptions argument.
    return new Context();
  }
}

function abortError(reason?: unknown): DOMException {
  if (reason instanceof DOMException && reason.name === "AbortError") return reason;
  return new DOMException("The stem load was cancelled.", "AbortError");
}

function decodeAudioData(
  context: BaseAudioContext,
  bytes: ArrayBuffer,
): Promise<AudioBuffer> {
  // Promise-returning decodeAudioData is standard now. Supplying callbacks too
  // keeps this path compatible with older iOS WebKit releases.
  return new Promise<AudioBuffer>((resolve, reject) => {
    let settled = false;
    const succeed = (buffer: AudioBuffer) => {
      if (settled) return;
      settled = true;
      resolve(buffer);
    };
    const fail = (error: DOMException) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    try {
      const result = context.decodeAudioData(bytes, succeed, fail);
      if (result && typeof result.then === "function") result.then(succeed, fail);
    } catch (error) {
      reject(error);
    }
  });
}

function estimatedDecodedBytes(
  buffer: AudioBuffer,
  context: BaseAudioContext,
): number {
  const channelCount = Number.isFinite(buffer.numberOfChannels) && buffer.numberOfChannels > 0
    ? buffer.numberOfChannels
    : 2;
  if (Number.isFinite(buffer.length) && buffer.length > 0) {
    return buffer.length * channelCount * Float32Array.BYTES_PER_ELEMENT;
  }
  const sampleRate = Number.isFinite(buffer.sampleRate) && buffer.sampleRate > 0
    ? buffer.sampleRate
    : Number.isFinite(context.sampleRate) && context.sampleRate > 0
      ? context.sampleRate
      : 48_000;
  return Math.ceil(
    buffer.duration
      * sampleRate
      * channelCount
      * Float32Array.BYTES_PER_ELEMENT,
  );
}

function setParam(
  parameter: AudioParam,
  value: number,
  context: BaseAudioContext,
  rampSeconds: number,
): void {
  parameter.cancelScheduledValues(context.currentTime);
  if (rampSeconds > 0 && typeof parameter.setTargetAtTime === "function") {
    parameter.setTargetAtTime(value, context.currentTime, rampSeconds);
  } else {
    parameter.setValueAtTime(value, context.currentTime);
  }
}

/**
 * Sample-clocked multi-stem playback.
 *
 * Unlike a group of HTMLAudioElements, every source in this transport is
 * decoded into the same AudioContext and starts at the exact same context
 * timestamp. There is no leader element, drift correction, or repeated
 * currentTime assignment to create skips.
 */
export class StemTransport {
  private context: AudioContext | null;

  private readonly ownsContext: boolean;

  private readonly contextFactory: () => AudioContext;

  private readonly fetcher: typeof fetch;

  private readonly scheduleAheadSeconds: number;

  private readonly parameterRampSeconds: number;

  private readonly maxDecodedBytes: number;

  private masterGain: GainNode | null = null;

  private buffers = new Map<AudioStemId, AudioBuffer>();

  private channels = new Map<AudioStemId, ChannelNodes>();

  private currentSources: SourceHandle[] = [];

  private liveSources = new Set<AudioBufferSourceNode>();

  private sourceGeneration = 0;

  private remainingSources = 0;

  private durationSeconds = 0;

  private anchorPosition = 0;

  private anchorContextTime = 0;

  private playbackRateValue = 1;

  private loopValue: StemLoop = { enabled: false, start: 0, end: 0 };

  private statusValue: StemTransportStatus = "idle";

  private loadProgressValue: StemLoadProgress | null = null;

  private errorValue: Error | null = null;

  private latestMix: readonly StemState[] | null = null;

  private loadController: AbortController | null = null;

  private loadSerial = 0;

  private decodeQueue: Promise<void> = Promise.resolve();

  private listeners = new Set<SnapshotListener>();

  private endedListeners = new Set<EndedListener>();

  private disposed = false;

  private readonly handleContextStateChange = () => {
    this.emit();
  };

  constructor(options: StemTransportOptions = {}) {
    this.context = options.context ?? null;
    this.ownsContext = !options.context;
    this.contextFactory = options.contextFactory ?? defaultContextFactory;
    this.fetcher = options.fetcher ?? fetch;
    this.scheduleAheadSeconds = Math.max(
      0,
      finiteOr(options.scheduleAheadSeconds ?? DEFAULT_SCHEDULE_AHEAD_SECONDS, DEFAULT_SCHEDULE_AHEAD_SECONDS),
    );
    this.parameterRampSeconds = Math.max(
      0,
      finiteOr(options.parameterRampSeconds ?? DEFAULT_PARAMETER_RAMP_SECONDS, DEFAULT_PARAMETER_RAMP_SECONDS),
    );
    this.maxDecodedBytes = options.maxDecodedBytes === undefined
      ? DEFAULT_MAX_DECODED_BYTES
      : Math.max(1, finiteOr(options.maxDecodedBytes, DEFAULT_MAX_DECODED_BYTES));

    if (this.context) this.attachContext(this.context);
  }

  getAudioContext(): AudioContext {
    this.assertUsable();
    return this.ensureContext();
  }

  getCurrentTime(): number {
    if (!this.isPlaying() || !this.context) return this.anchorPosition;
    return this.positionAtContextTime(this.context.currentTime);
  }

  getSnapshot(): StemTransportSnapshot {
    return {
      status: this.statusValue,
      currentTime: this.getCurrentTime(),
      duration: this.durationSeconds,
      playbackRate: this.playbackRateValue,
      loop: { ...this.loopValue },
      loadedStemIds: [...this.buffers.keys()],
      loadProgress: this.loadProgressValue ? { ...this.loadProgressValue } : null,
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

  /**
   * Call from the original pointer/click handler on iOS. resume() is invoked
   * before the first await, preserving Safari's transient user activation.
   */
  async unlock(): Promise<void> {
    this.assertUsable();
    const context = this.ensureContext();
    if (context.state !== "running") await context.resume();
    this.emit();
  }

  async load(
    sources: StemSources,
    options: StemLoadOptions = {},
  ): Promise<StemLoadResult> {
    this.assertUsable();
    this.cancelLoad();
    this.clearLoadedAudio();

    const entries = AUDIO_STEM_IDS.flatMap((id) => {
      const url = sources[id];
      return url ? [[id, url] as const] : [];
    });
    if (!entries.length) {
      this.statusValue = "idle";
      this.emit();
      return { duration: 0, loadedStemIds: [] };
    }

    const context = this.ensureContext();
    const controller = new AbortController();
    const serial = ++this.loadSerial;
    this.loadController = controller;
    this.statusValue = "loading";
    this.errorValue = null;
    this.loadProgressValue = null;
    this.emit();

    const forwardAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) forwardAbort();
    else options.signal?.addEventListener("abort", forwardAbort, { once: true });

    const nextBuffers = new Map<AudioStemId, AudioBuffer>();
    let decodedBytes = 0;

    try {
      // Decode sequentially. Four uncompressed stereo stems can already use
      // hundreds of MB on a long song; limiting transient work is important on
      // iPhones where WebKit may terminate a memory-heavy tab.
      for (let index = 0; index < entries.length; index += 1) {
        if (controller.signal.aborted) throw abortError(controller.signal.reason);
        const [id, url] = entries[index];

        this.reportLoadProgress(
          { id, index: index + 1, total: entries.length, phase: "fetching" },
          options.onProgress,
        );
        const response = await this.fetcher(url, {
          cache: "force-cache",
          mode: "cors",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Could not load ${id} stem (${response.status} ${response.statusText}).`);
        }

        const bytes = await response.arrayBuffer();
        if (controller.signal.aborted) throw abortError(controller.signal.reason);
        this.reportLoadProgress(
          { id, index: index + 1, total: entries.length, phase: "decoding" },
          options.onProgress,
        );
        const buffer = await this.decodeSerially(context, bytes, controller.signal);
        if (controller.signal.aborted) throw abortError(controller.signal.reason);
        if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) {
          throw new Error(`The decoded ${id} stem has no playable audio.`);
        }
        const projectedBytes = decodedBytes + estimatedDecodedBytes(buffer, context);
        if (projectedBytes > this.maxDecodedBytes) {
          const projectedMiB = Math.ceil(projectedBytes / (1024 * 1024));
          const limitMiB = Math.floor(this.maxDecodedBytes / (1024 * 1024));
          throw new Error(
            `Selected stems need about ${projectedMiB} MiB of decoded audio `
            + `(deck limit ${limitMiB} MiB). Choose fewer stems and try again.`,
          );
        }
        decodedBytes = projectedBytes;
        nextBuffers.set(id, buffer);
        this.reportLoadProgress(
          { id, index: index + 1, total: entries.length, phase: "ready" },
          options.onProgress,
        );
      }

      if (serial !== this.loadSerial || controller.signal.aborted) {
        throw abortError(controller.signal.reason);
      }

      this.buffers = nextBuffers;
      // A common minimum prevents one slightly shorter stem from wrapping or
      // ending on a different sample timeline than its peers.
      this.durationSeconds = Math.min(
        ...[...nextBuffers.values()].map((buffer) => buffer.duration),
      );
      this.loopValue = normalizedLoop(this.loopValue, this.durationSeconds);
      this.anchorPosition = 0;
      this.anchorContextTime = context.currentTime;
      this.createChannels();
      this.applyMix();
      this.statusValue = "ready";
      this.loadProgressValue = null;
      this.loadController = null;
      this.emit();
      return {
        duration: this.durationSeconds,
        loadedStemIds: [...nextBuffers.keys()],
      };
    } catch (error) {
      if (serial !== this.loadSerial) throw abortError(controller.signal.reason);
      this.loadController = null;
      this.loadProgressValue = null;
      if (controller.signal.aborted) {
        this.statusValue = "idle";
        this.emit();
        throw abortError(controller.signal.reason);
      }
      this.errorValue = error instanceof Error ? error : new Error(String(error));
      this.statusValue = "error";
      this.emit();
      throw this.errorValue;
    } finally {
      options.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  async play(): Promise<void> {
    this.assertUsable();
    if (!this.buffers.size || this.durationSeconds <= 0) {
      throw new Error("Load at least one stem before starting playback.");
    }
    if (this.isPlaying()) return;

    // Keep this resume call before the first await for iOS user-gesture rules.
    const context = this.ensureContext();
    const resume = context.state === "running" ? Promise.resolve() : context.resume();
    await resume;
    this.assertUsable();

    if (this.anchorPosition >= this.durationSeconds - END_EPSILON_SECONDS) {
      this.anchorPosition = this.loopValue.enabled ? this.loopValue.start : 0;
    }

    const when = context.currentTime + this.scheduleAheadSeconds;
    this.scheduleSources(this.anchorPosition, when);
    this.statusValue = "playing";
    this.errorValue = null;
    this.emit();
  }

  pause(): void {
    this.assertUsable();
    if (!this.isPlaying()) return;
    const context = this.ensureContext();
    const position = this.getCurrentTime();
    this.statusValue = "paused";
    this.anchorPosition = position;
    this.anchorContextTime = context.currentTime;
    this.sourceGeneration += 1;
    this.stopEverySource(context.currentTime);
    this.emit();
  }

  seek(seconds: number): void {
    this.assertUsable();
    const unclamped = clamp(finiteOr(seconds, 0), 0, this.durationSeconds);
    const next = positionInsideLoop(unclamped, this.loopValue);
    if (
      this.isPlaying()
      && !this.loopValue.enabled
      && next >= this.durationSeconds - END_EPSILON_SECONDS
    ) {
      const context = this.ensureContext();
      this.statusValue = "paused";
      this.anchorPosition = this.durationSeconds;
      this.anchorContextTime = context.currentTime;
      this.sourceGeneration += 1;
      this.stopEverySource(context.currentTime);
      this.emit();
      return;
    }
    if (!this.isPlaying()) {
      this.anchorPosition = next;
      if (this.context) this.anchorContextTime = this.context.currentTime;
      this.emit();
      return;
    }

    const context = this.ensureContext();
    const when = context.currentTime + this.scheduleAheadSeconds;
    this.scheduleSources(next, when);
    this.emit();
  }

  setPlaybackRate(rate: number): void {
    this.assertUsable();
    const next = clamp(finiteOr(rate, 1), 0.25, 4);
    if (next === this.playbackRateValue) return;

    const context = this.context;
    if (this.isPlaying() && context) {
      const now = context.currentTime;
      if (now >= this.anchorContextTime) {
        this.anchorPosition = this.positionAtContextTime(now);
        this.anchorContextTime = now;
      }
      for (const source of this.currentSources) {
        source.node.playbackRate.cancelScheduledValues(now);
        source.node.playbackRate.setValueAtTime(next, now);
      }
    }
    this.playbackRateValue = next;
    this.emit();
  }

  setLoop(loop: StemLoop): void {
    this.assertUsable();
    const next = normalizedLoop(loop, this.durationSeconds);
    const unchanged = next.enabled === this.loopValue.enabled
      && next.start === this.loopValue.start
      && next.end === this.loopValue.end;
    if (unchanged) return;

    const context = this.context;
    const when = this.isPlaying() && context
      ? context.currentTime + this.scheduleAheadSeconds
      : context?.currentTime ?? 0;
    // Let the current generation advance until the exact handoff timestamp,
    // then apply the new loop. This avoids rewinding by the scheduling lead.
    const positionAtHandoff = this.isPlaying() && context
      ? this.positionAtContextTime(when)
      : this.getCurrentTime();
    this.loopValue = next;
    const normalizedPosition = positionInsideLoop(positionAtHandoff, next);
    if (this.isPlaying() && this.context) {
      this.scheduleSources(normalizedPosition, when);
    } else {
      this.anchorPosition = normalizedPosition;
      if (this.context) this.anchorContextTime = this.context.currentTime;
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
    const masterGain = this.ensureMasterGain(context);
    setParam(
      masterGain.gain,
      clamp(finiteOr(gain, 1), 0, 1),
      context,
      this.parameterRampSeconds,
    );
  }

  cancelLoad(): void {
    this.loadSerial += 1;
    this.loadController?.abort();
    this.loadController = null;
  }

  unload(): void {
    this.assertUsable();
    this.cancelLoad();
    this.clearLoadedAudio();
    this.statusValue = "idle";
    this.errorValue = null;
    this.loadProgressValue = null;
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelLoad();
    this.clearLoadedAudio();
    this.disposed = true;
    this.statusValue = "disposed";
    this.context?.removeEventListener("statechange", this.handleContextStateChange);
    this.masterGain?.disconnect();
    this.masterGain = null;
    const context = this.context;
    this.context = null;
    this.emit();
    this.listeners.clear();
    this.endedListeners.clear();
    if (this.ownsContext && context && context.state !== "closed") void context.close();
  }

  private isPlaying(): boolean {
    return this.statusValue === "playing";
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("StemTransport has been disposed.");
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
      this.masterGain.connect(context.destination);
    }
    return this.masterGain;
  }

  private decodeSerially(
    context: BaseAudioContext,
    bytes: ArrayBuffer,
    signal: AbortSignal,
  ): Promise<AudioBuffer> {
    const task = this.decodeQueue.then(async () => {
      if (signal.aborted) throw abortError(signal.reason);
      const buffer = await decodeAudioData(context, bytes);
      if (signal.aborted) throw abortError(signal.reason);
      return buffer;
    });
    this.decodeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private contextState(): StemTransportSnapshot["contextState"] {
    if (!this.context) return "uninitialized";
    // Safari exposes "interrupted" even though older TypeScript DOM types do
    // not include it in AudioContextState.
    return this.context.state as StemTransportSnapshot["contextState"];
  }

  private positionAtContextTime(contextTime: number): number {
    const elapsed = Math.max(0, contextTime - this.anchorContextTime);
    const raw = this.anchorPosition + elapsed * this.playbackRateValue;
    const position = positionInsideLoop(raw, this.loopValue);
    return clamp(position, 0, this.durationSeconds);
  }

  private scheduleSources(position: number, when: number): void {
    const context = this.ensureContext();
    const oldSources = this.currentSources;
    const generation = ++this.sourceGeneration;
    const safePosition = positionInsideLoop(
      clamp(position, 0, this.durationSeconds),
      this.loopValue,
    );
    const nextSources: SourceHandle[] = [];

    for (const [id, buffer] of this.buffers) {
      const channel = this.channels.get(id);
      if (!channel) continue;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.setValueAtTime(this.playbackRateValue, when);
      source.loop = this.loopValue.enabled;
      if (this.loopValue.enabled) {
        source.loopStart = this.loopValue.start;
        source.loopEnd = this.loopValue.end;
      }
      source.connect(channel.gain);
      source.onended = () => this.handleSourceEnded(source, generation);
      this.liveSources.add(source);
      nextSources.push({ node: source, generation });
    }

    this.currentSources = nextSources;
    this.remainingSources = nextSources.length;
    this.anchorPosition = safePosition;
    this.anchorContextTime = when;

    try {
      for (const source of nextSources) {
        if (this.loopValue.enabled) {
          source.node.start(when, safePosition);
        } else {
          source.node.start(
            when,
            safePosition,
            Math.max(END_EPSILON_SECONDS, this.durationSeconds - safePosition),
          );
        }
      }
    } catch (error) {
      this.sourceGeneration += 1;
      for (const source of nextSources) this.stopAndDisconnect(source.node, context.currentTime);
      this.currentSources = [];
      this.remainingSources = 0;
      throw error;
    }

    // The handoff is scheduled on the audio clock too: old and new generations
    // meet at one timestamp without pausing each stem in JavaScript.
    for (const source of oldSources) {
      try {
        source.node.stop(when);
      } catch {
        // A naturally ended source needs no additional cleanup.
      }
    }
  }

  private handleSourceEnded(
    source: AudioBufferSourceNode,
    generation: number,
  ): void {
    this.liveSources.delete(source);
    source.disconnect();
    if (!this.isPlaying() || generation !== this.sourceGeneration) return;
    this.remainingSources -= 1;
    if (this.remainingSources > 0 || this.loopValue.enabled) return;

    this.currentSources = [];
    this.statusValue = "paused";
    this.anchorPosition = this.durationSeconds;
    if (this.context) this.anchorContextTime = this.context.currentTime;
    this.emit();
    for (const listener of this.endedListeners) listener();
  }

  private applyMix(): void {
    if (!this.context || !this.latestMix) return;
    const resolved = resolveStemMix(this.latestMix);
    for (const id of AUDIO_STEM_IDS) {
      const channel = this.channels.get(id);
      if (!channel) continue;
      const mix = resolved[id] ?? { gain: 0, pan: 0 };
      setParam(
        channel.gain.gain,
        mix.gain,
        this.context,
        this.parameterRampSeconds,
      );
      channel.pan.set(mix.pan, this.context);
    }
  }

  private createChannels(): void {
    const context = this.ensureContext();
    const master = this.ensureMasterGain(context);
    this.disconnectChannels();
    for (const id of this.buffers.keys()) {
      const gain = context.createGain();
      gain.gain.value = 1;
      const pan = createPanController(context);
      gain.connect(pan.node).connect(master);
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

  private stopEverySource(when: number): void {
    for (const source of this.liveSources) this.stopAndDisconnect(source, when);
    this.liveSources.clear();
    this.currentSources = [];
    this.remainingSources = 0;
  }

  private stopAndDisconnect(source: AudioBufferSourceNode, when: number): void {
    source.onended = null;
    try {
      source.stop(when);
    } catch {
      // stop() throws after a source has already ended.
    }
    source.disconnect();
    this.liveSources.delete(source);
  }

  private clearLoadedAudio(): void {
    if (this.context) this.stopEverySource(this.context.currentTime);
    else {
      this.liveSources.clear();
      this.currentSources = [];
      this.remainingSources = 0;
    }
    this.disconnectChannels();
    this.buffers.clear();
    this.durationSeconds = 0;
    this.anchorPosition = 0;
    this.anchorContextTime = this.context?.currentTime ?? 0;
  }

  private reportLoadProgress(
    progress: StemLoadProgress,
    callback?: (progress: StemLoadProgress) => void,
  ): void {
    this.loadProgressValue = progress;
    callback?.({ ...progress });
    this.emit();
  }

  private emit(): void {
    if (!this.listeners.size) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
