// Display helpers for report numbers. Pure, shared by the tables and the unit tests.
import { formatDuration } from "@/components/common/datetime";

/** A number is flagged when it has enough dials to judge and answers less often than this. */
export const SPAM_MIN_DIALS = 20;
export const SPAM_MAX_ANSWER_RATE = 0.15;

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Low answer rate over enough dials: carriers may be labeling the number as spam. */
export function isPossibleSpamFlag(dials: number, answerRate: number): boolean {
  return finite(dials) >= SPAM_MIN_DIALS && finite(answerRate) < SPAM_MAX_ANSWER_RATE;
}

/** 0.3749 -> "37%"; rates between 0 and 1% show one decimal ("0.5%"). */
export function formatPercent(rate: number): string {
  const percent = finite(rate) * 100;
  if (percent > 0 && percent < 1) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

/** Talk minutes as shown everywhere: round(talk seconds / 60). */
export function talkMinutes(seconds: number): number {
  return Math.round(Math.max(finite(seconds), 0) / 60);
}

/** Average call length as m:ss (h:mm:ss from one hour). */
export function formatAvgCall(seconds: number): string {
  return formatDuration(Math.round(Math.max(finite(seconds), 0)));
}

export function formatCount(value: number): string {
  return Math.round(finite(value)).toLocaleString("en-US");
}
