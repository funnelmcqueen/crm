import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DialerContext, type DialerContextValue } from "@/components/dialer/dialer-context";
import { Sheet } from "@/components/ui/sheet";
import {
  ManualKeypadControls,
  PersistentKeypad,
  manualDialPreview,
  placeManualCall,
} from "@/components/dialer/persistent-keypad";

function dialer(kind: "idle" | "tel-pending" = "idle") {
  return { state: kind === "idle" ? { kind } : { kind }, dialMode: "tel", connecting: false } as DialerContextValue;
}

describe("persistent manual keypad", () => {
  it("shows a fixed labelled launcher above the mobile navigation only while idle", () => {
    const idle = renderToStaticMarkup(createElement(DialerContext.Provider, { value: dialer() }, createElement(PersistentKeypad)));
    const active = renderToStaticMarkup(createElement(DialerContext.Provider, { value: dialer("tel-pending") }, createElement(PersistentKeypad)));
    expect(idle).toContain('aria-label="Open keypad"');
    expect(idle).toContain("Keypad");
    expect(idle).toContain("bottom-[calc(var(--bottom-nav-height)+0.75rem)]");
    expect(active).not.toContain('aria-label="Open keypad"');
  });

  it("renders a labelled editable number, dial keys, and 48px controls", () => {
    const html = renderToStaticMarkup(createElement(Sheet, { open: true }, createElement(ManualKeypadControls, {
      value: "2125550123", busy: false, error: "", onValueChange: () => {}, onCall: () => {}, onClose: () => {},
    })));
    expect(html).toContain('aria-label="Phone number"');
    expect(html).toContain('aria-label="Star"');
    expect(html).toContain('aria-label="Pound"');
    expect(html).toContain('aria-label="Backspace"');
    expect(html).toContain('aria-label="Call number"');
    expect(html).toContain('aria-label="Close keypad"');
    expect(html).toContain("(212) 555-0123");
    expect((html.match(/min-h-12/g) ?? []).length).toBeGreaterThanOrEqual(15);
  });

  it("previews only valid numbers and disables calling invalid entries", () => {
    expect(manualDialPreview("2125550123")).toEqual({ e164: "+12125550123", display: "(212) 555-0123" });
    expect(manualDialPreview("123#")).toBeNull();
    const html = renderToStaticMarkup(createElement(Sheet, { open: true }, createElement(ManualKeypadControls, {
      value: "123#", busy: false, error: "", onValueChange: () => {}, onCall: () => {}, onClose: () => {},
    })));
    expect(html).toContain('aria-label="Call number" disabled=""');
  });

  it("prevents closing the sheet while manual call creation is pending", () => {
    const html = renderToStaticMarkup(createElement(Sheet, { open: true }, createElement(ManualKeypadControls, {
      value: "2125550123", busy: true, error: "", onValueChange: () => {}, onCall: () => {}, onClose: () => {},
    })));
    expect(html).toContain('aria-label="Close keypad" disabled=""');
  });

  it("awaits a recorded TEL call before opening the phone app", async () => {
    let resolve!: (value: boolean) => void;
    const beginManualTelCall = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    const startManualCall = vi.fn();
    const openTel = vi.fn();
    const pending = placeManualCall("2125550123", { dialMode: "tel", beginManualTelCall, startManualCall }, openTel);
    expect(openTel).not.toHaveBeenCalled();
    resolve(true);
    expect(await pending).toBe(true);
    expect(beginManualTelCall).toHaveBeenCalledWith({ phone: "2125550123", label: "(212) 555-0123" });
    expect(openTel).toHaveBeenCalledWith("tel:+12125550123");
    expect(startManualCall).not.toHaveBeenCalled();
  });

  it("does not open TEL on refusal and routes in-app mode to the in-app method", async () => {
    const openTel = vi.fn();
    const beginManualTelCall = vi.fn().mockResolvedValue(false);
    const startManualCall = vi.fn().mockResolvedValue(undefined);
    expect(await placeManualCall("2125550123", { dialMode: "tel", beginManualTelCall, startManualCall }, openTel)).toBe(false);
    expect(openTel).not.toHaveBeenCalled();
    expect(await placeManualCall("2125550123", { dialMode: "in-app", beginManualTelCall, startManualCall }, openTel)).toBe(true);
    expect(startManualCall).toHaveBeenCalledWith({ phone: "2125550123", label: "(212) 555-0123" });
    expect(await placeManualCall("12", { dialMode: "in-app", beginManualTelCall, startManualCall }, openTel)).toBe(false);
    expect(startManualCall).toHaveBeenCalledTimes(1);
  });
});
