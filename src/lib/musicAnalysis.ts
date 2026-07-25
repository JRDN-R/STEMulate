import type {
  BeatEvent,
  ChordEvent,
  SectionEvent,
} from "../types";

function asList(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pickNumber(record: Record<string, unknown>, keys: string[], fallback = 0) {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function pickText(record: Record<string, unknown>, keys: string[]): string | null {
  const fields = new Map(
    Object.entries(record).map(([key, value]) => [normalizedFieldName(key), value]),
  );
  for (const key of keys) {
    const value = fields.get(normalizedFieldName(key));
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

export function normalizeBeats(value: unknown): BeatEvent[] {
  return asList(value, ["beats", "beatMap", "annotations"])
    .map((entry, index) => {
      const record = asRecord(entry);
      if (!record) return null;
      return {
        time: pickNumber(record, ["time", "start", "startTime"], 0),
        beat: pickNumber(
          record,
          ["beat", "beatNum", "beatNumber", "number"],
          (index % 4) + 1,
        ),
      };
    })
    .filter((entry): entry is BeatEvent => entry !== null && entry.time >= 0)
    .sort((a, b) => a.time - b.time);
}

const CHORD_LABEL_FIELDS = [
  "chord_simple_pop",
  "chord_complex_pop",
  "chord_simple_jazz",
  "chord_complex_jazz",
  "chord_majmin",
  // Legacy/custom workflow aliases retained for backward compatibility.
  "simplePop",
  "complexPop",
  "simpleJazz",
  "complexJazz",
  "majmin",
  "chord",
  "label",
  "value",
];

export function normalizeChords(value: unknown): ChordEvent[] {
  return asList(value, ["chords", "chordMap", "annotations"])
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) return null;
      const chord = pickText(record, CHORD_LABEL_FIELDS);
      if (!chord) return null;
      return {
        chord,
        start: pickNumber(record, ["start", "startTime", "time"], 0),
        end: pickNumber(record, ["end", "endTime"], 0),
      };
    })
    .filter((entry): entry is ChordEvent =>
      entry !== null && entry.end > entry.start
    )
    .sort((a, b) => a.start - b.start);
}

export function normalizeSections(value: unknown): SectionEvent[] {
  return asList(value, ["sections", "sectionsMap", "annotations"])
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) return null;
      return {
        label: String(record.label || record.section || record.name || "Section"),
        start: pickNumber(record, ["start", "startTime", "time"], 0),
        end: pickNumber(record, ["end", "endTime"], 0),
      };
    })
    .filter((entry): entry is SectionEvent =>
      entry !== null && entry.end > entry.start
    )
    .sort((a, b) => a.start - b.start);
}
