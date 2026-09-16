"use client";

import { Mic, Square, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { AUDIO_INPUT_STORAGE_KEY, AUDIO_OUTPUT_STORAGE_KEY, useDialer } from "@/components/dialer/dialer-context";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createToneWav, deviceOptions, inputLevelFromTimeDomain, supportsOutputSelection, type DeviceOption } from "./audio-utils";

const DEFAULT_DEVICE = "default";

// --- per-device stored choice ------------------------------------------------------------------

const storageListeners = new Set<() => void>();

function readStored(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStored(key: string, value: string): void {
  try {
    if (value === "" || value === DEFAULT_DEVICE) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Blocked storage: the choice applies to this page only.
  }
  for (const listener of storageListeners) listener();
}

function subscribeStored(listener: () => void): () => void {
  storageListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    storageListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function useStoredDevice(key: string): [string, (value: string) => void] {
  const value = useSyncExternalStore(
    subscribeStored,
    () => readStored(key),
    () => "",
  );
  return [value, (next: string) => writeStored(key, next)];
}

const noopSubscribe = () => () => {};

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function micErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access is blocked. Allow it in your browser's site settings, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Microphone not found. Plug one in or pick another.";
  if (name === "NotReadableError") return "Another app is using the microphone.";
  return "The microphone could not be started.";
}

export function AudioSection({ inAppAvailable }: { inAppAvailable: boolean }) {
  const dialer = useDialer();
  const mediaSupported = useSyncExternalStore(
    noopSubscribe,
    () => typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia),
    () => true,
  );
  const outputSupported = useSyncExternalStore(noopSubscribe, () => supportsOutputSelection(), () => false);

  const [inputs, setInputs] = useState<DeviceOption[]>([]);
  const [outputs, setOutputs] = useState<DeviceOption[]>([]);
  const [inputId, setInputId] = useStoredDevice(AUDIO_INPUT_STORAGE_KEY);
  const [outputId, setOutputId] = useStoredDevice(AUDIO_OUTPUT_STORAGE_KEY);
  const [testing, setTesting] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  const meterRef = useRef<HTMLDivElement>(null);
  const meterTrackRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);

  const refreshDevices = useCallback(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        setInputs(deviceOptions(devices, "audioinput"));
        setOutputs(deviceOptions(devices, "audiooutput"));
      })
      .catch(() => {
        // Keep the last list.
      });
  }, []);

  useEffect(() => {
    if (!inAppAvailable || !navigator.mediaDevices) return;
    const media = navigator.mediaDevices;
    // The device list is external state: read it once, then follow devicechange events.
    const timer = window.setTimeout(refreshDevices, 0);
    media.addEventListener?.("devicechange", refreshDevices);
    return () => {
      window.clearTimeout(timer);
      media.removeEventListener?.("devicechange", refreshDevices);
    };
  }, [inAppAvailable, refreshDevices]);

  const stopMeter = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    void contextRef.current?.close().catch(() => undefined);
    contextRef.current = null;
    if (meterRef.current) meterRef.current.style.transform = "scaleX(0)";
    meterTrackRef.current?.setAttribute("aria-valuenow", "0");
  }, []);

  useEffect(() => stopMeter, [stopMeter]);

  const startMeter = useCallback(
    async (deviceId: string) => {
      stopMeter();
      setMicError(null);
      const Ctor = audioContextCtor();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId && deviceId !== DEFAULT_DEVICE ? { deviceId: { exact: deviceId } } : true,
        });
        streamRef.current = stream;
        // Labels appear once permission is granted.
        void refreshDevices();
        if (!Ctor) {
          setTesting(true);
          return;
        }
        const context = new Ctor();
        contextRef.current = context;
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(samples);
          const level = inputLevelFromTimeDomain(samples);
          if (meterRef.current) meterRef.current.style.transform = `scaleX(${level})`;
          meterTrackRef.current?.setAttribute("aria-valuenow", String(Math.round(level * 100)));
          frameRef.current = requestAnimationFrame(tick);
        };
        tick();
        setTesting(true);
      } catch (error) {
        stopMeter();
        setTesting(false);
        setMicError(micErrorMessage(error));
      }
    },
    [refreshDevices, stopMeter],
  );

  async function chooseInput(id: string) {
    setInputId(id);
    if (testing) void startMeter(id);
    if (dialer?.deviceReady) {
      try {
        await dialer.setInputDevice(id);
      } catch {
        toast.error("That microphone could not be used for calls.");
      }
    }
  }

  async function chooseOutput(id: string) {
    setOutputId(id);
    if (dialer?.deviceReady) {
      try {
        await dialer.setOutputDevice(id);
      } catch {
        toast.error("That speaker could not be used for calls.");
      }
    }
  }

  async function testSpeaker() {
    setPlaying(true);
    try {
      if (dialer?.deviceReady && (await dialer.testSpeaker())) return;
      const url = URL.createObjectURL(new Blob([createToneWav() as BlobPart], { type: "audio/wav" }));
      const audio: SinkAudio = new Audio(url);
      audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
      if (outputSupported && outputId && outputId !== DEFAULT_DEVICE && audio.setSinkId) {
        await audio.setSinkId(outputId);
      }
      await audio.play();
      await new Promise<void>((resolve) => audio.addEventListener("ended", () => resolve(), { once: true }));
    } catch {
      toast.error("The test sound could not play. Check the speaker and your volume.");
    } finally {
      setPlaying(false);
    }
  }

  if (!inAppAvailable) {
    return (
      <p className="text-sm text-muted-foreground">
        In-app calling is off, so calls use your phone and its own microphone and speaker. Nothing to set up here.
      </p>
    );
  }
  if (!mediaSupported) {
    return <p className="text-sm text-muted-foreground">This browser can&rsquo;t access audio devices. Try Chrome, Edge or Safari.</p>;
  }

  const selectedInput = inputs.some((d) => d.id === inputId) ? inputId : (inputs[0]?.id ?? "");
  const selectedOutput = outputs.some((d) => d.id === outputId) ? outputId : (outputs[0]?.id ?? "");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor="settings-microphone">Microphone</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select value={selectedInput} onValueChange={(id) => void chooseInput(id)} disabled={inputs.length === 0}>
            <SelectTrigger id="settings-microphone" className="w-full min-w-0 px-3 text-base data-[size=default]:h-12 sm:flex-1 md:text-sm">
              <SelectValue placeholder={inputs.length === 0 ? "Test the microphone to list devices" : "Choose a microphone"} />
            </SelectTrigger>
            <SelectContent position="popper" align="start" className="max-h-80">
              {inputs.map((device) => (
                <SelectItem key={device.id} value={device.id} className="min-h-12">
                  {device.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            className="h-12 gap-2 px-4"
            onClick={() => {
              if (testing) {
                stopMeter();
                setTesting(false);
              } else {
                void startMeter(selectedInput);
              }
            }}
          >
            {testing ? <Square aria-hidden /> : <Mic aria-hidden />}
            {testing ? "Stop test" : "Test microphone"}
          </Button>
        </div>
        <div
          ref={meterTrackRef}
          role="meter"
          aria-label="Microphone level"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
          className="h-3 overflow-hidden rounded-full bg-muted"
        >
          <div ref={meterRef} className="h-full w-full origin-left bg-success" style={{ transform: "scaleX(0)" }} />
        </div>
        <p role={micError ? "alert" : undefined} className={micError ? "text-sm font-semibold text-destructive" : "text-xs text-muted-foreground"}>
          {micError ?? (testing ? "Speak normally: the bar should move." : "The bar moves while you talk during a test.")}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="settings-speaker">Speaker</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          {outputSupported ? (
            <Select value={selectedOutput} onValueChange={(id) => void chooseOutput(id)} disabled={outputs.length === 0}>
              <SelectTrigger id="settings-speaker" className="w-full min-w-0 px-3 text-base data-[size=default]:h-12 sm:flex-1 md:text-sm">
                <SelectValue placeholder={outputs.length === 0 ? "Test the microphone to list devices" : "Choose a speaker"} />
              </SelectTrigger>
              <SelectContent position="popper" align="start" className="max-h-80">
                {outputs.map((device) => (
                  <SelectItem key={device.id} value={device.id} className="min-h-12">
                    {device.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p id="settings-speaker" className="flex min-h-12 items-center text-sm text-muted-foreground sm:flex-1">
              This browser always uses your system&rsquo;s default speaker. Change it in your computer&rsquo;s sound settings.
            </p>
          )}
          <Button type="button" variant="outline" className="h-12 gap-2 px-4" onClick={() => void testSpeaker()} disabled={playing}>
            <Volume2 aria-hidden />
            {playing ? "Playing…" : "Test speaker"}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Your choices are saved on this device and used for in-app calls.</p>
    </div>
  );
}
