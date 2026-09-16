// Daily call goal, pace copy and the Today "next best action" (docs/DEVIATIONS.md D43).
//
// profiles.daily_call_target is the single stored source of a target. Every screen that shows calls against a
// target (agent Today, admin dashboard rows, Agents list) derives what it shows from dailyGoal(), so "remaining",
// "reached" and the progress bar can never disagree, including for a target of 0 ("no target").
// Pure functions: the copy is unit tested and never shames, ranks or compares agents.

export interface DailyGoal {
  dials: number;
  /** The stored target, never negative. */
  target: number;
  /** False when the target is 0: there is nothing to reach, so nothing is "remaining" or "reached". */
  hasTarget: boolean;
  remaining: number;
  /** 0..100, rounded; 100 once reached. */
  percent: number;
  reached: boolean;
  /** Calls beyond the target (0 until reached). */
  over: number;
}

function whole(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function dailyGoal(dials: number, target: number): DailyGoal {
  const d = whole(dials);
  const t = whole(target);
  if (t === 0) return { dials: d, target: 0, hasTarget: false, remaining: 0, percent: 0, reached: false, over: 0 };
  const reached = d >= t;
  return {
    dials: d,
    target: t,
    hasTarget: true,
    remaining: reached ? 0 : t - d,
    percent: reached ? 100 : Math.min(99, Math.round((d / t) * 100)),
    reached,
    over: reached ? d - t : 0,
  };
}

/** "37 / 50" or "37 calls" when there is no target. */
export function goalFraction(goal: DailyGoal): string {
  return goal.hasTarget
    ? `${goal.dials.toLocaleString("en-US")} / ${goal.target.toLocaleString("en-US")}`
    : `${goal.dials.toLocaleString("en-US")} ${goal.dials === 1 ? "call" : "calls"}`;
}

// ---------------------------------------------------------------------------------------------
// Pace and supportive copy
// ---------------------------------------------------------------------------------------------

/**
 * The calling day pace is measured against. An assumption, not a setting: 9:00 to 17:00 in the agent's own
 * timezone. Before 9:00 nobody is behind; after 17:00 the copy stops talking about pace.
 */
export const PACE_DAY = { startMinute: 9 * 60, endMinute: 17 * 60 } as const;

export type GoalMood = "no-target" | "not-started" | "progress" | "behind" | "reached";

export interface GoalCopy {
  mood: GoalMood;
  title: string;
  body: string;
}

function calls(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "call" : "calls"}`;
}

/** The calls expected by `minuteOfDay` if the target were spread evenly over the pace day. */
export function expectedByNow(target: number, minuteOfDay: number): number {
  const span = PACE_DAY.endMinute - PACE_DAY.startMinute;
  const elapsed = Math.min(Math.max(minuteOfDay - PACE_DAY.startMinute, 0), span);
  return (target * elapsed) / span;
}

/**
 * Behind pace only in the second half of the pace day, and only when clearly short (under 60% of the even
 * pace), so a slow morning or a long call never reads as failing.
 */
export function isBehindPace(goal: DailyGoal, minuteOfDay: number): boolean {
  if (!goal.hasTarget || goal.reached) return false;
  const midday = (PACE_DAY.startMinute + PACE_DAY.endMinute) / 2;
  if (minuteOfDay < midday || minuteOfDay >= PACE_DAY.endMinute) return false;
  return goal.dials < expectedByNow(goal.target, minuteOfDay) * 0.6;
}

export function goalCopy(goal: DailyGoal, minuteOfDay: number): GoalCopy {
  if (!goal.hasTarget) {
    return goal.dials === 0
      ? { mood: "no-target", title: "No daily target set", body: "Your admin sets targets. Every call you make still counts toward your day." }
      : { mood: "no-target", title: `${calls(goal.dials)} today`, body: "No daily target is set, so every call is progress." };
  }
  if (goal.reached) {
    return {
      mood: "reached",
      title: "Goal reached",
      body:
        goal.over > 0
          ? `${calls(goal.dials)} today, ${goal.over.toLocaleString("en-US")} past your goal. Anything more is a bonus.`
          : `${calls(goal.dials)} today. Anything more is a bonus.`,
    };
  }
  if (isBehindPace(goal, minuteOfDay)) {
    const hoursLeft = (PACE_DAY.endMinute - minuteOfDay) / 60;
    const perHour = Math.ceil(goal.remaining / Math.max(hoursLeft, 0.5));
    return {
      mood: "behind",
      title: "A focused block will close the gap",
      body: `${calls(goal.remaining)} to go. About ${perHour.toLocaleString("en-US")} an hour gets you there by 5pm.`,
    };
  }
  if (goal.dials === 0) {
    return {
      mood: "not-started",
      title: "Ready when you are",
      body: `Your goal today is ${calls(goal.target)}. The first one sets the pace.`,
    };
  }
  return {
    mood: "progress",
    title: "Making progress",
    body: `${calls(goal.dials)} done, ${goal.remaining.toLocaleString("en-US")} to go.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Next best action
// ---------------------------------------------------------------------------------------------

export type NextActionKind =
  | "start-calling"
  | "continue-calling"
  | "overdue-follow-ups"
  | "review-skipped"
  | "no-leads"
  | "caught-up";

export interface NextActionInput {
  hasNextLead: boolean;
  dialsToday: number;
  overdueFollowUps: number;
  skipped: number;
  leadsAssigned: number;
}

export interface NextAction {
  kind: NextActionKind;
  title: string;
  description: string;
  href: string | null;
  cta: string | null;
}

/**
 * One clear next step, in this order: call the queue (which already puts voicemails and due follow-ups first),
 * then overdue follow-ups the queue cannot offer (on skipped or recently called leads), then the Skipped queue,
 * then the empty states.
 */
export function nextBestAction(input: NextActionInput): NextAction {
  if (input.hasNextLead) {
    return input.dialsToday > 0
      ? { kind: "continue-calling", title: "Continue your call queue", description: "Your next lead is ready.", href: "/next", cta: "Next lead" }
      : { kind: "start-calling", title: "Start calling", description: "Your first lead is ready.", href: "/next", cta: "Start calling" };
  }
  if (input.overdueFollowUps > 0) {
    return {
      kind: "overdue-follow-ups",
      title: "Complete overdue follow-ups",
      description: `${input.overdueFollowUps.toLocaleString("en-US")} ${input.overdueFollowUps === 1 ? "follow-up is" : "follow-ups are"} past due. Call back, reschedule or complete ${input.overdueFollowUps === 1 ? "it" : "them"}.`,
      href: "/follow-ups?tab=overdue",
      cta: "Open overdue",
    };
  }
  if (input.skipped > 0) {
    return {
      kind: "review-skipped",
      title: "Review skipped leads",
      description: `${input.skipped.toLocaleString("en-US")} skipped ${input.skipped === 1 ? "lead is" : "leads are"} waiting. Resume, reschedule or close ${input.skipped === 1 ? "it" : "them"}.`,
      href: "/follow-ups?tab=skipped",
      cta: "Review skipped",
    };
  }
  if (input.leadsAssigned === 0) {
    return {
      kind: "no-leads",
      title: "No leads assigned yet",
      description: "Your admin assigns leads. Once they do, your call queue starts here.",
      href: null,
      cta: null,
    };
  }
  return {
    kind: "caught-up",
    title: "You're all caught up",
    description: "No lead needs a call right now. Leads called in the last 4 hours come back later.",
    href: "/leads",
    cta: "Browse my leads",
  };
}

// ---------------------------------------------------------------------------------------------
// Consistency
// ---------------------------------------------------------------------------------------------

export interface CallDay {
  /** Local calendar date, YYYY-MM-DD. */
  day: string;
  dials: number;
}

export interface Consistency {
  activeDays: number;
  totalDays: number;
}

/** "Called on 4 of the last 7 days". Days, not a streak, so a weekend or day off never resets anything. */
export function consistency(days: readonly CallDay[]): Consistency {
  return { activeDays: days.filter((day) => day.dials > 0).length, totalDays: days.length };
}
