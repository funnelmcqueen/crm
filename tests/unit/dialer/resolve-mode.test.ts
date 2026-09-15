import { describe, expect, it } from "vitest";
import { isIOSDevice, resolveDialMode, telHref } from "@/lib/dialer/resolve-mode";
import type { CallModePreference, DialerDriverName } from "@/lib/dialer/types";

const PREFERENCES: CallModePreference[] = ["auto", "in-app", "phone"];
const DRIVERS: DialerDriverName[] = ["twilio", "tel", "mock"];
const BOOLS = [false, true];

describe("resolveDialMode", () => {
  // Every combination (3 x 3 x 2 x 2 x 2 = 72), against the rules written out in ARCHITECTURE section 6.
  const rows: Array<[CallModePreference, DialerDriverName, boolean, boolean, boolean, "in-app" | "tel"]> = [];
  for (const preference of PREFERENCES) {
    for (const defaultDriver of DRIVERS) {
      for (const isIOS of BOOLS) {
        for (const inAppEnabled of BOOLS) {
          for (const deviceReady of BOOLS) {
            let expected: "in-app" | "tel";
            if (defaultDriver === "tel" || !inAppEnabled) expected = "tel";
            else if (preference === "phone") expected = "tel";
            else if (preference === "in-app") expected = deviceReady ? "in-app" : "tel";
            else expected = isIOS || !deviceReady ? "tel" : "in-app";
            rows.push([preference, defaultDriver, isIOS, inAppEnabled, deviceReady, expected]);
          }
        }
      }
    }
  }

  it("covers the full truth table", () => {
    expect(rows).toHaveLength(72);
    // In-app only with a non-tel driver (2), calling enabled and a ready device: in-app pref on any
    // device (2) or auto on a non-iOS device (1) -> 2 x 3 = 6.
    expect(rows.filter((row) => row[5] === "in-app")).toHaveLength(6);
  });

  it.each(rows)("pref=%s driver=%s ios=%s enabled=%s ready=%s -> %s", (preference, defaultDriver, isIOS, inAppEnabled, deviceReady, expected) => {
    expect(resolveDialMode({ preference, defaultDriver, isIOS, inAppEnabled, deviceReady })).toBe(expected);
  });

  it("spells out the key rows", () => {
    const base = { preference: "auto", defaultDriver: "twilio", isIOS: false, inAppEnabled: true, deviceReady: true } as const;
    expect(resolveDialMode(base)).toBe("in-app");
    expect(resolveDialMode({ ...base, isIOS: true })).toBe("tel");
    expect(resolveDialMode({ ...base, deviceReady: false })).toBe("tel");
    expect(resolveDialMode({ ...base, inAppEnabled: false, preference: "in-app" })).toBe("tel");
    expect(resolveDialMode({ ...base, defaultDriver: "tel", preference: "in-app" })).toBe("tel");
    expect(resolveDialMode({ ...base, preference: "phone" })).toBe("tel");
    expect(resolveDialMode({ ...base, preference: "in-app", isIOS: true })).toBe("in-app");
    expect(resolveDialMode({ ...base, preference: "in-app", deviceReady: false })).toBe("tel");
    expect(resolveDialMode({ ...base, defaultDriver: "mock" })).toBe("in-app");
  });
});

describe("telHref", () => {
  it("builds a tel: link from E.164", () => {
    expect(telHref("+15555550123")).toBe("tel:+15555550123");
  });

  it("drops formatting characters", () => {
    expect(telHref(" +1 (212) 555-0123 ")).toBe("tel:+12125550123");
    expect(telHref("2125550123")).toBe("tel:2125550123");
    expect(telHref("+1 212 555 0123;ext=9")).toBe("tel:+121255501239");
  });
});

describe("isIOSDevice", () => {
  const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
  const IPHONE_CHROME =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0 Mobile/15E148 Safari/604.1";
  const IPAD_LEGACY =
    "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1";
  const IPOD = "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  const MAC_SAFARI =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
  const ANDROID =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Mobile Safari/537.36";
  const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36";

  it.each([
    ["iPhone Safari", { userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5 }, true],
    ["iPhone Chrome", { userAgent: IPHONE_CHROME, platform: "iPhone", maxTouchPoints: 5 }, true],
    ["iPhone UA without platform", { userAgent: IPHONE }, true],
    ["legacy iPad", { userAgent: IPAD_LEGACY, platform: "iPad", maxTouchPoints: 5 }, true],
    ["iPod touch", { userAgent: IPOD, platform: "iPod touch", maxTouchPoints: 5 }, true],
    ["iPadOS desktop-mode UA with touch", { userAgent: MAC_SAFARI, platform: "MacIntel", maxTouchPoints: 5 }, true],
    ["iPadOS desktop UA, platform unavailable", { userAgent: MAC_SAFARI, maxTouchPoints: 5 }, true],
    ["platform says iPhone", { userAgent: "SomeWebView/1.0", platform: "iPhone", maxTouchPoints: 5 }, true],
    ["Mac Safari", { userAgent: MAC_SAFARI, platform: "MacIntel", maxTouchPoints: 0 }, false],
    ["Mac with a single touch point reported", { userAgent: MAC_SAFARI, platform: "MacIntel", maxTouchPoints: 1 }, false],
    ["Android", { userAgent: ANDROID, platform: "Linux armv8l", maxTouchPoints: 5 }, false],
    ["Windows touch laptop", { userAgent: WINDOWS, platform: "Win32", maxTouchPoints: 10 }, false],
    ["empty", { userAgent: "" }, false],
  ])("%s", (_name, info, expected) => {
    expect(isIOSDevice(info)).toBe(expected);
  });
});
