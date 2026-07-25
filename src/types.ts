import type {
  AudioStemId,
  StemId,
  StemSources,
  StemState,
} from "./lib/stems";

export type {
  AudioStemId,
  StemId,
  StemSources,
  StemState,
} from "./lib/stems";
export type {
  StemSelection,
  StemSelectionMode,
  StemSelectionPreset,
  StemSelectionPresetId,
} from "./lib/stemSelection";

export type ChordEvent = {
  chord: string;
  start: number;
  end: number;
};

export type BeatEvent = {
  time: number;
  beat: number;
};

export type SectionEvent = {
  label: string;
  start: number;
  end: number;
};

export type AnalysisData = {
  bpm: number;
  key: string;
  beats: BeatEvent[];
  chords: ChordEvent[];
  sections: SectionEvent[];
  stems: StemSources;
};

export type RemoteSourceProvider = "youtube" | "spotify";

export type RemoteTrackResult = {
  analysis: AnalysisData;
  title: string;
  source: string;
  provider: RemoteSourceProvider;
};

export type ProcessingStage =
  | "idle"
  | "download"
  | "upload"
  | "analyze"
  | "split"
  | "ready"
  | "error";
