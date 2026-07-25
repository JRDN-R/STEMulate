import {
  AUDIO_STEM_IDS,
  createStemState,
  type AudioStemId,
  type StemSources,
  type StemState,
} from "./stems.ts";

export const STEM_SELECTION_STORAGE_KEY = "stemulate.stem-selection.v1";

export const STEM_SELECTION_PRESET_IDS = ["4", "5", "6", "7", "full"] as const;

export type StemSelectionPresetId = (typeof STEM_SELECTION_PRESET_IDS)[number];
export type StemSelectionMode = StemSelectionPresetId | "custom";

export type StemSelection = {
  mode: StemSelectionMode;
  stemIds: AudioStemId[];
};

export type StemSelectionPreset = {
  id: StemSelectionPresetId;
  label: string;
  description: string;
  stemIds: readonly AudioStemId[];
};

const PRESET_STEM_IDS: Record<StemSelectionPresetId, readonly AudioStemId[]> = {
  "4": ["vocals", "drums", "bass", "other"],
  "5": ["vocals", "drums", "bass", "guitars", "other"],
  "6": ["vocals", "drums", "bass", "guitars", "piano", "other"],
  "7": ["vocals", "drums", "bass", "guitars", "piano", "keys", "other"],
  full: AUDIO_STEM_IDS,
};

export const STEM_SELECTION_PRESETS: readonly StemSelectionPreset[] = [
  {
    id: "4",
    label: "4 stems",
    description: "Vocals, drums, bass, and the remaining instruments.",
    stemIds: PRESET_STEM_IDS["4"],
  },
  {
    id: "5",
    label: "5 stems",
    description: "Adds a dedicated guitars channel.",
    stemIds: PRESET_STEM_IDS["5"],
  },
  {
    id: "6",
    label: "6 stems",
    description: "Adds dedicated guitars and piano channels.",
    stemIds: PRESET_STEM_IDS["6"],
  },
  {
    id: "7",
    label: "7 stems",
    description: "Adds guitars, piano, and keys.",
    stemIds: PRESET_STEM_IDS["7"],
  },
  {
    id: "full",
    label: "Full",
    description: "Uses every supported STEMulate output.",
    stemIds: PRESET_STEM_IDS.full,
  },
];

const AUDIO_STEM_ID_SET = new Set<string>(AUDIO_STEM_IDS);

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function isAudioStemId(value: unknown): value is AudioStemId {
  return typeof value === "string" && AUDIO_STEM_ID_SET.has(value);
}

function uniqueStemIds(value: unknown): AudioStemId[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<AudioStemId>();
  const stemIds: AudioStemId[] = [];
  for (const item of value) {
    if (!isAudioStemId(item) || seen.has(item)) continue;
    seen.add(item);
    stemIds.push(item);
  }
  return stemIds;
}

function sameStemOrder(
  left: readonly AudioStemId[],
  right: readonly AudioStemId[],
): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function stemSelectionModeFor(stemIds: readonly AudioStemId[]): StemSelectionMode {
  const preset = STEM_SELECTION_PRESET_IDS.find((id) =>
    sameStemOrder(stemIds, PRESET_STEM_IDS[id]),
  );
  return preset ?? "custom";
}

export function stemSelectionForPreset(presetId: StemSelectionPresetId): StemSelection {
  return {
    mode: presetId,
    stemIds: [...PRESET_STEM_IDS[presetId]],
  };
}

export const DEFAULT_STEM_SELECTION: StemSelection = stemSelectionForPreset("4");

/**
 * Treats saved selection data as untrusted. Only the nine fixed output IDs
 * understood by STEMulate survive; unknown workflow/output names are dropped.
 */
