import {
  AUDIO_STEM_IDS,
  createStemState,
  type AudioStemId,
  type StemId,
  type StemSources,
  type StemState,
} from "./stems.ts";
import {
  normalizeStemSelection,
  stemStatesForSelection,
  type StemSelection,
} from "./stemSelection.ts";

export const MIXER_SETTINGS_VERSION = 1 as const;

export type MixerChannelSettings = {
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
};

export type SavedMixerSettingsV1 = {
  version: typeof MIXER_SETTINGS_VERSION;
  /** Ordered audio channels selected for this song. */
  stemIds: AudioStemId[];
  /** Only user-adjustable values are persisted; presentation and URLs are not. */
  channels: Partial<Record<StemId, MixerChannelSettings>>;
};

export type RestoredMixerSettings = {
  selection: StemSelection;
  stems: StemState[];
  saved: SavedMixerSettingsV1 | null;
};

const STEM_IDS: readonly StemId[] = [...AUDIO_STEM_IDS, "metronome"];
const AUDIO_STEM_ID_SET = new Set<string>(AUDIO_STEM_IDS);
const STEM_ID_SET = new Set<string>(STEM_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAudioStemId(value: unknown): value is AudioStemId {
  return typeof value === "string" && AUDIO_STEM_ID_SET.has(value);
}

function normalizedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function normalizeChannel(value: unknown): MixerChannelSettings | null {
  if (!isRecord(value)) return null;
  const volume = normalizedInteger(value.volume, 0, 100);
  const pan = normalizedInteger(value.pan, -100, 100);
  if (
    volume === null
    || pan === null
    || typeof value.muted !== "boolean"
    || typeof value.solo !== "boolean"
  ) {
    return null;
  }
  return {
    volume,
    pan,
    muted: value.muted,
    solo: value.solo,
  };
}

/**
 * Treats persisted settings as untrusted. Future versions are ignored, unknown
 * channel IDs are dropped, and malformed channels fall back to presentation
 * defaults when the song is restored.
 */
export function normalizeMixerSettings(value: unknown): SavedMixerSettingsV1 | null {
  if (!isRecord(value) || value.version !== MIXER_SETTINGS_VERSION) return null;
  if (!Array.isArray(value.stemIds)) return null;

  const seen = new Set<AudioStemId>();
  const stemIds: AudioStemId[] = [];
  for (const stemId of value.stemIds) {
    if (!isAudioStemId(stemId) || seen.has(stemId)) continue;
    seen.add(stemId);
    stemIds.push(stemId);
  }
  if (stemIds.length === 0) return null;

  const rawChannels = isRecord(value.channels) ? value.channels : {};
  const channels: Partial<Record<StemId, MixerChannelSettings>> = {};
  for (const stemId of STEM_IDS) {
    const channel = normalizeChannel(rawChannels[stemId]);
    if (channel) channels[stemId] = channel;
  }

  return {
    version: MIXER_SETTINGS_VERSION,
    stemIds: normalizeStemSelection(stemIds).stemIds,
    channels,
  };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

/**
 * Captures a bounded, vendor-neutral settings payload for one processing job.
 */
export function captureMixerSettings(
  stems: readonly StemState[],
  selection: StemSelection,
): SavedMixerSettingsV1 {
  const normalizedSelection = normalizeStemSelection(selection);
  const visibleById = new Map(
    stems
      .filter((stem) => STEM_ID_SET.has(stem.id))
      .map((stem) => [stem.id, stem]),
  );
  const channels: Partial<Record<StemId, MixerChannelSettings>> = {};
  for (const stemId of STEM_IDS) {
    const stem = visibleById.get(stemId);
    if (!stem) continue;
    channels[stemId] = {
      volume: clampInteger(stem.volume, 0, 100),
      pan: clampInteger(stem.pan, -100, 100),
      muted: Boolean(stem.muted),
      solo: Boolean(stem.solo),
    };
  }
  return {
    version: MIXER_SETTINGS_VERSION,
    stemIds: [...normalizedSelection.stemIds],
    channels,
  };
}

/**
 * Restores settings only onto channels the current song can display. Saved
 * channels absent from newer workflow output are ignored, while newly added
 * channels receive their current presentation defaults.
 */
export function restoreMixerSettings(
  sources: StemSources,
  fallbackSelection: StemSelection,
  value: unknown,
): RestoredMixerSettings {
  const saved = normalizeMixerSettings(value);
  const selection = saved
    ? normalizeStemSelection(saved.stemIds, fallbackSelection)
    : normalizeStemSelection(fallbackSelection);
  const stems = stemStatesForSelection(sources, selection).map((stem) => {
    const channel = saved?.channels[stem.id];
    return channel
      ? { ...stem, ...channel }
      : createStemState(stem.id);
  });
  return { selection, stems, saved };
}

export function mixerSettingsEqual(
  left: unknown,
  right: unknown,
): boolean {
  const normalizedLeft = normalizeMixerSettings(left);
  const normalizedRight = normalizeMixerSettings(right);
  if (!normalizedLeft || !normalizedRight) return normalizedLeft === normalizedRight;
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}
