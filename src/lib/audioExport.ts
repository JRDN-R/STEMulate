import {
  AUDIO_STEM_IDS,
  type AudioStemId,
  type StemSources,
  type StemState,
} from "./stems.ts";
import { createPanController, resolveStemMix } from "./audioMixer.ts";

type ExportProgress = (message: string) => void;

type DownloadedStem = {
  id: AudioStemId;
  blob: Blob;
  extension: string;
};

export type ExportDisposition = "downloaded" | "shared" | "cancelled";

const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-aiff": "aiff",
  "audio/x-m4a": "m4a",
  "audio/x-wav": "wav",
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function safeFileBase(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._ -]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return normalized.slice(0, 80) || "stemulate-track";
}

function extensionFor(url: string, contentType: string): string {
  const normalizedType = contentType.split(";")[0].trim().toLowerCase();
  const fromType = CONTENT_TYPE_EXTENSIONS[normalizedType];
  if (fromType) return fromType;
  try {
    const match = decodeURIComponent(new URL(url).pathname).match(/\.([a-z0-9]{2,5})$/i);
    if (match) return match[1].toLowerCase();
  } catch {
    // A failed URL parse is handled by the fetch that follows.
  }
  return "wav";
}

function availableSources(sources: StemSources): Array<[AudioStemId, string]> {
  return AUDIO_STEM_IDS.flatMap((id) => {
    const url = sources[id];
    return url ? [[id, url] as [AudioStemId, string]] : [];
  });
}

async function fetchStem(
  id: AudioStemId,
  url: string,
  signal?: AbortSignal,
): Promise<DownloadedStem> {
  const response = await fetch(url, { mode: "cors", signal });
  if (!response.ok) {
    throw new Error(`Could not download the ${id} stem (${response.status}).`);
  }
  const blob = await response.blob();
  return {
    id,
    blob,
    extension: extensionFor(url, blob.type || response.headers.get("content-type") || ""),
  };
}

export function encodePcm16Wav(
  channels: readonly Float32Array[],
  sampleRate: number,
): ArrayBuffer {
  if (channels.length < 1 || channels.length > 2) {
    throw new Error("WAV export supports one or two channels.");
  }
  const frameCount = channels[0].length;
  if (!channels.every((channel) => channel.length === frameCount)) {
    throw new Error("WAV channels must have matching lengths.");
  }

  const channelCount = channels.length;
  const bytesPerSample = 2;
  const dataSize = frameCount * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeText(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = clamp(channels[channel][frame], -1, 1);
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

export async function renderMixWav(
  sources: StemSources,
  stems: readonly StemState[],
  onProgress: ExportProgress = () => undefined,
  signal?: AbortSignal,
): Promise<Blob> {
  const entries = availableSources(sources);
  if (!entries.length) throw new Error("No processed stems are available to mix.");
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("This browser cannot render an offline audio mix.");
  }

  const decoder = new OfflineAudioContext(2, 1, 44_100);
  const decoded: Array<{ id: AudioStemId; buffer: AudioBuffer }> = [];
  for (let index = 0; index < entries.length; index += 1) {
    const [id, url] = entries[index];
    onProgress(`Loading ${id} · ${index + 1}/${entries.length}`);
    const downloaded = await fetchStem(id, url, signal);
    const arrayBuffer = await downloaded.blob.arrayBuffer();
    const buffer = await decoder.decodeAudioData(arrayBuffer);
    decoded.push({ id, buffer });
  }

  const sampleRate = clamp(decoded[0].buffer.sampleRate || 44_100, 8_000, 96_000);
  const duration = Math.max(...decoded.map((item) => item.buffer.duration));
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("The processed stems contain no playable audio.");
  }
  if (duration > 60 * 30) {
    throw new Error("Browser mix export is limited to 30 minutes per song.");
  }

  const frameCount = Math.max(1, Math.ceil(duration * sampleRate));
  const context = new OfflineAudioContext(2, frameCount, sampleRate);
  const resolved = resolveStemMix(stems);

  decoded.forEach(({ id, buffer }) => {
    const source = context.createBufferSource();
    const gain = context.createGain();
    const pan = createPanController(context);
    const mix = resolved[id] ?? { gain: 1, pan: 0 };
    source.buffer = buffer;
    gain.gain.value = mix.gain;
    pan.set(mix.pan, context);
    source.connect(gain).connect(pan.node).connect(context.destination);
    source.start(0);
  });

  onProgress("Rendering stereo mix");
  const rendered = await context.startRendering();
  onProgress("Encoding WAV");
  const wave = encodePcm16Wav(
    [rendered.getChannelData(0), rendered.getChannelData(1)],
    rendered.sampleRate,
  );
  return new Blob([wave], { type: "audio/wav" });
}

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    crcTable[index] = value >>> 0;
  }
  return crcTable;
}

