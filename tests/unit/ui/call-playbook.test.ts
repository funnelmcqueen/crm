import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CallPlaybook } from "@/components/leads/call-playbook";

const source = (relative: string): string => {
  const file = fileURLToPath(new URL(`../../../src/${relative}`, import.meta.url));
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

const playbook = source("components/leads/call-playbook.tsx");
const page = source("app/(app)/leads/[id]/page.tsx");

describe("lead workspace call playbook", () => {
  it("renders every stage and objection from the approved playbook beside the lead context", () => {
    const html = renderToStaticMarkup(createElement(CallPlaybook, { contactName: "Ava Smith", agentName: "Maya Lee" }));
    expect(html).toContain('aria-label="Call playbook"');
    for (const label of ["Open", "Hook", "Offer", "Ask", "After booking", "How much is it?", "Just email me."]) {
      expect(html, `missing ${label}`).toContain(label);
    }
    for (const label of ["Objections", "Booking handoff", "No-show recovery", "Call rules and guardrails"]) {
      expect(html, `missing ${label}`).toContain(label);
    }
    expect(page).toContain("<CallPlaybook contactName={lead.contactName} agentName={ctx.profile.name} />");
  });

  it("keeps every disclosure large enough for an agent on a phone", () => {
    expect(playbook).toContain("min-h-12");
  });
});
