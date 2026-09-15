export const TONE_SAMPLE_RATE = 8000;
export const TONE_SECONDS = 1.5;
const TONE_FREQUENCY_HZ = 440;
const FADE_SECONDS = 0.05;
const AMPLITUDE = 0.3;

/** A short 16-bit PCM mono WAV tone, so seeded voicemails play when Twilio is not configured. */
export function generateToneWav(sampleRate = TONE_SAMPLE_RATE, seconds = TONE_SECONDS): Uint8Array {
  const sampleCount = Math.round(sampleRate * seconds);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  const fadeSamples = Math.max(1, Math.round(sampleRate * FADE_SECONDS));
  for (let i = 0; i < sampleCount; i += 1) {
    const envelope = Math.min(1, i / fadeSamples, (sampleCount - 1 - i) / fadeSamples);
    const value = Math.sin((2 * Math.PI * TONE_FREQUENCY_HZ * i) / sampleRate) * AMPLITUDE * Math.max(0, envelope);
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export type ByteRange = { start: number; end: number };

/** A single `bytes=` range. Returns null when there is no usable header, "unsatisfiable" for 416. */
export function parseByteRange(header: string | null, size: number): ByteRange | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

let cachedTone: Uint8Array | undefined;

export function toneResponse(rangeHeader: string | null, headers: Record<string, string>): Response {
  cachedTone ??= generateToneWav();
  const tone = cachedTone;
  const base = { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", ...headers };
  const range = parseByteRange(rangeHeader, tone.byteLength);
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${tone.byteLength}` } });
  }
  if (range) {
    const slice = tone.slice(range.start, range.end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        ...base,
        "Content-Length": String(slice.byteLength),
        "Content-Range": `bytes ${range.start}-${range.end}/${tone.byteLength}`,
      },
    });
  }
  return new Response(tone.slice(), { status: 200, headers: { ...base, "Content-Length": String(tone.byteLength) } });
}
