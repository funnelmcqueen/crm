import { describe, expect, it } from "vitest";
import { CALL_OUTCOMES } from "@/lib/domain/outcomes";
import {
  milestoneFor,
  moodBucket,
  outcomeBucket,
  pickPepLine,
  shouldQuipAfterOutcome,
  type PepBucket,
} from "@/lib/domain/pep-talk";
import { PEP_LINES } from "@/lib/domain/pep-talk-lines";

const MOODS = ["no-target", "not-started", "progress", "behind", "reached"] as const;
const BUCKETS: PepBucket[] = [
  ...CALL_OUTCOMES.map(outcomeBucket),
  ...MOODS.map(moodBucket),
  "milestone:ten",
  "milestone:half",
  "milestone:goal",
];

const CONTEXT = { business: "Kompose Hotel Sarasota", dials: 12 };

describe("the pool", () => {
  it("has no duplicate ids", () => {
    const ids = PEP_LINES.map((line) => line.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every bucket something at the mildest level", () => {
    // Without this an agent on "clean" hits a bucket that silently renders nothing.
    for (const bucket of BUCKETS) {
      const line = pickPepLine({ bucket, setting: "clean", seed: "seed", ...CONTEXT });
      expect(line, `no clean line for ${bucket}`).not.toBeNull();
    }
  });

  it("gives every bucket something when nothing about the lead is known", () => {
    for (const bucket of BUCKETS) {
      const line = pickPepLine({ bucket, setting: "raw", seed: "seed" });
      expect(line, `${bucket} only has lines needing a placeholder`).not.toBeNull();
    }
  });

  it("only uses the placeholders the picker knows how to fill", () => {
    for (const line of PEP_LINES) {
      const placeholders = line.text.match(/\{[a-z]+\}/g) ?? [];
      for (const placeholder of placeholders) expect(["{business}", "{dials}"]).toContain(placeholder);
    }
  });
});

describe("pickPepLine", () => {
  it("returns nothing when the agent turned it off", () => {
    expect(pickPepLine({ bucket: "outcome:NO_ANSWER", setting: "off", seed: "a" })).toBeNull();
  });

  it("never returns a stronger line than the chosen level", () => {
    const byId = new Map(PEP_LINES.map((line) => [line.id, line]));
    for (let index = 0; index < 200; index += 1) {
      const clean = pickPepLine({ bucket: "outcome:NOT_INTERESTED", setting: "clean", seed: `s${index}`, ...CONTEXT });
      expect(byId.get(clean?.id ?? "")?.level).toBe("clean");
      const salty = pickPepLine({ bucket: "outcome:NOT_INTERESTED", setting: "salty", seed: `s${index}`, ...CONTEXT });
      expect(["clean", "salty"]).toContain(byId.get(salty?.id ?? "")?.level);
    }
  });

  it("is stable for one seed and spreads across many", () => {
    const once = pickPepLine({ bucket: "outcome:VOICEMAIL", setting: "raw", seed: "call-1", ...CONTEXT });
    const again = pickPepLine({ bucket: "outcome:VOICEMAIL", setting: "raw", seed: "call-1", ...CONTEXT });
    expect(again).toEqual(once);

    const seen = new Set<string>();
    for (let index = 0; index < 60; index += 1) {
      const line = pickPepLine({ bucket: "outcome:VOICEMAIL", setting: "raw", seed: `call-${index}`, ...CONTEXT });
      if (line) seen.add(line.id);
    }
    expect(seen.size).toBeGreaterThan(2);
  });

  it("fills placeholders and never renders a bare brace", () => {
    for (let index = 0; index < 100; index += 1) {
      for (const bucket of BUCKETS) {
        const line = pickPepLine({ bucket, setting: "raw", seed: `s${index}`, ...CONTEXT });
        expect(line?.text ?? "").not.toMatch(/[{}]/);
      }
    }
  });

  it("drops lines that name the lead when the name is missing", () => {
    const named = PEP_LINES.filter((line) => line.text.includes("{business}")).map((line) => line.id);
    for (let index = 0; index < 100; index += 1) {
      const line = pickPepLine({ bucket: "outcome:NOT_INTERESTED", setting: "raw", seed: `s${index}`, dials: 3 });
      expect(named).not.toContain(line?.id);
    }
  });

  it("skips lines already seen today, then repeats rather than showing nothing", () => {
    const bucket: PepBucket = "outcome:NO_ANSWER";
    const all = PEP_LINES.filter((line) => line.bucket === bucket).map((line) => line.id);
    const exclude = all.slice(0, all.length - 1);
    const line = pickPepLine({ bucket, setting: "raw", seed: "x", exclude, ...CONTEXT });
    expect(line?.id).toBe(all[all.length - 1]);

    const exhausted = pickPepLine({ bucket, setting: "raw", seed: "x", exclude: all, ...CONTEXT });
    expect(all).toContain(exhausted?.id);
  });
});

describe("when a line fires", () => {
  it("always greets the first call of the day", () => {
    expect(shouldQuipAfterOutcome(1, "call-1")).toBe(true);
  });

  it("fires on roughly a third of the calls after that", () => {
    let fired = 0;
    for (let index = 0; index < 600; index += 1) if (shouldQuipAfterOutcome(index + 2, `call-${index}`)) fired += 1;
    expect(fired / 600).toBeGreaterThan(0.2);
    expect(fired / 600).toBeLessThan(0.5);
  });
});

describe("milestoneFor", () => {
  it("marks every tenth call", () => {
    expect(milestoneFor(10, 0)).toBe("ten");
    expect(milestoneFor(30, 50)).toBe("ten");
    expect(milestoneFor(11, 50)).toBeNull();
  });

  it("marks halfway and the target itself, ahead of the tens", () => {
    expect(milestoneFor(25, 50)).toBe("half");
    expect(milestoneFor(50, 50)).toBe("goal");
    expect(milestoneFor(20, 40)).toBe("half");
  });

  it("stays quiet before the first call and without a target", () => {
    expect(milestoneFor(0, 50)).toBeNull();
    expect(milestoneFor(7, 0)).toBeNull();
  });
});
