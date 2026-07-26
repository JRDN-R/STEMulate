import assert from "node:assert/strict";
import test from "node:test";

import { AUDIO_STEM_IDS, initialStemStates } from "../src/lib/stems.ts";
import { StreamingStemTransport } from "../src/lib/streamingStemTransport.ts";

class FakeAudioParam {
  value = 0;

  events = [];

  cancelScheduledValues(time) {
    this.events.push(["cancel", time]);
  }

  setTargetAtTime(value, time, constant) {
    this.value = value;
    this.events.push(["target", value, time, constant]);
  }

  setValueAtTime(value, time) {
    this.value = value;
    this.events.push(["value", value, time]);
  }
}

class FakeNode {
  connections = [];

  connect(node) {
    this.connections.push(node);
    return node;
  }

  disconnect() {
    this.connections = [];
  }
}

class FakeGainNode extends FakeNode {
  gain = new FakeAudioParam();
}

class FakePannerNode extends FakeNode {
  pan = new FakeAudioParam();
}

class FakeAudioBuffer {
  constructor(numberOfChannels, length, sampleRate) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length),
    );
  }

  copyToChannel(source, channel) {
    this.channels[channel].set(source);
  }
}

class FakeSource extends FakeNode {
  buffer = null;

  playbackRate = new FakeAudioParam();

  onended = null;

  starts = [];

  stops = [];

  start(...args) {
    this.starts.push(args);
  }

  stop(when = 0) {
    this.stops.push(when);
  }
}

class FakeAudioContext {
  currentTime = 0;

  state = "suspended";

  sampleRate = 8_000;

  destination = new FakeNode();

  sources = [];

  gains = [];

  panners = [];

  listeners = new Map();

  resumeCount = 0;

  closeCount = 0;

  createGain() {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  createStereoPanner() {
    const node = new FakePannerNode();
    this.panners.push(node);
    return node;
  }

  createBuffer(numberOfChannels, length, sampleRate) {
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate);
  }

  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  async resume() {
    this.resumeCount += 1;
    this.state = "running";
    this.dispatch("statechange");
  }

