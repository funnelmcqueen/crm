"use client";

import { useEffect, useSyncExternalStore } from "react";
import { moodBucket, pickPepLine, type PepSetting } from "@/lib/domain/pep-talk";
import type { GoalMood } from "@/lib/domain/daily-goal";
import { localDate, rememberPepTarget, usePepSetting } from "@/lib/pep/storage";

export interface PepLineProps {
  mood: GoalMood;
  dials: number;
  /** The agent's daily target, stashed for the outcome toast to spot milestones with. */
  target: number;
}

const noSubscribe = () => () => {};

/** False while rendering on the server and through hydration, true afterwards. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
}

function choose(mood: GoalMood, dials: number, setting: PepSetting, date: string): string | null {
  // Seeded by day and mood only: the line holds still all morning instead of changing on every
  // re-render, and it turns over when the agent's day moves on to the next mood.
  return pickPepLine({ bucket: moodBucket(mood), setting, dials, seed: `${date}:${mood}` })?.text ?? null;
}

/**
 * The dashboard's line under the goal (docs/DEVIATIONS.md D45). Renders nothing until hydration:
 * the setting lives in this device's storage, so a server render would flash a line at an agent who
 * muted it, and would disagree with the client besides.
 */
export function PepLine({ mood, dials, target }: PepLineProps) {
  const [setting] = usePepSetting();
  const hydrated = useHydrated();

  useEffect(() => {
    rememberPepTarget(localDate(), target);
  }, [target]);

  const text = hydrated ? choose(mood, dials, setting, localDate()) : null;
  if (!text) return null;
  return (
    <p className="mt-3 border-t pt-3 text-sm text-muted-foreground italic" data-testid="pep-line">
      {text}
    </p>
  );
}
