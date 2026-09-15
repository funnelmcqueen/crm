import type { CallModePreference, DialerDriverName } from "./types";

export type DialMode = "in-app" | "tel";

export interface ResolveDialModeInput {
  preference: CallModePreference;
  defaultDriver: DialerDriverName;
  isIOS: boolean;
  inAppEnabled: boolean;
  deviceReady: boolean;
}

/** ARCHITECTURE section 6. */
export function resolveDialMode(input: ResolveDialModeInput): DialMode {
  if (input.defaultDriver === "tel" || !input.inAppEnabled) return "tel";
  if (input.preference === "phone") return "tel";
  if (input.preference === "in-app") return input.deviceReady ? "in-app" : "tel";
  return input.isIOS || !input.deviceReady ? "tel" : "in-app";
}

/** `tel:` link for a stored E.164 number. Anything but digits and a leading plus is dropped. */
export function telHref(e164: string): string {
  const trimmed = e164.trim();
  const digits = trimmed.replace(/\D/g, "");
  return `tel:${trimmed.startsWith("+") ? "+" : ""}${digits}`;
}

export interface DeviceInfo {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}

/** iPhone, iPod and iPad, including iPadOS 13+ which reports a desktop Mac user agent. */
export function isIOSDevice({ userAgent, platform = "", maxTouchPoints = 0 }: DeviceInfo): boolean {
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return true;
  if (/^(iPhone|iPad|iPod)/.test(platform)) return true;
  // Macs have no touch screen, so a "Macintosh" with multi-touch is an iPad in desktop mode.
  const macLike = platform === "MacIntel" || /\bMacintosh\b/.test(userAgent);
  return macLike && maxTouchPoints > 1;
}

export function currentDeviceIsIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return isIOSDevice({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  });
}