export function normalizeStemSelection(
  value: unknown,
  fallback: StemSelection = DEFAULT_STEM_SELECTION,
): StemSelection {
  const rawStemIds = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? (value as { stemIds?: unknown }).stemIds
      : undefined;
  const stemIds = uniqueStemIds(rawStemIds);
  if (stemIds.length === 0) {
    return {
      mode: fallback.mode,
      stemIds: [...fallback.stemIds],
    };
  }
  return {
    mode: stemSelectionModeFor(stemIds),
    stemIds,
  };
}

export function toggleStemSelection(
  selection: StemSelection,
  stemId: AudioStemId,
): StemSelection {
  const current = normalizeStemSelection(selection);
  const selected = current.stemIds.includes(stemId);
  if (selected && current.stemIds.length === 1) return current;
  const stemIds = selected
    ? current.stemIds.filter((id) => id !== stemId)
    : [...current.stemIds, stemId];
  return {
    mode: stemSelectionModeFor(stemIds),
    stemIds,
  };
}

export function reorderStemSelection(
  selection: StemSelection,
  fromIndex: number,
  toIndex: number,
): StemSelection {
  const current = normalizeStemSelection(selection);
  if (
    !Number.isInteger(fromIndex)
    || !Number.isInteger(toIndex)
    || fromIndex < 0
    || toIndex < 0
    || fromIndex >= current.stemIds.length
    || toIndex >= current.stemIds.length
    || fromIndex === toIndex
  ) {
    return current;
  }
  const stemIds = [...current.stemIds];
  const [moved] = stemIds.splice(fromIndex, 1);
  stemIds.splice(toIndex, 0, moved);
  return {
    mode: stemSelectionModeFor(stemIds),
    stemIds,
  };
}

export function moveStemSelection(
  selection: StemSelection,
  stemId: AudioStemId,
  direction: -1 | 1,
): StemSelection {
  const current = normalizeStemSelection(selection);
  const fromIndex = current.stemIds.indexOf(stemId);
  return reorderStemSelection(current, fromIndex, fromIndex + direction);
}

/**
 * Produces the exact ordered source subset the mixer should instantiate.
 * Selection stays a local presentation preference; no Music.ai workflow slug
 * or arbitrary output name is accepted or sent to the backend.
 */
export function selectStemSources(
  sources: StemSources,
  selection: StemSelection,
): StemSources {
  const current = normalizeStemSelection(selection);
  const selected: StemSources = {};
  for (const stemId of current.stemIds) {
    const source = sources[stemId];
    if (source) selected[stemId] = source;
  }
  return selected;
}

/**
 * Creates ordered mixer rows while preserving existing fader/mute/solo state.
 * Before outputs arrive, selected channels remain visible as demo channels.
 * Once outputs exist, selected channels absent from the result are omitted.
 */
export function stemStatesForSelection(
  sources: StemSources,
  selection: StemSelection,
  previous: readonly StemState[] = [],
): StemState[] {
  const current = normalizeStemSelection(selection);
  const hasOutputs = AUDIO_STEM_IDS.some((id) => Boolean(sources[id]));
  const visibleAudioIds = hasOutputs
    ? current.stemIds.filter((id) => Boolean(sources[id]))
    : current.stemIds;
  const previousById = new Map(previous.map((stem) => [stem.id, stem]));
  return [...visibleAudioIds, "metronome" as const].map((id) =>
    previousById.get(id) ?? createStemState(id),
  );
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadStemSelection(
  storage: StorageLike | null = browserStorage(),
): StemSelection {
  if (!storage) return stemSelectionForPreset("4");
  try {
    return normalizeStemSelection(JSON.parse(storage.getItem(STEM_SELECTION_STORAGE_KEY) || "null"));
  } catch {
    return stemSelectionForPreset("4");
  }
}

export function saveStemSelection(
  selection: StemSelection,
  storage: StorageLike | null = browserStorage(),
): StemSelection {
  const normalized = normalizeStemSelection(selection);
  if (!storage) return normalized;
  try {
    storage.setItem(STEM_SELECTION_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Storage can be unavailable in private browsing. The caller still gets
    // the normalized in-memory preference.
  }
  return normalized;
}
