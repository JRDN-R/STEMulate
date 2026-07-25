import Activity from "lucide-react/dist/esm/icons/activity.mjs";
import AudioLines from "lucide-react/dist/esm/icons/audio-lines.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import CircleHelp from "lucide-react/dist/esm/icons/circle-help.mjs";
import Cloud from "lucide-react/dist/esm/icons/cloud.mjs";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import Drum from "lucide-react/dist/esm/icons/drum.mjs";
import FolderArchive from "lucide-react/dist/esm/icons/folder-archive.mjs";
import Gauge from "lucide-react/dist/esm/icons/gauge.mjs";
import Guitar from "lucide-react/dist/esm/icons/guitar.mjs";
import Headphones from "lucide-react/dist/esm/icons/headphones.mjs";
import Import from "lucide-react/dist/esm/icons/import.mjs";
import KeyboardMusic from "lucide-react/dist/esm/icons/keyboard-music.mjs";
import Library from "lucide-react/dist/esm/icons/library.mjs";
import Link2 from "lucide-react/dist/esm/icons/link-2.mjs";
import Menu from "lucide-react/dist/esm/icons/menu.mjs";
import Mic2 from "lucide-react/dist/esm/icons/mic-2.mjs";
import Minus from "lucide-react/dist/esm/icons/minus.mjs";
import Music2 from "lucide-react/dist/esm/icons/music-2.mjs";
import Pause from "lucide-react/dist/esm/icons/pause.mjs";
import Piano from "lucide-react/dist/esm/icons/piano.mjs";
import Play from "lucide-react/dist/esm/icons/play.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Radio from "lucide-react/dist/esm/icons/radio.mjs";
import Repeat2 from "lucide-react/dist/esm/icons/repeat-2.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.mjs";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.mjs";
import TimerReset from "lucide-react/dist/esm/icons/timer-reset.mjs";
import Upload from "lucide-react/dist/esm/icons/upload.mjs";
import Volume2 from "lucide-react/dist/esm/icons/volume-2.mjs";
import Waves from "lucide-react/dist/esm/icons/waves.mjs";
import Wind from "lucide-react/dist/esm/icons/wind.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import LibraryView from "./LibraryView";
import StemSelectionPicker from "./components/StemSelectionPicker";
import {
  backendConfigured,
  spotifyImportEnabled,
} from "./lib/backendConfig";
import {
  createPanController,
  isStemAudible,
  StemAudioGraph,
} from "./lib/audioMixer";
import { validateRemoteImportUrl } from "./lib/remoteSources";
import {
  initialStemStates,
  isAudioStemId,
} from "./lib/stems";
import {
  loadStemSelection,
  saveStemSelection,
  selectStemSources,
  stemStatesForSelection,
  type StemSelection,
} from "./lib/stemSelection";
import type { SongLibraryItem } from "./lib/songLibrary";
import type {
  AnalysisData,
  AudioStemId,
  BeatEvent,
  ChordEvent,
  ProcessingStage,
  SectionEvent,
  StemId,
  StemSources,
  StemState,
} from "./types";

const DEMO_DURATION = 173;

const DEMO_SECTIONS: SectionEvent[] = [
  { label: "Intro", start: 0, end: 13.2 },
  { label: "Verse 1", start: 13.2, end: 46.5 },
  { label: "Chorus", start: 46.5, end: 76.8 },
  { label: "Verse 2", start: 76.8, end: 109.4 },
  { label: "Bridge", start: 109.4, end: 136.2 },
  { label: "Final chorus", start: 136.2, end: DEMO_DURATION },
];

function makeDemoBeats(duration: number): BeatEvent[] {
  const beats: BeatEvent[] = [];
  let time = 0;
  let index = 0;
  while (time < duration) {
    const bpm = time < 46 ? 72.8 : time < 109 ? 74.2 : time < 136 ? 73.4 : 75.1;
    beats.push({ time, beat: (index % 4) + 1 });
    time += 60 / bpm;
    index += 1;
  }
  return beats;
}

function makeStraightBeats(duration: number, bpm: number): BeatEvent[] {
  if (!Number.isFinite(bpm) || bpm <= 0) return [];
  const interval = 60 / Math.max(1, bpm);
  return Array.from({ length: Math.ceil(duration / interval) }, (_, index) => ({
    time: index * interval,
    beat: (index % 4) + 1,
  }));
}

function makeDemoChords(duration: number): ChordEvent[] {
  const names = ["B♭", "F", "Cm", "Gm", "B♭", "E♭", "Cm", "F", "Gm", "E♭", "B♭", "F"];
  const lengths = [6.58, 6.58, 6.58, 6.58, 7.04, 6.12, 7.44, 6.33];
  const chords: ChordEvent[] = [];
  let start = 0;
  let index = 0;
  while (start < duration) {
    const end = Math.min(duration, start + lengths[index % lengths.length]);
    chords.push({ chord: names[index % names.length], start, end });
    start = end;
    index += 1;
  }
  return chords;
}

function demoAnalysis(duration = DEMO_DURATION): AnalysisData {
  const scale = duration / DEMO_DURATION;
  return {
    bpm: 74,
    key: "B♭ Major",
    beats: makeDemoBeats(duration),
    chords: makeDemoChords(duration),
    sections: DEMO_SECTIONS.map((section) => ({
      ...section,
      start: section.start * scale,
      end: section.end * scale,
    })),
    stems: {},
  };
}

const WAVEFORM = Array.from({ length: 116 }, (_, index) => {
  const slow = Math.abs(Math.sin(index * 0.31));
  const fast = Math.abs(Math.sin(index * 1.73 + 0.6));
  return Math.round(18 + slow * 42 + fast * 28);
});

const FILE_STAGE_ORDER: ProcessingStage[] = ["upload", "analyze", "split", "ready"];
const REMOTE_STAGE_ORDER: ProcessingStage[] = ["download", "analyze", "split", "ready"];
const REMOTE_RESUME_BACKOFF_MS = [1_000, 3_000, 10_000, 30_000, 60_000] as const;
const SUPPORTED_MEDIA_EXTENSION = /\.(aac|aif|aiff|flac|m4a|m4v|mov|mp3|mp4|ogg|opus|wav)$/i;
function preferredScrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function isSupportedMediaFile(file: File) {
  return SUPPORTED_MEDIA_EXTENSION.test(file.name);
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "00:00";
  const total = Math.floor(value);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function useDialogFocus<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const dialogRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const focusableSelector = [
      "button:not([disabled]):not([tabindex='-1'])",
      "[href]",
      "input:not([disabled]):not([type='hidden']):not([hidden]):not([tabindex='-1'])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    dialog.focus({ preventScroll: true });

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [open]);

  return dialogRef;
}

function Panel({ children, className = "", id }: { children: ReactNode; className?: string; id?: string }) {
  return <section id={id} className={`hardware-panel ${className}`}>{children}</section>;
}

