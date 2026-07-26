import type {
  AudioStemId,
  StemId,
  StemSources,
  StemState,
} from "./lib/stems";
import type { SavedMixerSettingsV1 } from "./lib/mixerSettings";

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
export type {
  MixerChannelSettings,
  RestoredMixerSettings,
  SavedMixerSettingsV1,
} from "./lib/mixerSettings";

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

export type CompletedJobResult = {
  analysis: AnalysisData;
  jobId: string;
  outputsExpireAt: number;
  displayName?: string;
  sourceProvider?: RemoteSourceProvider;
  mixerSettings?: SavedMixerSettingsV1 | null;
};

export type RemoteTrackResult = CompletedJobResult & {
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
