import assert from "node:assert/strict";
import test from "node:test";

import { StemTransport } from "../src/lib/stemTransport.ts";
import { initialStemStates } from "../src/lib/stems.ts";

class FakeAudioParam {
  value = 0;

  events = [];

  cancelScheduledValues(time) {
    this.events.push(["cancel", time]);
  }

  setTargetAtTime(value, time, constant) {
    this.value = value;
    this.events.push(["target", value, time, constant]);
    return this;
  }

  setValueAtTime(value, time) {
    this.value = value;
    this.events.push(["value", value, time]);
    return this;
  }
}

class FakeNode {
  connections = [];

  disconnectCount = 0;

  connect(node) {
    this.connections.push(node);
    return node;
  }

  disconnect() {
    this.disconnectCount += 1;
    this.connections = [];
  }
}

class FakeGainNode extends FakeNode {
  gain = new FakeAudioParam();
}

class FakeStereoPannerNode extends FakeNode {
  pan = new FakeAudioParam();
}

class FakeDynamicsCompressorNode extends FakeNode {
  threshold = new FakeAudioParam();

  knee = new FakeAudioParam();

  ratio = new FakeAudioParam();

  attack = new FakeAudioParam();

  release = new FakeAudioParam();
}

class FakeBufferSourceNode extends FakeNode {
  buffer = null;

  playbackRate = new FakeAudioParam();

  loop = false;

  loopStart = 0;

  loopEnd = 0;

  onended = null;

  starts = [];

  stops = [];

  start(...args) {
    this.starts.push(args);
  }

  stop(when = 0) {
    this.stops.push(when);
  }

  finish() {
    this.onended?.();
  }
}

class FakeAudioContext {
  currentTime = 0;

  sampleRate = 48_000;

  state = "suspended";

  destination = new FakeNode();

  gains = [];

  panners = [];

  compressors = [];

  sources = [];

  decodeDurations = [];

  resumeCount = 0;

  closeCount = 0;

  listeners = new Map();

  createGain() {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  createStereoPanner() {
    const node = new FakeStereoPannerNode();
    this.panners.push(node);
    return node;
  }

  createDynamicsCompressor() {
    const node = new FakeDynamicsCompressorNode();
    this.compressors.push(node);
    return node;
  }

  createBufferSource() {
    const node = new FakeBufferSourceNode();
    this.sources.push(node);
    return node;
  }

  decodeAudioData(_bytes, success) {
    const duration = this.decodeDurations.shift() ?? 60;
    const buffer = {
      duration,
      length: Math.round(duration * this.sampleRate),
      numberOfChannels: 2,
      sampleRate: this.sampleRate,
    };
    success?.(buffer);
    return Promise.resolve(buffer);
  }

  async resume() {
    this.resumeCount += 1;
    this.state = "running";
    this.dispatch("statechange");
  }

  async close() {
    this.closeCount += 1;
    this.state = "closed";
    this.dispatch("statechange");
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type) {
    this.listeners.get(type)?.forEach((listener) => listener());
  }
}

class DeferredDecodeAudioContext extends FakeAudioContext {
  pendingDecodes = [];

  decodeAudioData(_bytes, success, failure) {
    return new Promise((resolve, reject) => {
      this.pendingDecodes.push({
        resolve: (duration = 60) => {
          const buffer = {
            duration,
            length: Math.round(duration * this.sampleRate),
            numberOfChannels: 2,
            sampleRate: this.sampleRate,
          };
          success?.(buffer);
          resolve(buffer);
        },
        reject: (error) => {
          failure?.(error);
          reject(error);
        },
      });
    });
  }
}

function okFetcher() {
  return async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => new ArrayBuffer(8),
  });
}