function IconButton({
  label,
  children,
  className = "",
  pressed,
  onClick,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`hardware-button icon-button ${className}`}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function StemIcon({ id }: { id: StemId }) {
  const props = { size: 23, strokeWidth: 1.8, "aria-hidden": true };
  if (id === "vocals") return <Mic2 {...props} />;
  if (id === "drums") return <Drum {...props} />;
  if (id === "bass") return <AudioLines {...props} />;
  if (id === "guitars") return <Guitar {...props} />;
  if (id === "piano") return <Piano {...props} />;
  if (id === "keys") return <KeyboardMusic {...props} />;
  if (id === "wind") return <Wind {...props} />;
  if (id === "metronome") return <TimerReset {...props} />;
  return <Music2 {...props} />;
}

function StemRow({
  stem,
  available,
  onVolume,
  onPan,
  onToggleMute,
  onToggleSolo,
}: {
  stem: StemState;
  available: boolean;
  onVolume: (value: number) => void;
  onPan: (value: number) => void;
  onToggleMute: () => void;
  onToggleSolo: () => void;
}) {
  const panLabel = stem.pan === 0
    ? "C"
    : `${Math.abs(stem.pan)}${stem.pan < 0 ? "L" : "R"}`;
  return (
    <div className={`stem-row ${stem.muted ? "is-muted" : ""}`} style={{ "--stem-color": stem.color } as React.CSSProperties}>
      <div className="stem-identity">
        <span className="stem-icon" aria-hidden="true"><StemIcon id={stem.id} /></span>
        <span className="stem-copy">
          <strong>{stem.label}</strong>
          <small>{available ? "AI stem ready" : stem.id === "metronome" ? "Beat-map driven" : "Demo channel"}</small>
        </span>
      </div>
      <label className="fader-wrap">
        <span className="sr-only">{stem.label} volume</span>
        <span className="fader-track" aria-hidden="true">
          <span className="fader-fill" style={{ width: `${stem.volume}%` }} />
        </span>
        <input
          type="range"
          min="0"
          max="100"
          value={stem.volume}
          onChange={(event) => onVolume(Number(event.target.value))}
          aria-valuetext={`${stem.volume} percent`}
        />
      </label>
      <div className="stem-actions">
        <button type="button" className={`mini-button ${stem.muted ? "active" : ""}`} aria-label={`${stem.muted ? "Unmute" : "Mute"} ${stem.label}`} aria-pressed={stem.muted} onClick={onToggleMute}>M</button>
        <button type="button" className={`mini-button solo ${stem.solo ? "active" : ""}`} aria-label={`${stem.solo ? "Unsolo" : "Solo"} ${stem.label}`} aria-pressed={stem.solo} onClick={onToggleSolo}>S</button>
        <label className="pan-control">
          <span>PAN</span>
          <input
            type="range"
            min="-100"
            max="100"
            step="1"
            value={stem.pan}
            onChange={(event) => onPan(Number(event.target.value))}
            aria-label={`${stem.label} stereo pan`}
            aria-valuetext={stem.pan === 0 ? "Center" : `${Math.abs(stem.pan)} percent ${stem.pan < 0 ? "left" : "right"}`}
          />
          <output aria-live="off">{panLabel}</output>
        </label>
        <output className="volume-readout" aria-live="off">{stem.volume}%</output>
      </div>
    </div>
  );
}

type ProcessingMode = "file" | "remote";

function ProcessingRail({
  stage,
  detail,
  mode,
  recoveryAvailable = false,
  onResume,
  onStopRecovery,
}: {
  stage: ProcessingStage;
  detail: string;
  mode: ProcessingMode;
  recoveryAvailable?: boolean;
  onResume?: () => void;
  onStopRecovery?: () => void;
}) {
  if (stage === "idle") return null;
  const stageOrder = mode === "remote" ? REMOTE_STAGE_ORDER : FILE_STAGE_ORDER;
  const activeIndex = stage === "error" ? -1 : stageOrder.indexOf(stage);
  return (
    <div className={`processing-card ${stage === "error" ? "error" : ""}`} role="status" aria-live="polite">
      <div className="processing-copy">
        {stage === "error" ? <CircleHelp size={18} /> : <Sparkles size={18} />}
        <span><strong>{stage === "error" ? "Needs attention" : stage === "ready" ? "Analysis complete" : "Building your practice deck"}</strong>{detail}</span>
      </div>
      {stage !== "error" && (
        <div className="stage-rail" aria-label={`Processing stage: ${stage}`}>
          {stageOrder.map((item, index) => <span key={item} className={index <= activeIndex ? "done" : ""}>{item}</span>)}
        </div>
      )}
      {stage === "error" && recoveryAvailable && onResume && onStopRecovery && (
        <div className="processing-actions">
          <button type="button" className="text-button" onClick={onResume}>Resume import</button>
          <button type="button" className="text-button" onClick={onStopRecovery}>Stop reconnecting</button>
        </div>
      )}
    </div>
  );
}

type ImportMode = "file" | "link";

function ImportModal({
  open,
  busy,
  onClose,
  onFile,
  onUrl,
  onError,
  remoteReady,
  remoteUnavailableReason,
  spotifyEnabled,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onFile: (file: File) => void;
  onUrl: (url: string) => void;
  onError: (message: string) => void;
  remoteReady: boolean;
  remoteUnavailableReason?: string;
  spotifyEnabled: boolean;
}) {
  const [mode, setMode] = useState<ImportMode>("file");
  const [url, setUrl] = useState("");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(open, onClose);

  useEffect(() => {
    if (open) return;
    setMode("file");
    setUrl("");
    setRightsConfirmed(false);
  }, [open]);

  if (!open) return null;

  const acceptFile = (file?: File) => {
    if (!file) return;
    if (isSupportedMediaFile(file)) {
      onFile(file);
      return;
    }
    onError("Choose a supported audio or video file such as MP3, M4A, WAV, FLAC, or MP4.");
  };

  const selectMode = (nextMode: ImportMode) => {
    setMode(nextMode);
    window.requestAnimationFrame(() => document.getElementById(`import-${nextMode}-tab`)?.focus());
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") selectMode("file");
    else if (event.key === "End") selectMode("link");
    else selectMode(mode === "file" ? "link" : "file");
  };

  return (
    <div className="modal-backdrop" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div ref={dialogRef} className="modal hardware-panel" role="dialog" aria-modal="true" aria-labelledby="import-title" tabIndex={-1}>
        <div className="modal-head">
          <div><span className="eyebrow">NEW PROJECT</span><h2 id="import-title">Bring in a track</h2></div>
          <IconButton label="Close import" onClick={onClose}><X size={21} /></IconButton>
        </div>
        <div className="segmented-tabs" role="tablist" aria-label="Import source">
          <button id="import-file-tab" type="button" role="tab" aria-selected={mode === "file"} aria-controls="import-file-panel" tabIndex={mode === "file" ? 0 : -1} className={mode === "file" ? "active" : ""} onKeyDown={onTabKeyDown} onClick={() => setMode("file")}><Upload size={17} /> Local file</button>
          <button id="import-link-tab" type="button" role="tab" aria-selected={mode === "link"} aria-controls="import-link-panel" tabIndex={mode === "link" ? 0 : -1} className={mode === "link" ? "active" : ""} onKeyDown={onTabKeyDown} onClick={() => setMode("link")}><Link2 size={17} /> {spotifyEnabled ? "YouTube / Spotify" : "YouTube"}</button>
        </div>
        {mode === "file" ? (
          <div id="import-file-panel" role="tabpanel" aria-labelledby="import-file-tab">
            <button
              type="button"
              className="drop-zone"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              onDragOver={(event: DragEvent<HTMLButtonElement>) => event.preventDefault()}
              onDrop={(event: DragEvent<HTMLButtonElement>) => {
                event.preventDefault();
                acceptFile(event.dataTransfer.files[0]);
              }}
            >
              <span className="drop-icon"><Upload size={27} /></span>
              <strong>{busy ? "Preparing your track…" : "Choose audio or video"}</strong>
              <span>MP3, M4A, WAV, FLAC, or MP4 · your own or authorized media</span>
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".mp3,.m4a,.wav,.flac,.mp4,.m4v,.aac,.aif,.aiff,.ogg,.opus,.mov"
              hidden
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                acceptFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
        ) : (
          <form id="import-link-panel" role="tabpanel" aria-labelledby="import-link-tab" className="link-form" onSubmit={(event) => { event.preventDefault(); if (remoteReady && rightsConfirmed && url.trim()) onUrl(url.trim()); }}>
            <label><span>{spotifyEnabled ? "YouTube or Spotify track URL" : "YouTube video URL"}</span><input type="url" inputMode="url" autoComplete="url" placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={(event) => setUrl(event.target.value)} disabled={busy || !remoteReady} required /></label>
            <p className="form-note">{spotifyEnabled ? "Paste one YouTube video or one Spotify track. Playlists, albums, channels, searches, and shortened Spotify links are not supported." : "Paste one YouTube video. Playlists, channels, searches, and unrelated links are not supported."}</p>
            <p className="form-note">Use only a single recording you created, own, or are authorized by both the rights holder and source service to download and send to Music.ai. Personal use alone does not grant those rights.</p>
            {spotifyEnabled && <p className="form-note">spotDL uses Spotify metadata to find audio on YouTube/YouTube Music; it does not export Spotify audio.</p>}
            {!remoteReady && remoteUnavailableReason && <p className="form-note" role="status">{remoteUnavailableReason}</p>}
            <label className="check-row"><input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} disabled={busy || !remoteReady} required /><span>I confirm I have permission to download, process, and transmit this track to Music.ai.</span></label>
            <button type="submit" className="primary-button" disabled={busy || !remoteReady || !rightsConfirmed || !url.trim()}>{busy ? "Starting…" : "Download & analyze"}<Sparkles size={18} /></button>
          </form>
        )}
        <div className="privacy-note"><Cloud size={16} /><span>{mode === "link" ? "Remote audio is temporarily stored in private Firebase Storage and sent to Music.ai. Your Music.ai key stays on the secure backend." : "Your Music.ai key stays on the secure STEMulate backend. It is never shipped in this web app."}</span></div>
      </div>
    </div>
  );
}

