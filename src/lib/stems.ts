export const AUDIO_STEM_IDS = [
  "vocals",
  "drums",
  "bass",
  "guitars",
  "piano",
  "keys",
  "strings",
  "wind",
  "other",
] as const;

export type AudioStemId = (typeof AUDIO_STEM_IDS)[number];
export type StemId = AudioStemId | "metronome";
export type StemSources = Partial<Record<AudioStemId, string>>;

export type StemState = {
  id: StemId;
  label: string;
  shortLabel: string;
  volume: number;
  muted: boolean;
  solo: boolean;
  color: string;
};

type StemPresentation = Omit<StemState, "id" | "volume" | "muted" | "solo"> & {
  volume: number;
};

const STEM_PRESENTATION: Record<StemId, StemPresentation> = {
  vocals: { label: "Vocals", shortLabel: "VOX", volume: 84, color: "#ff625c" },
  drums: { label: "Drums", shortLabel: "DRM", volume: 78, color: "#55e4dc" },
  bass: { label: "Bass", shortLabel: "BAS", volume: 72, color: "#7dd8ff" },
  guitars: { label: "Guitars", shortLabel: "GTR", volume: 72, color: "#ff9f68" },
  piano: { label: "Piano", shortLabel: "PNO", volume: 70, color: "#f0d58a" },
  keys: { label: "Keys", shortLabel: "KEY", volume: 70, color: "#a8e6a3" },
  strings: { label: "Strings", shortLabel: "STR", volume: 68, color: "#d8a7ff" },
  wind: { label: "Wind", shortLabel: "WND", volume: 68, color: "#8fdde7" },
  other: { label: "Other", shortLabel: "OTH", volume: 68, color: "#b7a2ff" },
  metronome: { label: "Smart click", shortLabel: "CLK", volume: 62, color: "#ffd166" },
};

const DEFAULT_AUDIO_STEMS: readonly AudioStemId[] = ["vocals", "drums", "bass", "other"];

const STEM_ALIASES: ReadonlyArray<readonly [AudioStemId, readonly string[]]> = [
  ["vocals", ["vocals", "vocal", "voice", "voices"]],
  ["drums", ["drums", "drum", "percussion"]],
  ["bass", ["bass"]],
  ["guitars", ["guitars", "guitar"]],
  ["piano", ["piano"]],
  ["keys", ["keys", "keyboard", "keyboards"]],
  ["strings", ["strings", "string"]],
  ["wind", ["wind", "winds", "woodwind", "woodwinds", "brass"]],
  ["other", ["other", "instrumental", "instruments", "accompaniment", "accompaniments"]],
];

const ORIGINAL_ALIASES = new Set(["original", "mixture", "mix", "source"]);

function makeStemState(id: StemId): StemState {
  return {
    id,
    ...STEM_PRESENTATION[id],
    muted: false,
    solo: false,
  };
}

export function initialStemStates(): StemState[] {
  const visibleIds: readonly StemId[] = [...DEFAULT_AUDIO_STEMS, "metronome"];
  return visibleIds.map(makeStemState);
}

export function isAudioStemId(id: StemId): id is AudioStemId {
  return id !== "metronome";
}

/**
 * Builds the visible mixer from the stems returned by Music.ai. Existing
 * fader/mute/solo state is retained for matching channels. With no remote
 * stems, the compact legacy four-channel demo mixer remains visible.
 */
export function stemStatesFor(
  sources: StemSources,
  previous: readonly StemState[] = [],
): StemState[] {
  const available = AUDIO_STEM_IDS.filter((id) => Boolean(sources[id]));
  const visibleIds: readonly StemId[] = available.length
    ? [...available, "metronome"]
    : [...DEFAULT_AUDIO_STEMS, "metronome"];
  const previousById = new Map(previous.map((stem) => [stem.id, stem]));
  return visibleIds.map((id) => previousById.get(id) ?? makeStemState(id));
}

function normalizedTokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function stemIdFromHint(hint: string): AudioStemId | null {
  const tokens = normalizedTokens(hint);
  for (const [stemId, aliases] of STEM_ALIASES) {
    if (aliases.some((alias) => tokens.includes(alias))) return stemId;
  }
  if (tokens.some((token) => ORIGINAL_ALIASES.has(token))) return null;
  return null;
}

/**
 * Normalizes both the current named Music.ai outputs and older four-stem
 * workflows. It also understands nested `{ name, file }` output shapes and
 * namespaced output keys by using the object path, sibling label, and URL
 * filename as hints. The redundant `original`/`mix` output is intentionally
 * ignored.
 */
export function normalizeStemOutputs(result: Record<string, unknown>): StemSources {
  const stems: StemSources = {};
  const visited = new WeakSet<object>();

  const visit = (value: unknown, path: string[], labelHint = "", depth = 0): void => {
    if (depth > 8) return;
    if (typeof value === "string") {
      if (!/^https?:\/\//i.test(value)) return;
      let pathname = "";
      try {
        pathname = new URL(value).pathname;
      } catch {
        return;
      }
      const stemId = stemIdFromHint([...path, labelHint, pathname].join(" "));
      if (stemId && !stems[stemId]) stems[stemId] = value;
      return;
    }
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)], labelHint, depth + 1));
      return;
    }

    const record = value as Record<string, unknown>;
    const siblingLabel = ["name", "label", "stem", "type"]
      .map((key) => record[key])
      .find((item): item is string => typeof item === "string" && item.length <= 80) || labelHint;
    Object.entries(record).forEach(([key, item]) => {
      visit(item, [...path, key], siblingLabel, depth + 1);
    });
  };

  visit(result, []);
  return stems;
}