test("calls the default fetcher with the browser global as its receiver", async () => {
  const originalFetch = globalThis.fetch;
  let observedReceiver;

  globalThis.fetch = async function receiverSensitiveFetch() {
    observedReceiver = this;
    if (this !== globalThis) {
      throw new TypeError("Can only call Window.fetch on instances of Window");
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => new ArrayBuffer(8),
    };
  };

  try {
    const context = new FakeAudioContext();
    context.decodeDurations.push(30);
    const transport = new StemTransport({ context });

    await transport.load({ vocals: "/vocals.wav" });

    assert.equal(observedReceiver, globalThis);
    assert.equal(transport.getSnapshot().status, "ready");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function loadedTransport({
  context = new FakeAudioContext(),
  durations = [60, 60],
  sources = { vocals: "/vocals.wav", drums: "/drums.wav" },
} = {}) {
  context.decodeDurations.push(...durations);
  const transport = new StemTransport({
    context,
    fetcher: okFetcher(),
    scheduleAheadSeconds: 0,
    parameterRampSeconds: 0,
  });
  const result = await transport.load(sources);
  return { context, transport, result };
}

test("routes the shared output through a peak limiter", async () => {
  const { context, transport } = await loadedTransport({
    sources: { vocals: "/vocals.wav" },
    durations: [30],
  });
  const limiter = context.compressors[0];
  const output = transport.getOutputNode();

  assert.equal(output, context.gains[0]);
  assert.deepEqual(output.connections, [limiter]);
  assert.deepEqual(limiter.connections, [context.destination]);
  assert.equal(limiter.threshold.value, -3);
  assert.equal(limiter.ratio.value, 20);
});

test("loads and decodes stems sequentially, using a common safe duration", async () => {
  const context = new FakeAudioContext();
  context.decodeDurations.push(120, 119.75);
  const progress = [];
  const transport = new StemTransport({
    context,
    fetcher: okFetcher(),
    scheduleAheadSeconds: 0,
  });

  const result = await transport.load(
    { vocals: "/vocals.wav", drums: "/drums.wav" },
    { onProgress: (event) => progress.push(`${event.id}:${event.phase}`) },
  );

  assert.deepEqual(result, {
    duration: 119.75,
    loadedStemIds: ["vocals", "drums"],
  });
  assert.deepEqual(progress, [
    "vocals:fetching",
    "vocals:decoding",
    "vocals:ready",
    "drums:fetching",
    "drums:decoding",
    "drums:ready",
  ]);
  assert.equal(transport.getSnapshot().status, "ready");
});

test("cancels an in-flight load through the caller's AbortSignal", async () => {
  const context = new FakeAudioContext();
  const controller = new AbortController();
  const fetcher = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      reject(new DOMException("cancelled", "AbortError"));
    }, { once: true });
  });
  const transport = new StemTransport({ context, fetcher });

  const loading = transport.load(
    { vocals: "/vocals.wav" },
    { signal: controller.signal },
  );
  controller.abort();

  await assert.rejects(loading, { name: "AbortError" });
  assert.equal(transport.getSnapshot().status, "idle");
});

