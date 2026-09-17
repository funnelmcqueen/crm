import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = (relative: string): string => {
  const file = fileURLToPath(new URL(`../../../src/${relative}`, import.meta.url));
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

const playbook = source("components/leads/call-playbook.tsx");
const page = source("app/(app)/leads/[id]/page.tsx");

describe("lead workspace call playbook", () => {
  it("renders every stage and objection from the approved playbook beside the lead context", () => {
    expect(playbook).toContain('aria-label="Call playbook"');
    expect(playbook).toContain("playbook.stages.map");
    expect(playbook).toContain("playbook.objections.map");
    for (const label of ["Objections", "Booking handoff", "No-show recovery", "Call rules and guardrails"]) {
      expect(playbook, `missing ${label}`).toContain(label);
    }
    expect(page).toContain("<CallPlaybook contactName={lead.contactName} agentName={ctx.profile.name} />");
  });

  it("keeps every disclosure large enough for an agent on a phone", () => {
    expect(playbook).toContain("min-h-12");
  });
});
