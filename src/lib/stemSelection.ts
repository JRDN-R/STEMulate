import {
  AUDIO_STEM_IDS,
  DRUM_PART_STEM_IDS,
  createStemState,
  type AudioStemId,
  type DrumPartStemId,
  type StemSources,
  type StemState,
} from "./stems.ts";

export const STEM_SELECTION_STORAGE_KEY = "stemulate.stem-selection.v1";

export const STEM_SELECTION_PRESET_IDS = [
  "4",
  "5",
  "6",
  "7",
  "drum-parts",
  "full",
] as const;

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
  "drum-parts": ["vocals", ...DRUM_PART_STEM_IDS, "bass", "other"],
  full: [
    "vocals",
    ...DRUM_PART_STEM_IDS,
    "bass",
    "guitars",
    "piano",
    "keys",
    "strings",
    "wind",
    "other",
  ],
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
    id: "drum-parts",
    label: "Drum parts",
    description: "Replaces the combined drums channel with separate kit pieces.",
    stemIds: PRESET_STEM_IDS["drum-parts"],
  },
  {
    id: "full",
    label: "Full",
    description: "Uses every supported instrument without doubling the drum kit.",
    stemIds: PRESET_STEM_IDS.full,
  },
];

const AUDIO_STEM_ID_SET = new Set<string>(AUDIO_STEM_IDS);
const DRUM_PART_STEM_ID_SET = new Set<string>(DRUM_PART_STEM_IDS);

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function isAudioStemId(value: unknown): value is AudioStemId {
  return typeof value === "string" && AUDIO_STEM_ID_SET.has(value);
}

function isDrumPartStemId(value: AudioStemId): value is DrumPartStemId {
  return DRUM_PART_STEM_ID_SET.has(value);
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
  // A complete drum stem and its component stems contain the same material.
  // Prefer the more specific component choice when persisted data contains both.
  return stemIds.some(isDrumPartStemId)
    ? stemIds.filter((id) => id !== "drums")
    : stemIds;
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
 * Treats saved selection data as untrusted. Only fixed output IDs
 * understood by STEMulate survive; unknown workflow/output names are dropped.
 * Aggregate drums and drum parts are mutually exclusive to prevent doubling.
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
  let stemIds: AudioStemId[];
  if (selected) {
    stemIds = current.stemIds.filter((id) => id !== stemId);
  } else if (stemId === "drums") {
    const firstPartIndex = current.stemIds.findIndex(isDrumPartStemId);
    stemIds = current.stemIds.filter((id) => !isDrumPartStemId(id));
    stemIds.splice(
      firstPartIndex < 0 ? stemIds.length : Math.min(firstPartIndex, stemIds.length),
      0,
      "drums",
    );
  } else if (isDrumPartStemId(stemId)) {
    const aggregateIndex = current.stemIds.indexOf("drums");
    stemIds = current.stemIds.filter((id) => id !== "drums");
    if (aggregateIndex >= 0) {
      stemIds.splice(Math.min(aggregateIndex, stemIds.length), 0, stemId);
    } else {
      const lastPartIndex = stemIds.reduce(
        (last, id, index) => isDrumPartStemId(id) ? index : last,
        -1,
      );
      stemIds.splice(lastPartIndex < 0 ? stemIds.length : lastPartIndex + 1, 0, stemId);
    }
  } else {
    stemIds = [...current.stemIds, stemId];
  }
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
  for (const stemId of resolvedStemIds(sources, current)) {
    const source = sources[stemId];
    if (source) selected[stemId] = source;
  }
  return selected;
}

/**
 * Resolves the two interchangeable drum representations against one result.
 * A component layout falls back to aggregate drums for older jobs. Conversely,
 * an aggregate-drums layout expands to available parts when a workflow returns
 * only the component stems.
 */
function resolvedStemIds(
  sources: StemSources,
  selection: StemSelection,
): AudioStemId[] {
  const current = normalizeStemSelection(selection);
  const selectedParts = current.stemIds.filter(isDrumPartStemId);
  const availableSelectedParts = selectedParts.filter((id) => Boolean(sources[id]));
  const availableParts = DRUM_PART_STEM_IDS.filter((id) => Boolean(sources[id]));
  const allSelectedPartsAvailable = selectedParts.length > 0
    && availableSelectedParts.length === selectedParts.length;
  const resolved: AudioStemId[] = [];
  const add = (id: AudioStemId) => {
    if (!resolved.includes(id)) resolved.push(id);
  };

  for (const id of current.stemIds) {
    if (id === "drums") {
      if (sources.drums) add("drums");
      else availableParts.forEach((partId) => add(partId));
      continue;
    }
    if (isDrumPartStemId(id)) {
      if (allSelectedPartsAvailable) {
        if (sources[id]) add(id);
      } else if (sources.drums) {
        add("drums");
      } else if (sources[id]) {
        add(id);
      }
      continue;
    }
    if (sources[id]) add(id);
  }
  return resolved;
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
    ? resolvedStemIds(sources, current)
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
