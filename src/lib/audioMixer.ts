import {
  AUDIO_STEM_IDS,
  isAudioStemId,
  type AudioStemId,
  type StemState,
} from "./stems.ts";

export type ResolvedStemMix = {
  gain: number;
  pan: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Resolves the audible gain and normalized stereo position for every loaded
 * audio channel. Solo is evaluated across the whole deck so soloing the click
 * track correctly silences the song stems too.
 */
export function resolveStemMix(
  stems: readonly StemState[],
): Partial<Record<AudioStemId, ResolvedStemMix>> {
  const anySolo = stems.some((stem) => stem.solo);
  const result: Partial<Record<AudioStemId, ResolvedStemMix>> = {};

  for (const stem of stems) {
    if (!isAudioStemId(stem.id)) continue;
    const audible = !stem.muted && (!anySolo || stem.solo);
    result[stem.id] = {
      gain: audible ? clamp(stem.volume, 0, 100) / 100 : 0,
      pan: clamp(stem.pan, -100, 100) / 100,
    };
  }

  return result;
}

export function isStemAudible(stem: StemState, stems: readonly StemState[]): boolean {
  const anySolo = stems.some((item) => item.solo);
  return !stem.muted && (!anySolo || stem.solo);
}

type PanController = {
  node: AudioNode;
  set(value: number, context: BaseAudioContext): void;
};

function setAudioParam(param: AudioParam, value: number, context: BaseAudioContext): void {
  param.cancelScheduledValues(context.currentTime);
  param.setTargetAtTime(value, context.currentTime, 0.008);
}

/**
 * StereoPannerNode is present on current iOS Safari. PannerNode keeps the
 * channel usable on older WebKit builds instead of falling back to the
 * ineffective HTMLMediaElement.volume implementation on iOS.
 */
export function createPanController(context: BaseAudioContext): PanController {
  if (typeof context.createStereoPanner === "function") {
    const node = context.createStereoPanner();
    return {
      node,
      set: (value, targetContext) => setAudioParam(node.pan, value, targetContext),
    };
  }

  const node = context.createPanner();
  node.panningModel = "equalpower";
  node.distanceModel = "inverse";
  node.refDistance = 1;
  node.maxDistance = 1;
  node.rolloffFactor = 0;
  return {
    node,
    set: (value) => {
      const x = clamp(value, -1, 1);
      const z = Math.max(0.01, 1 - Math.abs(x));
      if (node.positionX && node.positionY && node.positionZ) {
        node.positionX.value = x;
        node.positionY.value = 0;
        node.positionZ.value = z;
      } else {
        node.setPosition(x, 0, z);
      }
    },
  };
}

type ChannelNodes = {
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  pan: PanController;
};

/**
 * Routes each independent stem through Web Audio. In particular, this avoids
 * HTMLMediaElement.volume, which iOS intentionally treats as read-only at 1.
 */
export class StemAudioGraph {
  private context: AudioContext | null = null;

  private channels = new Map<AudioStemId, ChannelNodes>();

  connect(
    context: AudioContext,
    elements: Partial<Record<AudioStemId, HTMLAudioElement>>,
  ): void {
    if (this.context && this.context !== context) this.disconnect();
    this.context = context;

    for (const id of AUDIO_STEM_IDS) {
      const element = elements[id];
      const existing = this.channels.get(id);
      if (!element) {
        if (existing) this.disconnectChannel(id, existing);
        continue;
      }
      if (existing?.element === element) continue;
      if (existing) this.disconnectChannel(id, existing);

      // The attribute must be set before the source URL is requested. App.tsx
      // does that when creating the element; assigning the property again here
      // documents and enforces the requirement for callers outside App.tsx.
      element.crossOrigin = "anonymous";
      element.volume = 1;

      const source = context.createMediaElementSource(element);
      const gain = context.createGain();
      const pan = createPanController(context);
      source.connect(gain).connect(pan.node).connect(context.destination);
      this.channels.set(id, { element, source, gain, pan });
    }
  }

  update(stems: readonly StemState[], playbackRate: number): void {
    const resolved = resolveStemMix(stems);
    const safeRate = clamp(playbackRate, 0.25, 4);

    for (const id of AUDIO_STEM_IDS) {
      const channel = this.channels.get(id);
      if (!channel || !this.context) continue;
      const mix = resolved[id] ?? { gain: 0, pan: 0 };
      channel.element.volume = 1;
      channel.element.playbackRate = safeRate;
      setAudioParam(channel.gain.gain, mix.gain, this.context);
      channel.pan.set(mix.pan, this.context);
    }
  }

  hasChannel(id: AudioStemId): boolean {
    return this.channels.has(id);
  }

  disconnect(): void {
    for (const [id, channel] of this.channels) this.disconnectChannel(id, channel);
    this.context = null;
  }

  private disconnectChannel(id: AudioStemId, channel: ChannelNodes): void {
    channel.source.disconnect();
    channel.gain.disconnect();
    channel.pan.node.disconnect();
    this.channels.delete(id);
  }
}
