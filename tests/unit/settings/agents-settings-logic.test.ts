import { describe, expect, it } from "vitest";
import { endOfDayInTz, startOfDayInTz } from "@/lib/domain/time";
import {
  activityRangeBounds,
  bulkReassignSchema,
  createAgentSchema,
  generateStrongPassword,
  parseActivityRange,
  parseAgentActivity,
  updateAgentProfileSchema,
} from "@/server/services/agents";
import {
  MAX_VOICEMAIL_GREETING_LENGTH,
  changePasswordSchema,
  companySettingsSchema,
} from "@/server/services/settings";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("generateStrongPassword", () => {
  it("is 20 characters with lower, upper, digit and symbol", () => {
    for (let i = 0; i < 200; i += 1) {
      const password = generateStrongPassword();
      expect(password).toHaveLength(20);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[2-9]/);
      expect(password).toMatch(/[-_!@#%+=]/);
      expect(password).toMatch(/^[A-Za-z2-9\-_!@#%+=]+$/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateStrongPassword()));
    expect(seen.size).toBe(500);
  });
});

describe("createAgentSchema", () => {
  const valid = { name: " Alex ", email: " Alex@Example.COM ", dailyCallTarget: 50, timezone: "America/Chicago" };

  it("trims and lowercases", () => {
    expect(createAgentSchema.parse(valid)).toEqual({
      name: "Alex",
      email: "alex@example.com",
      dailyCallTarget: 50,
      timezone: "America/Chicago",
      primaryLocale: "en",
    });
  });

  it.each(["en", "de"] as const)("accepts primary locale %s", (primaryLocale) => {
    expect(createAgentSchema.parse({ ...valid, primaryLocale }).primaryLocale).toBe(primaryLocale);
  });

  it("rejects unsupported primary locales", () => {
    expect(createAgentSchema.safeParse({ ...valid, primaryLocale: "fr" }).success).toBe(false);
  });

  it("accepts a numeric string target from a form", () => {
    expect(createAgentSchema.parse({ ...valid, dailyCallTarget: "75" }).dailyCallTarget).toBe(75);
  });

  it.each([
    ["blank name", { name: "   " }],
    ["long name", { name: "x".repeat(201) }],
    ["bad email", { email: "nope" }],
    ["negative target", { dailyCallTarget: -1 }],
    ["huge target", { dailyCallTarget: 1001 }],
    ["fractional target", { dailyCallTarget: 2.5 }],
    ["offset timezone", { timezone: "+05:00" }],
    ["lowercase timezone", { timezone: "america/chicago" }],
    ["unknown timezone", { timezone: "Mars/Base" }],
    ["extra field", { role: "ADMIN" }],
  ])("rejects %s", (_label, patch) => {
    expect(createAgentSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe("updateAgentProfileSchema", () => {
  it("needs at least one field and allows no others", () => {
    expect(updateAgentProfileSchema.safeParse({}).success).toBe(false);
    expect(updateAgentProfileSchema.safeParse({ active: false }).success).toBe(false);
    expect(updateAgentProfileSchema.safeParse({ in_app_calling_enabled: false }).success).toBe(false);
    expect(updateAgentProfileSchema.parse({ dailyCallTarget: 0 })).toEqual({ dailyCallTarget: 0 });
  });

  it("allows admins to update an agent's primary locale", () => {
    expect(updateAgentProfileSchema.parse({ primaryLocale: "de" })).toEqual({ primaryLocale: "de" });
    expect(updateAgentProfileSchema.safeParse({ primaryLocale: "fr" }).success).toBe(false);
  });
});

describe("bulkReassignSchema", () => {
  it("defaults to all statuses and treats an empty target as Unassigned", () => {
    expect(bulkReassignSchema.parse({ fromUserId: UUID_A, toUserId: "" })).toEqual({
      fromUserId: UUID_A,
      toUserId: null,
      statuses: null,
    });
    expect(bulkReassignSchema.parse({ fromUserId: UUID_A, toUserId: UUID_B, statuses: [] }).statuses).toBeNull();
    expect(bulkReassignSchema.parse({ fromUserId: UUID_A, toUserId: UUID_B, statuses: ["NEW", "NEW"] }).statuses).toEqual(["NEW"]);
  });

  it("rejects the same agent, bad ids and unknown statuses", () => {
    expect(bulkReassignSchema.safeParse({ fromUserId: UUID_A, toUserId: UUID_A }).success).toBe(false);
    expect(bulkReassignSchema.safeParse({ fromUserId: "x", toUserId: null }).success).toBe(false);
    expect(bulkReassignSchema.safeParse({ fromUserId: UUID_A, toUserId: null, statuses: ["LOST"] }).success).toBe(false);
  });
});

describe("companySettingsSchema", () => {
  const valid = {
    company_name: "Funnel McQueen",
    default_daily_target: 50,
    default_timezone: "America/New_York",
    voicemail_greeting: "Leave a message.",
  };

  it("accepts a greeting of exactly the maximum length and rejects one character more", () => {
    expect(companySettingsSchema.safeParse({ ...valid, voicemail_greeting: "a".repeat(MAX_VOICEMAIL_GREETING_LENGTH) }).success).toBe(true);
    const tooLong = companySettingsSchema.safeParse({ ...valid, voicemail_greeting: "a".repeat(MAX_VOICEMAIL_GREETING_LENGTH + 1) });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues[0]?.message).toBe("The voicemail greeting can be at most 500 characters.");
  });

  it("rejects blank values, bad targets, bad timezones and extra columns", () => {
    expect(companySettingsSchema.safeParse({ ...valid, voicemail_greeting: "   " }).success).toBe(false);
    expect(companySettingsSchema.safeParse({ ...valid, company_name: "" }).success).toBe(false);
    expect(companySettingsSchema.safeParse({ ...valid, default_daily_target: 5000 }).success).toBe(false);
    expect(companySettingsSchema.safeParse({ ...valid, default_timezone: "EST5EDT-ish" }).success).toBe(false);
    expect(companySettingsSchema.safeParse({ ...valid, id: false }).success).toBe(false);
  });
});

describe("changePasswordSchema", () => {
  it("requires at least 10 characters and a different password", () => {
    expect(changePasswordSchema.safeParse({ currentPassword: "old-password-1", newPassword: "short" }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ currentPassword: "old", newPassword: "          " }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ currentPassword: "same-password", newPassword: "same-password" }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ currentPassword: "", newPassword: "long-enough-pw" }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ currentPassword: "old", newPassword: "x".repeat(73) }).success).toBe(false);
    expect(changePasswordSchema.parse({ currentPassword: "old", newPassword: "long-enough-pw" })).toEqual({
      currentPassword: "old",
      newPassword: "long-enough-pw",
    });
  });
});

describe("activity ranges", () => {
  it("parses only known range keys", () => {
    expect(parseActivityRange("7d")).toBe("7d");
    expect(parseActivityRange(["30d", "7d"])).toBe("30d");
    expect(parseActivityRange("1y")).toBe("today");
    expect(parseActivityRange(undefined)).toBe("today");
  });

  it("today is [local midnight, next local midnight) in the given zone", () => {
    const now = Date.parse("2026-09-15T03:30:00Z"); // 22:30 on Sep 14 in Chicago
    const { from, to } = activityRangeBounds("today", "America/Chicago", now);
    expect(from.toISOString()).toBe("2026-09-14T05:00:00.000Z");
    expect(to.toISOString()).toBe("2026-09-15T05:00:00.000Z");
  });

  it("7 and 30 days include today and start at a local midnight, across a DST change", () => {
    const now = Date.parse("2026-11-03T15:00:00Z"); // Nov 3 in New York, DST ended Nov 1
    const week = activityRangeBounds("7d", "America/New_York", now);
    expect(week.from.toISOString()).toBe("2026-10-28T04:00:00.000Z"); // Oct 28 00:00 EDT
    expect(week.to.toISOString()).toBe("2026-11-04T05:00:00.000Z"); // Nov 4 00:00 EST
    const month = activityRangeBounds("30d", "America/New_York", now);
    expect(month.from.toISOString()).toBe("2026-10-05T04:00:00.000Z");
    expect(month.to).toEqual(week.to);
    expect(startOfDayInTz("America/New_York", month.from)).toEqual(month.from);
    expect(endOfDayInTz("America/New_York", now)).toEqual(week.to);
  });

  it("falls back to New York for an invalid zone", () => {
    const now = Date.parse("2026-09-15T12:00:00Z");
    expect(activityRangeBounds("today", "Nope/Zone", now)).toEqual(activityRangeBounds("today", "America/New_York", now));
  });
});

describe("parseAgentActivity", () => {
  const range = { key: "today" as const, from: "2026-09-15T04:00:00Z", to: "2026-09-16T04:00:00Z", timezone: "America/New_York" };

  it("derives connect rate and average call length, with zero guards", () => {
    const parsed = parseAgentActivity(
      {
        profile: { user_id: UUID_A, name: "", email: "a@x.test", role: "AGENT", active: true, clients: 3, leads_assigned: 9 },
        stats: { dials: 8, connected: 2, interested: 1, appointments: 1, talk_seconds: 600, calls_with_duration: 4, inbound_calls: 1, total_calls: 9 },
        outcomes: { CONNECTED: 2 },
        recent_calls: [{ id: UUID_B, created_at: "2026-09-15T10:00:00Z", direction: "INBOUND", mode: "IN_APP", outcome: null, duration_seconds: null, lead_id: null, business_name: null }],
      },
      range,
    );
    expect(parsed.profile.name).toBe("a@x.test");
    expect(parsed.stats).toMatchObject({ connectRate: 0.25, avgCallSeconds: 150, clients: 3, totalCalls: 9 });
    expect(parsed.recentCalls[0]).toMatchObject({ direction: "INBOUND", mode: "IN_APP", durationSeconds: null, businessName: null });

    const empty = parseAgentActivity({ profile: {}, stats: {}, outcomes: {}, recent_calls: [] }, range);
    expect(empty.stats).toMatchObject({ dials: 0, connectRate: 0, avgCallSeconds: 0 });
  });
});
