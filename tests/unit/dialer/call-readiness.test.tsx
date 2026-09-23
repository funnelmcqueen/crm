import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CallButton } from "@/components/dialer/call-button";
import { DialerContext, type DialerContextValue } from "@/components/dialer/dialer-context";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("invalid-number call controls", () => {
  it.each(["", "123", "+12", "invalid"])("does not offer a dial link for %j", (phone) => {
    const value = { state: { kind: "idle" }, dialMode: "tel", connecting: false } as DialerContextValue;
    const html = renderToStaticMarkup(createElement(TooltipProvider, null,
      createElement(DialerContext.Provider, { value }, createElement(CallButton, {
        lead: { id: "lead", businessName: "Business", contactName: null, phone, status: "NEW" },
      }))));
    expect(html).not.toContain('href="tel:');
    expect(html).toContain('disabled=""');
  });
});
