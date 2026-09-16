// Pure, browser-safe helpers for the Settings audio section (microphone meter and speaker test).

export interface ToneOptions {
  frequency?: number;
  durationMs?: number;
  sampleRate?: number;
  /** 0..1 */
  volume?: number;
}

/** A short mono 16-bit PCM WAV sine tone with 20ms fades (no clicks), for "Test speaker". */
export function createToneWav({ frequency = 440, durationMs = 700, sampleRate = 16_000, volume = 0.35 }: ToneOptions = {}): Uint8Array {
  const sampleCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const dataBytes = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  const amplitude = Math.max(0, Math.min(1, volume)) * 0x7fff;
  const fade = Math.min(Math.round(sampleRate * 0.02), Math.floor(sampleCount / 2));
  for (let i = 0; i < sampleCount; i += 1) {
    const envelope = fade === 0 ? 1 : Math.min(1, i / fade, (sampleCount - 1 - i) / fade);
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude * envelope);
    view.setInt16(44 + i * 2, sample, true);
  }
  return new Uint8Array(buffer);
}

/**
 * 0..1 loudness from AnalyserNode.getByteTimeDomainData() samples (128 = silence). The RMS is scaled so normal
 * speech fills most of the meter.
 */
export function inputLevelFromTimeDomain(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const centered = (samples[i] - 128) / 128;
    sum += centered * centered;
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.max(0, Math.min(1, Math.sqrt(rms) * 1.6 - 0.05));
}

/** Whether audio output can be routed to a chosen speaker in this browser (HTMLMediaElement.setSinkId). */
export function supportsOutputSelection(proto: object | undefined = globalThis.HTMLMediaElement?.prototype): boolean {
  return proto !== undefined && "setSinkId" in proto;
}

export interface MediaDeviceLike {
  deviceId: string;
  kind: string;
  label: string;
}

export interface DeviceOption {
  id: string;
  label: string;
}

/**
 * Options for one device kind. Browsers hide labels (and sometimes ids) until microphone permission is granted,
 * and list "default"/"communications" aliases; aliases keep their label and devices without a label get a number.
 */
export function deviceOptions(devices: readonly MediaDeviceLike[], kind: "audioinput" | "audiooutput"): DeviceOption[] {
  const noun = kind === "audioinput" ? "Microphone" : "Speaker";
  const seen = new Set<string>();
  const options: DeviceOption[] = [];
  for (const device of devices) {
    if (device.kind !== kind || device.deviceId === "" || seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    options.push({ id: device.deviceId, label: device.label.trim() || `${noun} ${options.length + 1}` });
  }
  return options;
}