export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function setUint16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}

function setUint32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

export async function createStoredZip(
  entries: readonly { name: string; blob: Blob }[],
): Promise<Blob> {
  if (!entries.length) throw new Error("There are no files to export.");
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const centralParts: BlobPart[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    const checksum = crc32(data);

    const local = new Uint8Array(30 + name.length);
    setUint32(local, 0, 0x04034b50);
    setUint16(local, 4, 20);
    setUint16(local, 6, 0x0800);
    setUint16(local, 8, 0);
    setUint32(local, 14, checksum);
    setUint32(local, 18, data.byteLength);
    setUint32(local, 22, data.byteLength);
    setUint16(local, 26, name.length);
    local.set(name, 30);
    parts.push(local, data);

    const central = new Uint8Array(46 + name.length);
    setUint32(central, 0, 0x02014b50);
    setUint16(central, 4, 20);
    setUint16(central, 6, 20);
    setUint16(central, 8, 0x0800);
    setUint16(central, 10, 0);
    setUint32(central, 16, checksum);
    setUint32(central, 20, data.byteLength);
    setUint32(central, 24, data.byteLength);
    setUint16(central, 28, name.length);
    setUint32(central, 42, offset);
    central.set(name, 46);
    centralParts.push(central);

    offset += local.byteLength + data.byteLength;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + (part as Uint8Array).byteLength, 0);
  const end = new Uint8Array(22);
  setUint32(end, 0, 0x06054b50);
  setUint16(end, 8, entries.length);
  setUint16(end, 10, entries.length);
  setUint32(end, 12, centralSize);
  setUint32(end, 16, offset);

  return new Blob([...parts, ...centralParts, end], { type: "application/zip" });
}

export async function packageStemsZip(
  sources: StemSources,
  trackTitle: string,
  onProgress: ExportProgress = () => undefined,
  signal?: AbortSignal,
): Promise<Blob> {
  const entries = availableSources(sources);
  if (!entries.length) throw new Error("No processed stems are available to export.");
  const title = safeFileBase(trackTitle);
  const files: Array<{ name: string; blob: Blob }> = [];

  for (let index = 0; index < entries.length; index += 1) {
    const [id, url] = entries[index];
    onProgress(`Downloading ${id} · ${index + 1}/${entries.length}`);
    const downloaded = await fetchStem(id, url, signal);
    files.push({
      name: `${title}/${title}-${id}.${downloaded.extension}`,
      blob: downloaded.blob,
    });
  }

  onProgress("Packaging stems");
  return createStoredZip(files);
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function shareOrDownload(
  blob: Blob,
  fileName: string,
  title: string,
): Promise<ExportDisposition> {
  const file = new File([blob], fileName, { type: blob.type });
  const shareData: ShareData = { files: [file], title };
  if (typeof navigator.share === "function" && navigator.canShare?.(shareData)) {
    try {
      await navigator.share(shareData);
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
      // Rendering/fetching can consume transient user activation in Safari.
      // A normal download remains available when the share sheet is rejected.
    }
  }
  downloadBlob(blob, fileName);
  return "downloaded";
}