function SettingsSheet({
  open,
  userEmail,
  onClose,
  onSignIn,
  onSignOut,
}: {
  open: boolean;
  userEmail: string | null;
  onClose: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLElement>(open, onClose);
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside ref={dialogRef} className="settings-sheet hardware-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1}>
        <div className="modal-head"><div><span className="eyebrow">SYSTEM</span><h2 id="settings-title">Deck settings</h2></div><IconButton label="Close settings" onClick={onClose}><X size={21} /></IconButton></div>
        <div className="setting-row"><span className="setting-icon"><Radio size={19} /></span><span><strong>Processing backend</strong><small>{backendConfigured ? "Connected through Firebase" : "Demo mode · finish Firebase and App Check setup to go live"}</small></span><b className={backendConfigured ? "status-ok" : "status-demo"}>{backendConfigured ? "READY" : "DEMO"}</b></div>
        <div className="setting-row"><span className="setting-icon"><Cloud size={19} /></span><span><strong>Owner access</strong><small>{userEmail || "Sign in after enabling Google Auth in Firebase"}</small></span>{userEmail ? <button type="button" className="text-button" onClick={onSignOut}>Sign out</button> : <button type="button" className="text-button" onClick={onSignIn}>Sign in</button>}</div>
        <div className="install-card"><strong>Add STEMulate to iPhone</strong><p>In Safari, tap Share, then <b>Add to Home Screen</b>. The controls already account for the iPhone safe area.</p></div>
        <div className="about-card"><img src="./stemulate-logo.png" alt="" /><span><strong>STEMulate v0.1</strong><small>Local-first prototype · 1998 hardware edition</small></span></div>
      </aside>
    </div>
  );
}

