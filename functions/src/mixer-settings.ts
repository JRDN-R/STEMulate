export const MIXER_SETTINGS_VERSION = 1 as const;

const AUDIO_STEM_IDS = [
  "vocals",
  "drums",
  "kick",
  "snare",
  "toms",
  "hi_hat",
  "cymbals",
  "bass",
  "guitars",
  "piano",
  "keys",
  "strings",
  "wind",
  "other",
] as const;
const STEM_IDS = [...AUDIO_STEM_IDS, "metronome"] as const;

type AudioStemId = (typeof AUDIO_STEM_IDS)[number];
type StemId = (typeof STEM_IDS)[number];

export interface MixerChannelSettings {
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
}

export interface SavedMixerSettingsV1 {
  version: typeof MIXER_SETTINGS_VERSION;
  stemIds: AudioStemId[];
  channels: Partial<Record<StemId, MixerChannelSettings>>;
}

const AUDIO_STEM_ID_SET = new Set<string>(AUDIO_STEM_IDS);
const STEM_ID_SET = new Set<string>(STEM_IDS);
const DRUM_PART_STEM_ID_SET = new Set<string>([
  "kick",
  "snare",
  "toms",
  "hi_hat",
  "cymbals",
]);
const ROOT_KEYS = new Set(["version", "stemIds", "channels"]);
const CHANNEL_KEYS = new Set(["volume", "pan", "muted", "solo"]);

export class MixerSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MixerSettingsValidationError";
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MixerSettingsValidationError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new MixerSettingsValidationError(`${field} contains unsupported fields.`);
  }
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new MixerSettingsValidationError(
      `${field} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

/**
 * Builds a small canonical object instead of forwarding callable input into
 * Firestore. Only the fixed mixer controls understood by this deployment pass.
 */
export function normalizeMixerSettingsInput(value: unknown): SavedMixerSettingsV1 {
  const root = record(value, "mixerSettings");
  exactKeys(root, ROOT_KEYS, "mixerSettings");
  if (root.version !== MIXER_SETTINGS_VERSION) {
    throw new MixerSettingsValidationError("mixerSettings.version is unsupported.");
  }
  if (!Array.isArray(root.stemIds) || root.stemIds.length < 1) {
    throw new MixerSettingsValidationError("mixerSettings.stemIds must not be empty.");
  }
  if (root.stemIds.length > AUDIO_STEM_IDS.length) {
    throw new MixerSettingsValidationError("mixerSettings.stemIds contains too many channels.");
  }

  const seen = new Set<AudioStemId>();
  const stemIds: AudioStemId[] = [];
  for (const value of root.stemIds) {
    if (typeof value !== "string" || !AUDIO_STEM_ID_SET.has(value)) {
      throw new MixerSettingsValidationError("mixerSettings.stemIds contains an unsupported channel.");
    }
    const stemId = value as AudioStemId;
    if (seen.has(stemId)) {
      throw new MixerSettingsValidationError("mixerSettings.stemIds contains a duplicate channel.");
    }
    seen.add(stemId);
    stemIds.push(stemId);
  }
  if (
    seen.has("drums")
    && stemIds.some((stemId) => DRUM_PART_STEM_ID_SET.has(stemId))
  ) {
    throw new MixerSettingsValidationError(
      "mixerSettings.stemIds cannot combine drums with individual drum parts.",
    );
  }

  const rawChannels = record(root.channels, "mixerSettings.channels");
  if (Object.keys(rawChannels).length > STEM_IDS.length) {
    throw new MixerSettingsValidationError("mixerSettings.channels contains too many channels.");
  }
  if (Object.keys(rawChannels).some((key) => !STEM_ID_SET.has(key))) {
    throw new MixerSettingsValidationError("mixerSettings.channels contains an unsupported channel.");
  }

  const channels: Partial<Record<StemId, MixerChannelSettings>> = {};
  for (const stemId of STEM_IDS) {
    if (!(stemId in rawChannels)) continue;
    const rawChannel = record(
      rawChannels[stemId],
      `mixerSettings.channels.${stemId}`,
    );
    exactKeys(rawChannel, CHANNEL_KEYS, `mixerSettings.channels.${stemId}`);
    if (
      typeof rawChannel.muted !== "boolean"
      || typeof rawChannel.solo !== "boolean"
    ) {
      throw new MixerSettingsValidationError(
        `mixerSettings.channels.${stemId} mute and solo values must be booleans.`,
      );
    }
    channels[stemId] = {
      volume: boundedInteger(
        rawChannel.volume,
        0,
        100,
        `mixerSettings.channels.${stemId}.volume`,
      ),
      pan: boundedInteger(
        rawChannel.pan,
        -100,
        100,
        `mixerSettings.channels.${stemId}.pan`,
      ),
      muted: rawChannel.muted,
      solo: rawChannel.solo,
    };
  }

  return {
    version: MIXER_SETTINGS_VERSION,
    stemIds,
    channels,
  };
}
