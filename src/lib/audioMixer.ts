import {
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