export default function App() {
  const [trackTitle, setTrackTitle] = useState("Midnight Circuit");
  const [trackSource, setTrackSource] = useState("STEMulate demo session");
  const [duration, setDuration] = useState(DEMO_DURATION);
  const [currentTime, setCurrentTime] = useState(31.6);
  const [isPlaying, setIsPlaying] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisData>(() => demoAnalysis());
  const [stems, setStems] = useState<StemState[]>(() => initialStemStates());
  const [audioSources, setAudioSources] = useState<StemSources>({});
  const [processingStage, setProcessingStage] = useState<ProcessingStage>("idle");
  const [processingDetail, setProcessingDetail] = useState("");
  const [processingMode, setProcessingMode] = useState<ProcessingMode>("file");
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeView, setActiveView] = useState<"library" | "mixer" | "practice">("library");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [stemSelection, setStemSelection] = useState<StemSelection>(() => loadStemSelection());
  const [playbackRate, setPlaybackRate] = useState(1);
  const [pitch, setPitch] = useState(0);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopStart, setLoopStart] = useState(46.5);
  const [loopEnd, setLoopEnd] = useState(76.8);
  const [metronomeEnabled, setMetronomeEnabled] = useState(true);
  const [followTempoMap, setFollowTempoMap] = useState(true);
  const [countIn, setCountIn] = useState(2);
  const [isCountingIn, setIsCountingIn] = useState(false);
  const [countdownBeat, setCountdownBeat] = useState<number | null>(null);
  const [beatPulse, setBeatPulse] = useState(0);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userUid, setUserUid] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState<"mix" | "stems" | null>(null);
  const [exportProgress, setExportProgress] = useState("");
  const [remoteResumeTrigger, setRemoteResumeTrigger] = useState(0);
  const [remoteRecoveryPending, setRemoteRecoveryPending] = useState(false);

  const audioElements = useRef<Partial<Record<AudioStemId, HTMLAudioElement>>>({});
  const localObjectUrl = useRef<string | null>(null);
  const processingController = useRef<AbortController | null>(null);
  const remoteResumeTimer = useRef<number | null>(null);
  const remoteResumeFailures = useRef(0);
  const loopRef = useRef({ enabled: loopEnabled, start: loopStart, end: loopEnd });
  const audioContext = useRef<AudioContext | null>(null);
  const audioGraph = useRef(new StemAudioGraph());
  const lastBeatIndex = useRef(-1);
  const countInToken = useRef(0);
  const countInActive = useRef(false);
  const chordStripRef = useRef<HTMLDivElement>(null);
  const appShellRef = useRef<HTMLElement>(null);
  const controlDockRef = useRef<HTMLDivElement>(null);
  const bottomNavRef = useRef<HTMLElement>(null);

  const hasAudioSources = Object.values(audioSources).some(Boolean);
  const clickGrid = useMemo(
    () => followTempoMap ? analysis.beats : makeStraightBeats(duration, analysis.bpm),
    [analysis.beats, analysis.bpm, duration, followTempoMap],
  );
  const activeChordIndex = analysis.chords.findIndex((chord) => currentTime >= chord.start && currentTime < chord.end);
  const activeChord = activeChordIndex >= 0 ? analysis.chords[activeChordIndex] : { chord: "—", start: 0, end: 0 };
  const activeSectionIndex = analysis.sections.findIndex((section) => currentTime >= section.start && currentTime < section.end);
  const activeSection = activeSectionIndex >= 0 ? analysis.sections[activeSectionIndex] : undefined;
  const remaining = Math.max(0, duration - currentTime);
  const availableStemCount = Object.values(analysis.stems).filter(Boolean).length;
  const modalOpen = importOpen || settingsOpen;

  const openImport = useCallback(() => {
    setImportOpen(true);
  }, []);

  const closeImport = useCallback(() => setImportOpen(false), []);
  const openSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const clearRemoteResumeTimer = useCallback(() => {
    if (remoteResumeTimer.current === null) return;
    window.clearTimeout(remoteResumeTimer.current);
    remoteResumeTimer.current = null;
  }, []);

  const queueRemoteResume = useCallback(() => {
    if (remoteResumeTimer.current !== null) return;
    const attempt = remoteResumeFailures.current;
    if (attempt >= REMOTE_RESUME_BACKOFF_MS.length) {
      setRemoteRecoveryPending(true);
      return;
    }
    const delay = REMOTE_RESUME_BACKOFF_MS[attempt];
    remoteResumeFailures.current = attempt + 1;
    setRemoteRecoveryPending(true);
    remoteResumeTimer.current = window.setTimeout(() => {
      remoteResumeTimer.current = null;
      setRemoteResumeTrigger((value) => value + 1);
    }, delay);
  }, []);

  const triggerRemoteResume = useCallback(() => {
    clearRemoteResumeTimer();
    remoteResumeFailures.current = 0;
    setRemoteRecoveryPending(true);
    remoteResumeTimer.current = window.setTimeout(() => {
      remoteResumeTimer.current = null;
      setRemoteResumeTrigger((value) => value + 1);
    }, 0);
  }, [clearRemoteResumeTimer]);

  const resetRemoteResume = useCallback(() => {
    clearRemoteResumeTimer();
    remoteResumeFailures.current = 0;
    setRemoteRecoveryPending(false);
  }, [clearRemoteResumeTimer]);

  useEffect(() => {
    if (!backendConfigured) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void import("./lib/firebase").then(({ observeUser }) => {
      if (!cancelled) {
        unsubscribe = observeUser((user) => {
          setUserEmail(user?.email || null);
          setUserUid(user?.uid || null);
        });
      }
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => () => {
    clearRemoteResumeTimer();
    remoteResumeFailures.current = 0;
    const active = processingController.current;
    active?.abort();
    if (processingController.current === active) processingController.current = null;
  }, [clearRemoteResumeTimer, userEmail]);

  useEffect(() => {
    if (!modalOpen) return;
    const background = [appShellRef.current, controlDockRef.current, bottomNavRef.current]
      .filter((element): element is HTMLElement => Boolean(element));
    background.forEach((element) => { element.inert = true; });
    return () => background.forEach((element) => { element.inert = false; });
  }, [modalOpen]);

  useEffect(() => {
    loopRef.current = { enabled: loopEnabled, start: loopStart, end: loopEnd };
  }, [loopEnabled, loopStart, loopEnd]);

  useEffect(() => {
    countInToken.current += 1;
    countInActive.current = false;
    setIsCountingIn(false);
    setCountdownBeat(null);
    const existing = audioElements.current;
    audioGraph.current.disconnect();
    Object.values(existing).forEach((audio) => {
      if (!audio) return;
      audio.pause();
      audio.muted = false;
      audio.loop = false;
    });
    const next: Partial<Record<AudioStemId, HTMLAudioElement>> = {};
    const entries = Object.entries(audioSources).filter((entry): entry is [AudioStemId, string] => Boolean(entry[1]));
    entries.forEach(([id, src]) => {
      const audio = new Audio();
      audio.crossOrigin = "anonymous";
      audio.preload = "metadata";
      audio.setAttribute("playsinline", "");
      audio.src = src;
      next[id] = audio;
    });
    audioElements.current = next;
    const clock = Object.values(next)[0];
    if (clock) {
      clock.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(clock.duration)) {
          setDuration(clock.duration);
          setAnalysis((current) => current.stems && Object.keys(current.stems).length ? current : demoAnalysis(clock.duration));
        }
      });
      clock.addEventListener("timeupdate", () => {
        if (countInActive.current) return;
        const loop = loopRef.current;
        if (loop.enabled && clock.currentTime >= loop.end) {
          Object.values(audioElements.current).forEach((audio) => { if (audio) audio.currentTime = loop.start; });
          setCurrentTime(loop.start);
          return;
        }
        setCurrentTime(clock.currentTime);
      });
      clock.addEventListener("ended", () => setIsPlaying(false));
    }
    return () => {
      audioGraph.current.disconnect();
      Object.values(next).forEach((audio) => {
        if (!audio) return;
        audio.pause();
        audio.muted = false;
        audio.loop = false;
      });
    };
  }, [audioSources]);

  useEffect(() => {
    const context = audioContext.current;
    if (context) {
      audioGraph.current.connect(context, audioElements.current);
      audioGraph.current.update(stems, playbackRate);
      return;
    }
    Object.values(audioElements.current).forEach((audio) => {
      if (!audio) return;
      audio.volume = 1;
      audio.playbackRate = playbackRate;
    });
  }, [stems, playbackRate, audioSources]);

  useEffect(() => () => {
    audioGraph.current.disconnect();
    const context = audioContext.current;
    audioContext.current = null;
    if (context && context.state !== "closed") void context.close();
  }, []);

  useEffect(() => {
    if (!isPlaying || hasAudioSources) return;
    const interval = window.setInterval(() => {
      setCurrentTime((value) => {
        let next = value + 0.05 * playbackRate;
        const loop = loopRef.current;
        if (loop.enabled && next >= loop.end) next = loop.start;
        if (next >= duration) {
          setIsPlaying(false);
          next = 0;
        }
        return next;
      });
    }, 50);
    return () => window.clearInterval(interval);
  }, [isPlaying, hasAudioSources, duration, playbackRate]);

  useEffect(() => {
    if (!isPlaying || !hasAudioSources) return;
    let frame = 0;
    let tickCount = 0;
    const tick = () => {
      const media = Object.values(audioElements.current).filter(Boolean) as HTMLAudioElement[];
      const clock = media[0];
      if (clock) {
        setCurrentTime(clock.currentTime);
        if (tickCount % 12 === 0) {
          media.slice(1).forEach((audio) => {
            if (Math.abs(audio.currentTime - clock.currentTime) > 0.08) audio.currentTime = clock.currentTime;
          });
        }
      }
      tickCount += 1;
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [hasAudioSources, isPlaying]);

  const clickBeat = useCallback((accent: boolean) => {
    if (!metronomeEnabled) return;
    const context = audioContext.current;
    if (!context) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const pan = createPanController(context);
    const clickStem = stems.find((stem) => stem.id === "metronome");
    const level = clickStem && isStemAudible(clickStem, stems)
      ? (clickStem.volume / 100) * 0.18
      : 0;
    oscillator.frequency.value = accent ? 1320 : 880;
    gain.gain.setValueAtTime(level, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.055);
    pan.set((clickStem?.pan ?? 0) / 100, context);
    oscillator.connect(gain).connect(pan.node).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.06);
  }, [metronomeEnabled, stems]);

  useEffect(() => {
    if (!isPlaying || !metronomeEnabled || !clickGrid.length) return;
    let nextIndex = clickGrid.findIndex((beat) => beat.time > currentTime + 0.05);
    if (nextIndex < 0) nextIndex = clickGrid.length;
    const playedIndex = Math.max(0, nextIndex - 1);
    if (playedIndex !== lastBeatIndex.current && Math.abs(clickGrid[playedIndex].time - currentTime) < 0.18) {
      lastBeatIndex.current = playedIndex;
      setBeatPulse((value) => value + 1);
      clickBeat(clickGrid[playedIndex].beat === 1);
    }
  }, [clickBeat, clickGrid, currentTime, isPlaying, metronomeEnabled]);

  useEffect(() => {
    lastBeatIndex.current = -1;
  }, [followTempoMap]);

  useEffect(() => {
    const strip = chordStripRef.current;
    const element = strip?.querySelector<HTMLElement>(`[data-chord-index="${activeChordIndex}"]`);
    if (!strip || !element) return;
    const centeredLeft = element.offsetLeft - (strip.clientWidth - element.clientWidth) / 2;
    strip.scrollTo({ left: Math.max(0, centeredLeft), behavior: isPlaying ? preferredScrollBehavior() : "auto" });
  }, [activeChordIndex, isPlaying]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3400);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const seek = useCallback((time: number) => {
    const next = Math.max(0, Math.min(duration, time));
    Object.values(audioElements.current).forEach((audio) => { if (audio) audio.currentTime = next; });
    setCurrentTime(next);
    lastBeatIndex.current = -1;
  }, [duration]);

  const togglePlayback = useCallback(async () => {
    const media = Object.values(audioElements.current).filter(Boolean) as HTMLAudioElement[];
    if (isCountingIn) {
      countInToken.current += 1;
      countInActive.current = false;
      media.forEach((audio) => {
        audio.pause();
        audio.muted = false;
        audio.loop = false;
        audio.currentTime = currentTime;
      });
      setIsCountingIn(false);
      setCountdownBeat(null);
      return;
    }
    if (isPlaying) {
      media.forEach((audio) => audio.pause());
      setIsPlaying(false);
      return;
    }

    if (!audioContext.current) audioContext.current = new AudioContext();
    audioGraph.current.connect(audioContext.current, audioElements.current);
    audioGraph.current.update(stems, playbackRate);
    const resumeAudioContext = audioContext.current.state === "suspended"
      ? audioContext.current.resume()
      : Promise.resolve();
    const shouldCountIn = metronomeEnabled
      && countIn > 0
      && currentTime < 0.25
      && analysis.bpm > 0;
    const playStart = currentTime;
    const token = shouldCountIn ? ++countInToken.current : countInToken.current;

    if (shouldCountIn) {
      countInActive.current = true;
      media.forEach((audio) => {
        audio.muted = true;
        audio.loop = true;
      });
      setIsCountingIn(true);
    }

    // Invoke every media play synchronously in the original tap. This unlocks
    // Safari audio before the asynchronous count-in consumes user activation.
    const startMedia = media.map((audio) => audio.play());
    try {
      await Promise.all([resumeAudioContext, ...startMedia]);
    } catch {
      media.forEach((audio) => {
        audio.pause();
        audio.muted = false;
        audio.loop = false;
      });
      countInActive.current = false;
      setIsCountingIn(false);
      setCountdownBeat(null);
      if (countInToken.current === token) setToast("Playback is blocked. Tap play again to unlock audio on this device.");
      return;
    }

    if (countInToken.current !== token) {
      media.forEach((audio) => {
        audio.pause();
        audio.muted = false;
        audio.loop = false;
      });
      return;
    }

    if (shouldCountIn) {
      const totalBeats = countIn * 4;
      for (let index = 0; index < totalBeats; index += 1) {
        if (countInToken.current !== token) return;
        setCountdownBeat((index % 4) + 1);
        setBeatPulse((value) => value + 1);
        clickBeat(index % 4 === 0);
        await sleep((60 / Math.max(1, analysis.bpm * playbackRate)) * 1000);
      }
      if (countInToken.current !== token) return;
      media.forEach((audio) => {
        audio.loop = false;
        audio.currentTime = playStart;
        audio.muted = false;
      });
      setCurrentTime(playStart);
      countInActive.current = false;
      setIsCountingIn(false);
      setCountdownBeat(null);
    }
    setIsPlaying(true);
  }, [analysis.bpm, clickBeat, countIn, currentTime, isCountingIn, isPlaying, metronomeEnabled, playbackRate]);

  const updateStem = (id: StemId, patch: Partial<StemState>) => {
    setStems((current) => current.map((stem) => stem.id === id ? { ...stem, ...patch } : stem));
  };

  const updateStemSelection = (next: StemSelection) => {
    const saved = saveStemSelection(next);
    setStemSelection(saved);
    setAudioSources(selectStemSources(analysis.stems, saved));
    setStems((current) => stemStatesForSelection(analysis.stems, saved, current));
  };

  const exportAudio = async (kind: "mix" | "stems") => {
    if (!availableStemCount || exportBusy) {
      if (!availableStemCount) setToast("Finish processing a track before exporting audio.");
      return;
    }
    setExportBusy(kind);
    setExportProgress(kind === "mix" ? "Preparing stereo mix" : "Preparing stem archive");
    try {
      const {
        packageStemsZip,
        renderMixWav,
        safeFileBase,
        shareOrDownload,
      } = await import("./lib/audioExport");
      const baseName = safeFileBase(trackTitle);
      const blob = kind === "mix"
        ? await renderMixWav(audioSources, stems, setExportProgress)
        : await packageStemsZip(analysis.stems, trackTitle, setExportProgress);
      setExportProgress("Opening export");
      const disposition = await shareOrDownload(
        blob,
        kind === "mix" ? `${baseName}-mix.wav` : `${baseName}-stems.zip`,
        kind === "mix" ? `${trackTitle} mix` : `${trackTitle} stems`,
      );
      setToast(disposition === "cancelled"
        ? "Export cancelled."
        : disposition === "shared"
          ? `${kind === "mix" ? "Mix" : "Stem archive"} shared.`
          : `${kind === "mix" ? "Mix" : "Stem archive"} downloaded.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The audio export could not be completed.");
    } finally {
      setExportBusy(null);
      setExportProgress("");
    }
  };

  const applyResult = (result: AnalysisData) => {
    setAnalysis({
      bpm: result.bpm,
      key: result.key,
      beats: result.beats,
      chords: result.chords,
      sections: result.sections,
      stems: result.stems,
    });
    if (Object.values(result.stems).some(Boolean)) {
      setAudioSources(selectStemSources(result.stems, stemSelection));
      setStems((current) => stemStatesForSelection(result.stems, stemSelection, current));
    }
  };

  const openSavedSong = async (song: SongLibraryItem) => {
    setToast(`Opening ${song.title}…`);
    try {
      const { loadProcessingJob } = await import("./lib/musicAi");
      const result = await loadProcessingJob(song.id);
      applyResult(result.analysis);
      setActiveJobId(song.id);
      setTrackTitle(result.displayName?.trim() || song.title);
      setTrackSource(result.sourceProvider === "spotify"
        ? "Spotify track · spotDL → YouTube Music · Music.ai"
        : result.sourceProvider === "youtube"
          ? "YouTube track · yt-dlp · Music.ai"
          : "Uploaded file · Music.ai");
      setProcessingStage("ready");
      setProcessingDetail(`${song.title} is ready`);
      setIsPlaying(false);
      seek(0);
      setActiveView("mixer");
      window.requestAnimationFrame(() => scrollTo("mixer"));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The saved song could not be opened.");
    }
  };

  useEffect(() => {
    if (!userEmail) {
      resetRemoteResume();
      return;
    }
    if (
      !backendConfigured
      || processingController.current
      || document.visibilityState !== "visible"
      || !navigator.onLine
    ) return;
    const controller = new AbortController();
    processingController.current = controller;
    let musicAi: typeof import("./lib/musicAi") | null = null;
    void (async () => {
      musicAi = await import("./lib/musicAi");
      if (controller.signal.aborted) return;
      if (!musicAi.hasPendingRemoteTrack()) {
        resetRemoteResume();
        const restored = await musicAi.refreshLatestOutputs(true).catch(() => null);
        if (!restored || controller.signal.aborted) return;
        applyResult(restored.analysis);
        if (restored.displayName) setTrackTitle(restored.displayName);
        setTrackSource(restored.sourceProvider === "spotify"
          ? "Spotify track · spotDL → YouTube Music · Music.ai"
          : restored.sourceProvider === "youtube"
            ? "YouTube track · yt-dlp · Music.ai"
            : "Restored Music.ai session");
        seek(0);
        return;
      }

      setRemoteRecoveryPending(true);
      setProcessingMode("remote");
      const resumed = await musicAi.resumeRemoteTrack(onStage, controller.signal);
      if (!resumed || controller.signal.aborted) return;
      resetRemoteResume();
      applyResult(resumed.analysis);
      setTrackTitle(resumed.title);
      setTrackSource(resumed.source);
      seek(0);
    })()
      .catch((error) => {
        if (controller.signal.aborted) return;
        const pending = Boolean(musicAi?.hasPendingRemoteTrack());
        setRemoteRecoveryPending(pending);
        onStage("error", error instanceof Error ? error.message : "The saved import could not be resumed.");
        if (pending) queueRemoteResume();
      })
      .finally(() => {
        if (processingController.current === controller) processingController.current = null;
      });
    return () => {
      if (processingController.current === controller) {
        controller.abort();
        processingController.current = null;
      }
    };
  // Resume attempts are driven only by authentication and the bounded retry
  // trigger. Mutable media/controller refs intentionally stay outside deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueRemoteResume, remoteResumeTrigger, resetRemoteResume, userEmail]);

  useEffect(() => {
    if (!backendConfigured || !userEmail) return;
    let disposed = false;
    const wake = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine || processingController.current) return;
      void import("./lib/musicAi")
        .then(async ({ hasPendingRemoteTrack, refreshLatestOutputs }) => {
          if (disposed) return null;
          if (hasPendingRemoteTrack()) {
            triggerRemoteResume();
            return null;
          }
          return refreshLatestOutputs(false);
        })
        .then((result) => {
          if (!disposed && result) applyResult(result.analysis);
        })
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", wake);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
    };
  // Mutable media/controller refs intentionally gate refreshes without adding
  // render-time dependencies.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerRemoteResume, userEmail]);

  const onStage = (stage: ProcessingStage, detail: string) => {
    setProcessingStage(stage);
    setProcessingDetail(detail);
  };

  const simulateAnalysis = async (name: string) => {
    onStage("upload", "Loading the track into your deck");
    await sleep(520);
    onStage("analyze", "Mapping beats, chords, and song sections");
    await sleep(760);
    onStage("split", "Preparing the five-channel mixer");
    await sleep(860);
    setAnalysis(demoAnalysis(duration));
    onStage("ready", `${name} is ready in interactive demo mode`);
  };

  const handleFile = async (file: File) => {
    processingController.current?.abort();
    const controller = new AbortController();
    processingController.current = controller;
    setProcessingMode("file");
    setImportOpen(false);
    if (backendConfigured) setActiveView("library");
    setTrackTitle(file.name.replace(/\.[^.]+$/, ""));
    setTrackSource(`${file.type || "audio file"} · local preview`);
    if (localObjectUrl.current) URL.revokeObjectURL(localObjectUrl.current);
    localObjectUrl.current = URL.createObjectURL(file);
    setAudioSources({ other: localObjectUrl.current });
    setStems((current) => stemStatesForSelection({}, stemSelection, current));
    seek(0);

    try {
      if (backendConfigured) {
        const { analyzeFile } = await import("./lib/musicAi");
        applyResult(await analyzeFile(file, onStage, controller.signal));
        setToast(`${file.name.replace(/\.[^.]+$/, "")} is ready in your library.`);
      } else await simulateAnalysis(file.name);
    } catch (error) {
      if (controller.signal.aborted) return;
      onStage("error", error instanceof Error ? error.message : "The track could not be analyzed.");
    } finally {
      if (processingController.current === controller) processingController.current = null;
    }
  };

  const handleUrl = async (url: string) => {
    if (!backendConfigured) {
      setToast("Remote imports require the secure Firebase backend.");
      return;
    }
    if (!userEmail) {
      setToast("Sign in as the owner from Menu before importing a track link.");
      return;
    }
    const validation = validateRemoteImportUrl(url, spotifyImportEnabled);
    if (!validation.ok) {
      setToast(validation.reason === "spotify-disabled"
        ? "Spotify importing is disabled on this deployment. Paste a YouTube video URL."
        : spotifyImportEnabled
          ? "Enter a valid YouTube or Spotify track URL."
          : "Enter a valid YouTube video URL.");
      return;
    }
    resetRemoteResume();
    processingController.current?.abort();
    const controller = new AbortController();
    processingController.current = controller;
    setProcessingMode("remote");
    setImportOpen(false);
    setActiveView("library");
    onStage("download", "Preparing the private download job");
    let musicAi: typeof import("./lib/musicAi") | null = null;
    try {
      musicAi = await import("./lib/musicAi");
      const result = await musicAi.analyzeRemoteTrack(url, onStage, controller.signal);
      resetRemoteResume();
      applyResult(result.analysis);
      setTrackTitle(result.title);
      setTrackSource(result.source);
      seek(0);
      setToast(`${result.title} is ready in your library.`);
    } catch (error) {
      if (controller.signal.aborted) return;
      const pending = Boolean(musicAi?.hasPendingRemoteTrack());
      setRemoteRecoveryPending(pending);
      onStage("error", error instanceof Error ? error.message : "The link could not be analyzed.");
      if (pending) queueRemoteResume();
    } finally {
      if (processingController.current === controller) processingController.current = null;
    }
  };

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" });
  };

  const toggleLoopForSection = (section: SectionEvent) => {
    const alreadySelected = loopEnabled && Math.abs(loopStart - section.start) < 0.1 && Math.abs(loopEnd - section.end) < 0.1;
    setLoopStart(section.start);
    setLoopEnd(section.end);
    setLoopEnabled(!alreadySelected);
    if (!alreadySelected) seek(section.start);
  };

  const resumeRemoteNow = () => {
    setProcessingMode("remote");
    onStage("download", "Reconnecting to your private import job");
    triggerRemoteResume();
  };

  const stopRemoteRecovery = () => {
    processingController.current?.abort();
    processingController.current = null;
    clearRemoteResumeTimer();
    remoteResumeFailures.current = 0;
    setRemoteRecoveryPending(false);
    setProcessingStage("idle");
    setProcessingDetail("");
    void import("./lib/musicAi").then(({ cancelPendingRemoteTrack }) => cancelPendingRemoteTrack());
    setToast("Stopped reconnecting. The server job may still finish in the background.");
  };

  const processingBusy = ["download", "upload", "analyze", "split"].includes(processingStage);

  return (
    <div className="app-bg">
      <div className="scanlines" aria-hidden="true" />
      <main ref={appShellRef} className={`app-shell ${activeView === "library" ? "library-mode" : ""}`}>
        <header className="app-header">
          <img className="brand-logo" src="./stemulate-logo.png" alt="STEMulate" />
          <div className="brand-copy"><span className="eyebrow">AI PRACTICE DECK</span><strong>STEM<span>ULATE</span></strong><small>{backendConfigured ? "Music.ai engine armed" : "Interactive demo mode"}</small></div>
          <button type="button" className="menu-button hardware-button" aria-label="Open deck settings" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={openSettings}><Menu size={19} /><span>MENU</span><ChevronDown size={15} /></button>
        </header>

        <ProcessingRail
          stage={processingStage}
          detail={processingDetail}
          mode={processingMode}
          recoveryAvailable={remoteRecoveryPending}
          onResume={resumeRemoteNow}
          onStopRecovery={stopRemoteRecovery}
        />

        {activeView === "library" ? (
          <LibraryView
            ownerUid={userUid}
            activeJobId={activeJobId}
            onImport={openImport}
            onSelect={openSavedSong}
          />
        ) : (
          <>
        <Panel className="track-panel">
          <div className="track-info">
            <span className="track-state"><span className={`status-dot ${processingBusy ? "working" : ""}`} />{processingStage === "error" ? "NEEDS ATTENTION" : processingBusy ? "PROCESSING" : "READY TO PRACTICE"}</span>
            <h1>{trackTitle}</h1>
            <p>{trackSource} <span aria-hidden="true">•</span> {formatTime(duration)}</p>
          </div>
          <button type="button" className="import-button hardware-button" aria-label="Import a track" aria-haspopup="dialog" aria-expanded={importOpen} onClick={openImport}><Import size={19} /><span>Import</span></button>
        </Panel>

        <Panel className="chord-panel" id="chords">
          <div className="panel-title-row"><div><span className="eyebrow">LIVE CHORD PATH</span><h2>Follow the changes</h2></div><div className="musical-badges"><span><b>{analysis.key === "Unknown" ? "—" : analysis.key}</b> key</span><span><b>{analysis.bpm > 0 ? Math.round(analysis.bpm) : "—"}</b> BPM</span></div></div>
          <div className="chord-strip" ref={chordStripRef}>
            {analysis.chords.length === 0 && <p className="analysis-unavailable">No chord map was returned.</p>}
            {analysis.chords.map((chord, index) => (
              <button
                key={`${chord.start}-${chord.chord}`}
                type="button"
                className={`chord-tile ${index === activeChordIndex ? "active" : ""}`}
                aria-current={index === activeChordIndex ? "true" : undefined}
                onClick={() => seek(chord.start)}
                data-chord-index={index}
              >
                <span>{index === activeChordIndex ? "NOW" : formatTime(chord.start)}</span>
                <strong>{chord.chord}</strong>
                <small>{Math.max(1, Math.round((chord.end - chord.start) / (60 / analysis.bpm)))} beats</small>
              </button>
            ))}
          </div>
        </Panel>

        <Panel className="arrangement-panel" id="arrangement">
          <div className="panel-title-row compact"><div><span className="eyebrow">ARRANGEMENT MAP</span><h2>{activeSection?.label || "Full song"}</h2></div><button type="button" className={`loop-chip ${loopEnabled ? "active" : ""}`} aria-pressed={loopEnabled} onClick={() => setLoopEnabled((value) => !value)}><Repeat2 size={16} />{loopEnabled ? "Loop armed" : "Loop off"}</button></div>
          <div className="section-rail" role="group" aria-label="Song sections">
            {analysis.sections.length === 0 && <p className="analysis-unavailable">No section map was returned.</p>}
            {analysis.sections.map((section, index) => {
              const isLoopSelection = loopEnabled && Math.abs(loopStart - section.start) < 0.1 && Math.abs(loopEnd - section.end) < 0.1;
              return (
                <button
                  key={`${section.start}-${section.label}`}
                  type="button"
                  className={`${index === activeSectionIndex ? "active" : ""} ${isLoopSelection ? "loop-selected" : ""}`}
                  style={{ flexGrow: Math.max(1, section.end - section.start) }}
                  aria-current={index === activeSectionIndex ? "true" : undefined}
                  aria-pressed={isLoopSelection}
                  onClick={() => toggleLoopForSection(section)}
                >
                  <span>{section.label}</span>
                </button>
              );
            })}
          </div>
          <div className="waveform-wrap">
            <button className="waveform" type="button" aria-label="Seek through waveform" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); seek(((event.clientX - rect.left) / rect.width) * duration); }}>
              <span className="loop-range" style={{ left: `${(loopStart / duration) * 100}%`, width: `${((loopEnd - loopStart) / duration) * 100}%`, opacity: loopEnabled ? 1 : 0 }} />
              <span className="wave-bars" aria-hidden="true">{WAVEFORM.map((height, index) => <i key={index} style={{ height: `${height}%` }} className={(index / WAVEFORM.length) * duration <= currentTime ? "played" : ""} />)}</span>
              <span className="playhead" style={{ left: `${(currentTime / duration) * 100}%` }}><i /></span>
            </button>
          </div>
          <div className="map-legend"><span><i className="legend-current" />{formatTime(currentTime)}</span><span>{activeChord.chord} · {activeSection?.label}</span><span>{formatTime(remaining)} left</span></div>
        </Panel>

        <div className="workspace-grid">
          <Panel className="mixer-panel" id="mixer">
            <div className="panel-title-row"><div><span className="eyebrow">STEM MIXER</span><h2>Shape the rehearsal</h2></div><span className="engine-badge"><Activity size={15} />{availableStemCount ? `${availableStemCount} stems` : "Demo levels"}</span></div>
            <details className="stem-layout">
              <summary>
                <SlidersHorizontal size={17} />
                Choose stem layout
                <span>{stemSelection.stemIds.length} channels</span>
              </summary>
              <StemSelectionPicker
                value={stemSelection}
                onChange={updateStemSelection}
                heading="Stem layout and order"
              />
              <p className="stem-layout__note">
                Presets use the outputs supported by this Music.ai workflow. Background vocals and individual drum parts require additional matching workflows before they can appear here.
              </p>
            </details>
            <div className={`stem-stack ${stems.length > 6 ? "many-stems" : ""}`}>
              {stems.map((stem) => (
                <StemRow
                  key={stem.id}
                  stem={stem}
                  available={stem.id === "metronome" || (isAudioStemId(stem.id) && Boolean(analysis.stems[stem.id]))}
                  onVolume={(volume) => updateStem(stem.id, { volume })}
                  onPan={(pan) => updateStem(stem.id, { pan })}
                  onToggleMute={() => updateStem(stem.id, { muted: !stem.muted })}
                  onToggleSolo={() => updateStem(stem.id, { solo: !stem.solo })}
                />
              ))}
            </div>
            <div className="mixer-export" aria-busy={Boolean(exportBusy)}>
              <button
                type="button"
                className="hardware-button"
                disabled={!availableStemCount || Boolean(exportBusy)}
                onClick={() => void exportAudio("mix")}
              >
                <Download size={18} />
                <span><strong>Export mix</strong><small>Current levels + pan · WAV</small></span>
              </button>
              <button
                type="button"
                className="hardware-button"
                disabled={!availableStemCount || Boolean(exportBusy)}
                onClick={() => void exportAudio("stems")}
              >
                <FolderArchive size={18} />
                <span><strong>Export stems</strong><small>Every original stem · ZIP</small></span>
              </button>
            </div>
            <p className="engine-limit" aria-live="polite">
              {exportBusy
                ? exportProgress
                : availableStemCount > 1
                  ? "Web Audio gain, solo and stereo pan · mix export preserves these settings."
                  : "Process a track to unlock functional mixing and exports."}
            </p>
          </Panel>

          <Panel className="practice-panel" id="practice">
            <div className="panel-title-row"><div><span className="eyebrow">PRACTICE ENGINE</span><h2>{isCountingIn ? "Count in…" : "Smart timing"}</h2></div><span className={`beat-orb ${(isPlaying || isCountingIn) && metronomeEnabled ? "on" : ""}`} key={beatPulse}>{countdownBeat ?? clickGrid[Math.max(0, lastBeatIndex.current)]?.beat ?? 1}</span></div>
            <button type="button" className={`feature-toggle ${metronomeEnabled ? "active" : ""}`} aria-pressed={metronomeEnabled} onClick={() => setMetronomeEnabled((value) => !value)}><span className="feature-icon"><TimerReset size={21} /></span><span><strong>Smart metronome</strong><small>Beat-map preview using browser timing</small></span><i /></button>
            <button type="button" className={`feature-toggle ${followTempoMap ? "active" : ""}`} aria-pressed={followTempoMap} onClick={() => setFollowTempoMap((value) => !value)}><span className="feature-icon"><Waves size={21} /></span><span><strong>Follow tempo map</strong><small>{followTempoMap ? "Natural timing changes stay intact" : "Locked to average BPM"}</small></span><i /></button>
            <div className="practice-grid">
              <div className="dial-card"><span>COUNT-IN</span><div><button type="button" aria-label="Decrease count-in" onClick={() => setCountIn((value) => Math.max(0, value - 1))}><Minus size={16} /></button><strong>{countIn}</strong><button type="button" aria-label="Increase count-in" onClick={() => setCountIn((value) => Math.min(4, value + 1))}><Plus size={16} /></button></div><small>bars</small></div>
              <div className="dial-card"><span>SPEED</span><div><button type="button" aria-label="Decrease speed" onClick={() => setPlaybackRate((value) => Math.max(0.5, Math.round((value - 0.05) * 100) / 100))}><Minus size={16} /></button><strong>{playbackRate.toFixed(2)}×</strong><button type="button" aria-label="Increase speed" onClick={() => setPlaybackRate((value) => Math.min(1.5, Math.round((value + 0.05) * 100) / 100))}><Plus size={16} /></button></div><small>tempo</small></div>
              <div className="dial-card wide"><span>KEY / PITCH</span><div><button type="button" aria-label="Decrease pitch preview" onClick={() => setPitch((value) => Math.max(-12, value - 1))}>♭</button><strong>{pitch > 0 ? `+${pitch}` : pitch}</strong><button type="button" aria-label="Increase pitch preview" onClick={() => setPitch((value) => Math.min(12, value + 1))}>♯</button></div><small>Display preview only · audio pitch shift is not connected</small></div>
            </div>
            <div className="analysis-readout"><Gauge size={18} /><span><strong>{analysis.bpm > 0 ? `${Math.round(analysis.bpm)} BPM` : "Tempo unavailable"}</strong><small>{analysis.beats.length} beat markers · {analysis.chords.length} chord changes</small></span></div>
          </Panel>
        </div>
          </>
        )}
      </main>

      {activeView !== "library" && <div ref={controlDockRef} className="control-dock" role="group" aria-label="Playback controls">
        <div className="seek-row"><time>{formatTime(currentTime)}</time><input type="range" min="0" max={Math.max(1, duration)} step="0.01" value={Math.min(currentTime, duration)} onChange={(event) => seek(Number(event.target.value))} aria-label="Track position" /><time>-{formatTime(remaining)}</time></div>
        <div className="transport-row">
          <IconButton label="Toggle section loop" pressed={loopEnabled} className={loopEnabled ? "active" : ""} onClick={() => setLoopEnabled((value) => !value)}><Repeat2 size={21} /></IconButton>
          <IconButton label="Back 10 seconds" onClick={() => seek(currentTime - 10)}><RotateCcw size={21} /><small>10</small></IconButton>
          <button type="button" className="play-button hardware-button" aria-label={isCountingIn ? "Cancel count-in" : isPlaying ? "Pause" : "Play"} onClick={() => void togglePlayback()}>{isCountingIn || isPlaying ? <Pause size={29} fill="currentColor" /> : <Play size={31} fill="currentColor" />}</button>
          <IconButton label="Forward 10 seconds" onClick={() => seek(currentTime + 10)}><RotateCcw className="flip" size={21} /><small>10</small></IconButton>
          <IconButton label="Open practice controls" onClick={() => scrollTo("practice")}><SlidersHorizontal size={22} /></IconButton>
        </div>
      </div>}

      <nav ref={bottomNavRef} className="bottom-nav" aria-label="Primary navigation">
        <button type="button" className={activeView === "library" ? "active" : ""} aria-current={activeView === "library" ? "page" : undefined} onClick={() => { setActiveView("library"); window.scrollTo({ top: 0, behavior: preferredScrollBehavior() }); }}><Library size={21} /><span>Library</span></button>
        <button type="button" className={activeView === "mixer" ? "active" : ""} aria-current={activeView === "mixer" ? "page" : undefined} onClick={() => { setActiveView("mixer"); window.requestAnimationFrame(() => scrollTo("mixer")); }}><SlidersHorizontal size={21} /><span>Mixer</span></button>
        <button type="button" className={activeView === "practice" ? "active" : ""} aria-current={activeView === "practice" ? "page" : undefined} onClick={() => { setActiveView("practice"); window.requestAnimationFrame(() => scrollTo("practice")); }}><Headphones size={21} /><span>Practice</span></button>
        <button type="button" className={importOpen ? "active" : ""} aria-haspopup="dialog" aria-expanded={importOpen} onClick={openImport}><Import size={21} /><span>Import</span></button>
      </nav>

      <ImportModal
        open={importOpen}
        busy={processingBusy}
        onClose={closeImport}
        onFile={(file) => void handleFile(file)}
        onUrl={(url) => void handleUrl(url)}
        onError={setToast}
        remoteReady={backendConfigured && Boolean(userEmail)}
        remoteUnavailableReason={backendConfigured
          ? "Sign in as the owner from Menu to enable remote imports."
          : "Configure the secure Firebase backend to enable remote imports."}
        spotifyEnabled={spotifyImportEnabled}
      />
      <SettingsSheet
        open={settingsOpen}
        userEmail={userEmail}
        onClose={closeSettings}
        onSignIn={() => void import("./lib/firebase")
          .then(({ signInOwner }) => signInOwner())
          .catch((error) => setToast(error instanceof Error ? error.message : "Sign-in failed"))}
        onSignOut={() => void import("./lib/firebase").then(({ signOutOwner }) => signOutOwner())}
      />
      {toast && <div className="toast" role="status"><Volume2 size={17} />{toast}</div>}
    </div>
  );
}
