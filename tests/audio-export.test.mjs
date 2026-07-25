import assert from "node:assert/strict";
import test from "node:test";

import {
  createStoredZip,
  crc32,
  encodePcm16Wav,
  safeFileBase,
} from "../src/lib/audioExport.ts";

test("encodes interleaved stereo PCM with a valid WAV header", () => {
  const wave = encodePcm16Wav([
    new Float32Array([-1, 0.5]),
    new Float32Array([1, -0.5]),
  ], 44_100);
  const bytes = new Uint8Array(wave);
  const view = new DataView(wave);

  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WAVE");
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 44_100);
  assert.equal(view.getUint32(40, true), 8);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(46, true), 32767);
});

test("creates a stored ZIP containing named stem files", async () => {
  const zip = await createStoredZip([
    { name: "song/song-vocals.wav", blob: new Blob(["vox"]) },
    { name: "song/song-drums.wav", blob: new Blob(["drums"]) },
  ]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const view = new DataView(bytes.buffer);

  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(bytes.byteLength - 22, true), 0x06054b50);
  assert.match(text, /song\/song-vocals\.wav/);
  assert.match(text, /song\/song-drums\.wav/);
});

test("uses standard CRC32 and filesystem-safe export names", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(safeFileBase("  Beyoncé / Demo: 01?  "), "Beyonce-Demo-01");
});
