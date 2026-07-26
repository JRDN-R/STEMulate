const ADTS_SAMPLE_RATES = [
  96_000,
  88_200,
  64_000,
  48_000,
  44_100,
  32_000,
  24_000,
  22_050,
  16_000,
  12_000,
  11_025,
  8_000,
  7_350,
] as const;

export type AdtsFrame = {
  byteStart: number;
  byteEndExclusive: number;
  headerLength: 7 | 9;
  frameLength: number;
  sampleRate: number;
  channels: number;
  audioObjectType: number;
  sampleCount: number;
  data: Uint8Array;
};

export type ParseAdtsOptions = {
  /** Absolute offset represented by byte zero in `bytes`. */
  baseOffset?: number;
  /** Permit an incomplete final frame for incremental network reads. */
  allowTrailingPartialFrame?: boolean;
};

function malformed(offset: number, detail: string): TypeError {
  return new TypeError(`Invalid ADTS frame at byte ${offset}: ${detail}.`);
}

/**
 * Parses frame-aligned AAC/ADTS data without copying encoded frame payloads.
 */
export function parseAdtsFrames(
  input: ArrayBuffer | ArrayBufferView,
  options: ParseAdtsOptions = {},
): AdtsFrame[] {
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const baseOffset = options.baseOffset ?? 0;
  const frames: AdtsFrame[] = [];
  let offset = 0;

  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    if (remaining < 7) {
      if (options.allowTrailingPartialFrame) break;
      throw malformed(baseOffset + offset, "truncated header");
    }
    const byte0 = bytes[offset];
    const byte1 = bytes[offset + 1];
    if (byte0 !== 0xff || (byte1 & 0xf6) !== 0xf0) {
      throw malformed(baseOffset + offset, "sync word or layer is incorrect");
    }

    const protectionAbsent = (byte1 & 0x01) === 1;
    const headerLength = protectionAbsent ? 7 : 9;
    if (remaining < headerLength) {
      if (options.allowTrailingPartialFrame) break;
      throw malformed(baseOffset + offset, "truncated CRC header");
    }

    const byte2 = bytes[offset + 2];
    const byte3 = bytes[offset + 3];
    const byte4 = bytes[offset + 4];
    const byte5 = bytes[offset + 5];
    const byte6 = bytes[offset + 6];
    const sampleRateIndex = (byte2 & 0x3c) >>> 2;
    const sampleRate = ADTS_SAMPLE_RATES[sampleRateIndex];
    if (!sampleRate) {
      throw malformed(baseOffset + offset, "reserved sample-rate index");
    }
    const frameLength = (
      ((byte3 & 0x03) << 11)
      | (byte4 << 3)
      | ((byte5 & 0xe0) >>> 5)
    );
    if (frameLength < headerLength) {
      throw malformed(baseOffset + offset, "frame length is smaller than its header");
    }
    if (frameLength > remaining) {
      if (options.allowTrailingPartialFrame) break;
      throw malformed(baseOffset + offset, "truncated frame payload");
    }

    const channels = ((byte2 & 0x01) << 2) | ((byte3 & 0xc0) >>> 6);
    if (channels === 0) {
      throw malformed(baseOffset + offset, "program-config channel layouts are unsupported");
    }
    const rawDataBlocks = byte6 & 0x03;
    frames.push({
      byteStart: baseOffset + offset,
      byteEndExclusive: baseOffset + offset + frameLength,
      headerLength,
      frameLength,
      sampleRate,
      channels,
      audioObjectType: ((byte2 & 0xc0) >>> 6) + 1,
      sampleCount: 1_024 * (rawDataBlocks + 1),
      data: bytes.subarray(offset, offset + frameLength),
    });
    offset += frameLength;
  }

  if (frames.length === 0 && !options.allowTrailingPartialFrame) {
    throw malformed(baseOffset, "no complete frames");
  }
  return frames;
}
