export { formatTalkTime } from "@/components/common/format";

/** 0.4567 -> "46%". */
export function formatPercent(ratio: number): string {
  return `${Math.round((Number.isFinite(ratio) ? Math.max(0, ratio) : 0) * 100)}%`;
}

export function formatCount(value: number): string {
  return (Number.isFinite(value) ? value : 0).toLocaleString("en-US");
}
