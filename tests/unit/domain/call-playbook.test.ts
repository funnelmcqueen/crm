import { describe, expect, it } from "vitest";
import { MARCH_RESTAURANT_PLAYBOOK, playbookGreeting } from "@/lib/domain/call-playbook";

describe("March restaurant callback playbook", () => {
  it("keeps the playbook versioned and ready to guide every step of a callback", () => {
    expect(MARCH_RESTAURANT_PLAYBOOK.id).toBe("march-restaurants-paid");
    expect(MARCH_RESTAURANT_PLAYBOOK.version).toBe("v3");
    expect(MARCH_RESTAURANT_PLAYBOOK.stages.map((stage) => stage.id)).toEqual(["open", "hook", "offer", "ask", "booked"]);
    expect(MARCH_RESTAURANT_PLAYBOOK.objections.map((objection) => objection.id)).toContain("price");
    expect(MARCH_RESTAURANT_PLAYBOOK.bookingHandoff).toContain("calendar invite");
  });

  it("uses the contact and current agent's first names without leaking null or whitespace into the opening", () => {
    expect(playbookGreeting("Marco Rossi", "Veli Reci")).toContain("Marco");
    expect(playbookGreeting("Marco Rossi", "Veli Reci")).toContain("Veli");
    expect(playbookGreeting("  Ana  ", "  Veli  ")).toContain("Ana");
    expect(playbookGreeting(null, null)).not.toContain("null");
  });
});