test("serializes replacement decodes after cancelling an older generation", async () => {
  const context = new DeferredDecodeAudioContext();
  const transport = new StemTransport({
    context,
    fetcher: okFetcher(),
  });

  const firstLoad = transport.load({ vocals: "/first.wav" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.pendingDecodes.length, 1);

  const secondLoad = transport.load({ drums: "/second.wav" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.pendingDecodes.length, 1);

  context.pendingDecodes.shift().resolve();
  await assert.rejects(firstLoad, { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.pendingDecodes.length, 1);

  context.pendingDecodes.shift().resolve();
  assert.deepEqual(await secondLoad, {
    duration: 60,
    loadedStemIds: ["drums"],
  });
});

test("rejects a selection before decoded PCM exceeds the configured limit", async () => {
  const context = new FakeAudioContext();
  context.decodeDurations.push(60);
  const transport = new StemTransport({
    context,
    fetcher: okFetcher(),
    maxDecodedBytes: 10 * 1024 * 1024,
  });

  await assert.rejects(
    transport.load({ vocals: "/vocals.wav" }),
    /Choose fewer stems and try again/,
  );
  assert.equal(transport.getSnapshot().status, "error");
  assert.deepEqual(transport.getSnapshot().loadedStemIds, []);
});

test("starts every stem on one AudioContext timestamp and offset", async () => {
  const { context, transport } = await loadedTransport();
  context.currentTime = 10;

  await transport.play();

  assert.equal(context.resumeCount, 1);
  assert.equal(context.sources.length, 2);
  assert.deepEqual(context.sources.map((source) => source.starts[0]), [
    [10, 0, 60],
    [10, 0, 60],
  ]);
  context.currentTime = 12.5;
  assert.equal(transport.getCurrentTime(), 2.5);
});

test("seek performs a clocked source handoff without follower correction", async () => {
  const { context, transport } = await loadedTransport();
  await transport.play();
  const firstGeneration = [...context.sources];
  context.currentTime = 5;

  transport.seek(30);

  const secondGeneration = context.sources.slice(2);
  assert.deepEqual(firstGeneration.map((source) => source.stops), [[5], [5]]);
  assert.deepEqual(secondGeneration.map((source) => source.starts[0]), [
    [5, 30, 30],
    [5, 30, 30],
  ]);
  context.currentTime = 6;
  assert.equal(transport.getCurrentTime(), 31);
});

test("changes playback rate on all live sources without losing position", async () => {
  const { context, transport } = await loadedTransport();
  await transport.play();
  context.currentTime = 2;

  transport.setPlaybackRate(1.5);

  assert.equal(transport.getCurrentTime(), 2);
  assert.ok(context.sources.every((source) =>
    source.playbackRate.events.some((event) =>
      event[0] === "value" && event[1] === 1.5 && event[2] === 2)));
  context.currentTime = 4;
  assert.equal(transport.getCurrentTime(), 5);

  transport.pause();
  context.currentTime = 8;
  assert.equal(transport.getCurrentTime(), 5);
  assert.equal(transport.getSnapshot().status, "paused");
});

test("uses identical native loop points and a loop-aware shared clock", async () => {
  const { context, transport } = await loadedTransport();
  transport.setLoop({ enabled: true, start: 5, end: 10 });
  transport.seek(9);

  await transport.play();

  assert.ok(context.sources.every((source) =>
    source.loop && source.loopStart === 5 && source.loopEnd === 10));
  assert.deepEqual(context.sources.map((source) => source.starts[0]), [
    [0, 9],
    [0, 9],
  ]);
  context.currentTime = 3;
  assert.equal(transport.getCurrentTime(), 7);
});

test("changes loop points at one future handoff without rewinding the clock lead", async () => {
  const context = new FakeAudioContext();
  context.decodeDurations.push(60, 60);
  const transport = new StemTransport({
    context,
    fetcher: okFetcher(),
    scheduleAheadSeconds: 0.1,
  });
  await transport.load({ vocals: "/vocals.wav", drums: "/drums.wav" });
  await transport.play();
  context.currentTime = 2;

  transport.setLoop({ enabled: true, start: 1, end: 10 });

  const nextGeneration = context.sources.slice(2);
  assert.deepEqual(context.sources.slice(0, 2).map((source) => source.stops), [
    [2.1],
    [2.1],
  ]);
  assert.deepEqual(nextGeneration.map((source) => source.starts[0]), [
    [2.1, 2],
    [2.1, 2],
  ]);
});

test("applies gain, pan, mute, and deck-wide solo through Web Audio nodes", async () => {
  const { context, transport } = await loadedTransport();
  const stems = initialStemStates().map((stem) => {
    if (stem.id === "vocals") return { ...stem, volume: 42, pan: -75 };
    if (stem.id === "drums") return { ...stem, solo: true, volume: 80, pan: 25 };
    return stem;
  });

  transport.setMix(stems);

  // gain[0] is the master; channel gains follow AUDIO_STEM_IDS load order.
  assert.equal(context.gains[1].gain.value, 0);
  assert.equal(context.gains[2].gain.value, 0.8);
  assert.equal(context.panners[0].pan.value, -0.75);
  assert.equal(context.panners[1].pan.value, 0.25);
});

test("fires ended only after the active source generation finishes", async () => {
  const { context, transport, result } = await loadedTransport();
  let endedCount = 0;
  transport.onEnded(() => {
    endedCount += 1;
  });
  await transport.play();

  context.sources[0].finish();
  assert.equal(endedCount, 0);
  context.sources[1].finish();

  assert.equal(endedCount, 1);
  assert.equal(transport.getCurrentTime(), result.duration);
  assert.equal(transport.getSnapshot().status, "paused");
});

test("dispose stops sources, disconnects the graph, and closes an owned context", async () => {
  const context = new FakeAudioContext();
  context.decodeDurations.push(30);
  const transport = new StemTransport({
    contextFactory: () => context,
    fetcher: okFetcher(),
    scheduleAheadSeconds: 0,
  });
  await transport.load({ vocals: "/vocals.wav" });
  await transport.play();

  transport.dispose();

  assert.equal(context.sources[0].stops.length, 1);
  assert.ok(context.sources[0].disconnectCount > 0);
  assert.equal(context.closeCount, 1);
  assert.equal(transport.getSnapshot().status, "disposed");
});