  async close() {
    this.closeCount += 1;
    this.state = "closed";
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

class FakeDecoder {
  calls = [];

  cancelled = [];

  disposed = false;

  failStem = null;

  deferred = null;

  async decode(request, signal) {
    this.calls.push(request);
    if (this.deferred) await this.deferred;
    if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
    if (request.stemId === this.failStem) {
      throw new Error(`could not decode ${request.stemId}`);
    }
    return {
      stemId: request.stemId,
      startFrame: request.window.startFrame,
      frameCount: request.window.frameCount,
      sampleRate: request.sampleRate,
      channels: Array.from(
        { length: request.source.channels },
        () => new Float32Array(request.window.frameCount),
      ),
    };
  }

  cancelGeneration(generation) {
    this.cancelled.push(generation);
  }

  dispose() {
    this.disposed = true;
  }
}

function deck({
  windows = 4,
  channels = 1,
  stemIds = ["vocals", "drums"],
} = {}) {
  const frameWindows = Array.from({ length: windows }, (_, index) => ({
    startFrame: index * 8_000,
    frameCount: 8_000,
    prerollByteStart: index * 1_000,
    byteStart: index * 1_000,
    byteEndExclusive: (index + 1) * 1_000,
  }));
  const source = (id) => ({
    url: `https://media.test/${id}.aac`,
    channels,
    sizeBytes: windows * 1_000,
    windows: frameWindows.map((window) => ({ ...window })),
  });
  return {
    version: 1,
    codec: "audio/wav",
    bitstream: "pcm-range",
    sampleRate: 8_000,
    packetFrames: 1,
    durationFrames: windows * 8_000,
    stems: Object.fromEntries(stemIds.map((id) => [id, source(id)])),
  };
}

function transportOptions(context, decoder, overrides = {}) {
  return {
    context,
    decoder,
    prebufferSeconds: 0.9,
    scheduleHorizonSeconds: 0.9,
    scheduleAheadSeconds: 0,
    setTimer: () => 1,
    clearTimer: () => {},
    ...overrides,
  };
}

test("schedules every decoded stem on one exact AudioContext timestamp", async () => {
  const context = new FakeAudioContext();
  const decoder = new FakeDecoder();
  const transport = new StreamingStemTransport(transportOptions(context, decoder));

  const result = await transport.load(deck());
  transport.setMix(initialStemStates());
  await transport.play();

  assert.deepEqual(result, {
    duration: 4,
    loadedStemIds: ["vocals", "drums"],
  });
  assert.equal(context.sources.length, 2);
  assert.deepEqual(context.sources.map((source) => source.starts[0]), [
    [0, 0, 1],
    [0, 0, 1],
  ]);
  assert.equal(transport.getSnapshot().status, "playing");
});

test("does not admit or schedule a window until every stem decodes", async () => {
  const context = new FakeAudioContext();
  const decoder = new FakeDecoder();
  let release;
  decoder.deferred = new Promise((resolve) => {
    release = resolve;
  });
  decoder.failStem = "drums";
  const transport = new StreamingStemTransport(transportOptions(context, decoder));

  const loading = transport.load(deck());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(transport.getSnapshot().decodedBytes, 0);
  assert.deepEqual(transport.getSnapshot().buffered, []);
  assert.equal(context.sources.length, 0);

  release();
  await assert.rejects(loading, /could not decode drums/);
  assert.equal(transport.getSnapshot().decodedBytes, 0);
  assert.deepEqual(transport.getSnapshot().buffered, []);
});

test("evicts inactive common windows to enforce the decoded-memory bound", async () => {
  const context = new FakeAudioContext();
  const decoder = new FakeDecoder();
  const oneWindowBytes = 2 * 8_000 * Float32Array.BYTES_PER_ELEMENT;
  const transport = new StreamingStemTransport(transportOptions(context, decoder, {
    maxDecodedBytes: oneWindowBytes,
  }));

  await transport.load(deck());
  assert.deepEqual(transport.getSnapshot().buffered, [{ start: 0, end: 1 }]);

  transport.seek(2);
  await transport.play();

  assert.deepEqual(transport.getSnapshot().buffered, [{ start: 2, end: 3 }]);
  assert.equal(transport.getSnapshot().decodedBytes, oneWindowBytes);
  assert.equal(context.sources.at(-1).starts[0][0], context.currentTime);
});

test("stops all-stem prebuffering at cache capacity without failing playback", async () => {
  const context = new FakeAudioContext();
  const decoder = new FakeDecoder();
  const oneWindowBytes = (
    AUDIO_STEM_IDS.length
    * 2
    * 8_000
    * Float32Array.BYTES_PER_ELEMENT
  );
  const maxDecodedBytes = oneWindowBytes * 3;
  const transport = new StreamingStemTransport(transportOptions(context, decoder, {
    maxDecodedBytes,
    prebufferSeconds: 1.9,
    scheduleHorizonSeconds: 2,
  }));

  await transport.load(deck({
    windows: 6,
    channels: 2,
    stemIds: AUDIO_STEM_IDS,
  }));
  await transport.play();
  await transport.prebuffer(2);

  assert.ok(transport.getSnapshot().decodedBytes <= maxDecodedBytes);
  assert.notEqual(transport.getSnapshot().status, "error");
  assert.equal(transport.getSnapshot().loadedStemIds.length, AUDIO_STEM_IDS.length);
});

test("seek, loop, and rate changes restart all stems at a shared handoff", async () => {
  const context = new FakeAudioContext();
  const decoder = new FakeDecoder();
  const transport = new StreamingStemTransport(transportOptions(context, decoder, {
    prebufferSeconds: 4,
    scheduleHorizonSeconds: 4,
  }));
  await transport.load(deck());
  await transport.play();

  context.currentTime = 0.25;
  assert.equal(transport.getCurrentTime(), 0.25);
  transport.setPlaybackRate(2);
  context.currentTime = 0.75;
  assert.equal(transport.getCurrentTime(), 1.25);

  transport.setLoop({ enabled: true, start: 0.5, end: 1.5 });
  const sourceCountBeforeSeek = context.sources.length;
  transport.seek(1.4);
  const newest = context.sources.slice(sourceCountBeforeSeek);
  assert.equal(newest[0].starts[0][0], newest[1].starts[0][0]);
  assert.ok(Math.abs(newest[0].starts[0][1] - 0.4) < 1e-9);
  assert.equal(transport.getSnapshot().loop.enabled, true);
  assert.equal(transport.getSnapshot().playbackRate, 2);
});

test("rate and loop changes advance the old clock through a nonzero handoff lead", async () => {
  const context = new FakeAudioContext();
  const decoder = new FakeDecoder();
  const scheduleAheadSeconds = 0.025;
  const transport = new StreamingStemTransport(transportOptions(context, decoder, {
    prebufferSeconds: 4,
    scheduleHorizonSeconds: 4,
    scheduleAheadSeconds,
  }));
  await transport.load(deck());
  await transport.play();

  context.currentTime = 0.25;
  const beforeRate = context.sources.length;
  transport.setPlaybackRate(2);
  const rateSources = context.sources.slice(beforeRate);
  assert.ok(rateSources.length >= 2);
  assert.ok(rateSources.slice(0, 2).every(
    (source) => Math.abs(source.starts[0][0] - 0.275) < 1e-9,
  ));
  assert.ok(rateSources.slice(0, 2).every(
    (source) => Math.abs(source.starts[0][1] - 0.25) < 1e-9,
  ));

  context.currentTime = 0.5;
  const beforeLoop = context.sources.length;
  transport.setLoop({ enabled: true, start: 0.25, end: 1.5 });
  const loopSources = context.sources.slice(beforeLoop);
  // The old 2x clock advances from 0.7 at t=.5 to 0.75 at the t=.525
  // handoff. Restarting from the earlier sample would repeat 50 ms of media.
  assert.ok(loopSources.length >= 2);
  assert.ok(loopSources.slice(0, 2).every(
    (source) => Math.abs(source.starts[0][0] - 0.525) < 1e-9,
  ));
  assert.ok(loopSources.slice(0, 2).every(
    (source) => Math.abs(source.starts[0][1] - 0.75) < 1e-9,
  ));
});

test("cancels stale decode generations and disposes injected resources safely", async () => {
  const context = new FakeAudioContext();
  const decoder = new FakeDecoder();
  const transport = new StreamingStemTransport(transportOptions(context, decoder));

  await transport.load(deck());
  await transport.play();
  transport.seek(3);

  assert.ok(decoder.cancelled.length >= 2);
  transport.dispose();
  assert.equal(transport.getSnapshot().status, "disposed");
  assert.equal(decoder.disposed, false);
  assert.equal(context.closeCount, 0);
});
