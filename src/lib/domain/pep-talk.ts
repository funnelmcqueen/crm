// Picking a pep-talk line (docs/DEVIATIONS.md D49). Pure: no storage, no randomness of its own.
//
// Every choice is derived from a caller-supplied seed, so the same call or the same day yields the
// same line. That keeps a server render and its hydration in agreement, makes "did it fire?" a unit
// test instead of a coin flip, and stops a line changing under the agent when React re-renders.
import type { GoalMood } from "./daily-goal";
import type { CallOutcome } from "./outcomes";
import { PEP_LINES, type PepLine } from "./pep-talk-lines";

export const PEP_LEVELS = ["clean", "salty", "raw"] as const;
export type PepLevel = (typeof PEP_LEVELS)[number];

/** What an agent chooses in Settings. "off" shows nothing at all. */
export type PepSetting = PepLevel | "off";
export const PEP_SETTINGS: readonly PepSetting[] = ["raw", "salty", "clean", "off"];

export const PEP_SETTING_LABELS: Readonly<Record<PepSetting, string>> = {
  raw: "No filter",
  salty: "Mild",
  clean: "Clean",
  off: "Off",
};

export const PEP_SETTING_HINTS: Readonly<Record<PepSetting, string>> = {
  raw: "Sales floor language, swearing included.",
  salty: "Blunt, the odd mild swear.",
  clean: "Dry and dark, nothing you'd mind being read over your shoulder.",
  off: "No lines anywhere.",
};

export type MilestoneKind = "ten" | "half" | "goal";

export type PepBucket = `outcome:${CallOutcome}` | `mood:${GoalMood}` | `milestone:${MilestoneKind}`;

const LEVEL_RANK: Readonly<Record<PepLevel, number>> = { clean: 0, salty: 1, raw: 2 };

/** FNV-1a. Small, stable across runtimes, and good enough to scatter sequential seeds. */
function hash(seed: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

export interface PepContext {
  /** The lead's business name, for lines that use `{business}`. */
  business?: string | null;
  /** Calls made today, for lines that use `{dials}`. */
  dials?: number | null;
}

function fill(text: string, context: PepContext): string | null {
  let filled = text;
  if (filled.includes("{business}")) {
    const business = context.business?.trim();
    if (!business) return null;
    filled = filled.split("{business}").join(business);
  }
  if (filled.includes("{dials}")) {
    const dials = context.dials;
    if (typeof dials !== "number" || !Number.isFinite(dials)) return null;
    filled = filled.split("{dials}").join(dials.toLocaleString("en-US"));
  }
  return filled;
}

export interface PickPepLineInput extends PepContext {
  bucket: PepBucket;
  setting: PepSetting;
  /** Anything stable for this moment: a call id, or the date plus the mood. */
  seed: string;
  /** Line ids already shown recently; skipped unless that would leave nothing. */
  exclude?: readonly string[];
}

export interface PickedPepLine {
  id: string;
  text: string;
}

/**
 * The line for this moment, or null when the agent turned pep talk off, the bucket has nothing at
 * their level, or every candidate needs a value this moment doesn't have.
 */
export function pickPepLine(input: PickPepLineInput): PickedPepLine | null {
  if (input.setting === "off") return null;
  const ceiling = LEVEL_RANK[input.setting];

  const candidates: Array<{ line: PepLine; text: string }> = [];
  for (const line of PEP_LINES) {
    if (line.bucket !== input.bucket || LEVEL_RANK[line.level] > ceiling) continue;
    const text = fill(line.text, input);
    if (text !== null) candidates.push({ line, text });
  }
  if (candidates.length === 0) return null;

  const exclude = new Set(input.exclude ?? []);
  // Falling back to the full set matters: an agent who outlasts the pool should see a repeat rather
  // than a blank space where the joke was.
  const fresh = candidates.filter((candidate) => !exclude.has(candidate.line.id));
  const pool = fresh.length > 0 ? fresh : candidates;
  const chosen = pool[hash(input.seed) % pool.length];
  return { id: chosen.line.id, text: chosen.text };
}

/**
 * Whether a logged outcome gets a line: the first call of the day always does, then roughly one in
 * three. Unpredictable enough to keep landing, rare enough that nobody starts skimming past it.
 */
export function shouldQuipAfterOutcome(dialsToday: number, seed: string): boolean {
  if (dialsToday <= 1) return true;
  return hash(`quip:${seed}`) % 3 === 0;
}

/**
 * The milestone this call just crossed, if any. Milestones outrank the outcome line, so the tenth
 * call of the day is celebrated rather than commiserated.
 */
export function milestoneFor(dialsToday: number, target: number): MilestoneKind | null {
  if (!Number.isFinite(dialsToday) || dialsToday <= 0) return null;
  if (target > 0 && dialsToday === target) return "goal";
  if (target > 0 && dialsToday === Math.ceil(target / 2)) return "half";
  return dialsToday > 0 && dialsToday % 10 === 0 ? "ten" : null;
}

export function outcomeBucket(outcome: CallOutcome): PepBucket {
  return `outcome:${outcome}`;
}

export function moodBucket(mood: GoalMood): PepBucket {
  return `mood:${mood}`;
}
