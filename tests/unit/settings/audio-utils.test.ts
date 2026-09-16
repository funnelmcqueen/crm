import { describe, expect, it } from "vitest";
import {
  createToneWav,
  deviceOptions,
  inputLevelFromTimeDomain,
  supportsOutputSelection,
} from "@/components/settings/audio-utils";

describe("createToneWav", () => {
  it("writes a valid mono 16-bit PCM WAV header and sample count", () => {
    const bytes = createToneWav({ durationMs: 500, sampleRate: 8000 });
    const view = new DataView(bytes.buffer);
    const ascii = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
    expect(ascii(0)).toBe("RIFF");
    expect(ascii(8)).toBe("WAVE");
    expect(ascii(12)).toBe("fmt ");
    expect(ascii(36)).toBe("data");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(4000 * 2);
    expect(view.getUint32(4, true)).toBe(bytes.length - 8);
    expect(bytes.length).toBe(44 + 8000);
  });

  it("fades in and out and stays within the volume", () => {
    const bytes = createToneWav({ durationMs: 200, sampleRate: 8000, volume: 0.5 });
    const view = new DataView(bytes.buffer);
    const samples = Array.from({ length: (bytes.length - 44) / 2 }, (_, i) => view.getInt16(44 + i * 2, true));
    expect(samples[0]).toBe(0);
    expect(Math.abs(samples[samples.length - 1])).toBeLessThan(200);
    expect(Math.max(...samples.map(Math.abs))).toBeLessThanOrEqual(Math.ceil(0.5 * 0x7fff));
    expect(Math.max(...samples)).toBeGreaterThan(10_000);
  });
});

describe("inputLevelFromTimeDomain", () => {
  it("is 0 for silence and empty input, higher for louder input, capped at 1", () => {
    expect(inputLevelFromTimeDomain([])).toBe(0);
    expect(inputLevelFromTimeDomain(new Uint8Array(256).fill(128))).toBe(0);
    const quiet = Uint8Array.from({ length: 256 }, (_, i) => (i % 2 ? 131 : 125));
    const loud = Uint8Array.from({ length: 256 }, (_, i) => (i % 2 ? 200 : 56));
    const max = Uint8Array.from({ length: 256 }, (_, i) => (i % 2 ? 255 : 0));
    expect(inputLevelFromTimeDomain(quiet)).toBeGreaterThan(0);
    expect(inputLevelFromTimeDomain(loud)).toBeGreaterThan(inputLevelFromTimeDomain(quiet));
    expect(inputLevelFromTimeDomain(max)).toBe(1);
  });
});

describe("supportsOutputSelection", () => {
  it("checks for setSinkId on the media element prototype", () => {
    expect(supportsOutputSelection({ setSinkId() {} })).toBe(true);
    expect(supportsOutputSelection({})).toBe(false);
    expect(supportsOutputSelection(undefined)).toBe(false);
  });
});

describe("deviceOptions", () => {
  it("keeps one kind, drops blank and duplicate ids, and numbers unlabeled devices", () => {
    const devices = [
      { deviceId: "default", kind: "audioinput", label: "Default - Headset" },
      { deviceId: "a1", kind: "audioinput", label: "" },
      { deviceId: "a1", kind: "audioinput", label: "dup" },
      { deviceId: "", kind: "audioinput", label: "hidden" },
      { deviceId: "o1", kind: "audiooutput", label: "Speakers" },
      { deviceId: "a2", kind: "audioinput", label: "  USB Mic  " },
    ];
    expect(deviceOptions(devices, "audioinput")).toEqual([
      { id: "default", label: "Default - Headset" },
      { id: "a1", label: "Microphone 2" },
      { id: "a2", label: "USB Mic" },
    ]);
    expect(deviceOptions(devices, "audiooutput")).toEqual([{ id: "o1", label: "Speakers" }]);
  });
});
